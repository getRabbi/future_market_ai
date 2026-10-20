import { appGrowth, conversationsModule, creatorsModule, lifecycle } from '@futuregrow/core';
import { FgError } from '@futuregrow/observability';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiContext } from '../http.js';
import { resolveIngestionKey } from './public-routes.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1b1b1b}button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #1b1b1b;background:#1b1b1b;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`;
}

const WIDGET_KEY = /^fgw_pk_[A-Za-z0-9_-]{16,64}$/;

function widgetKey(req: FastifyRequest): string {
  const k = (req.params as { key?: string }).key ?? '';
  if (!WIDGET_KEY.test(k)) throw new FgError('NOT_FOUND', 'unknown widget', 404);
  return k;
}

function visitorToken(req: FastifyRequest): string {
  const t = req.headers['x-fg-visitor-token'];
  if (typeof t !== 'string' || t.length < 16 || t.length > 200) throw new FgError('UNAUTHENTICATED', 'visitor token required', 401);
  return t;
}

function convId(req: FastifyRequest): string {
  const id = (req.params as { id?: string }).id ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FgError('INVALID', 'invalid conversation id', 422);
  return id;
}

/** Public channel endpoints: unsubscribe, referral redirects, chat widget, app install referrer. */
export function registerPublicChannelRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { deps } = ctx;

  /* ---------- M20: unsubscribe (GET shows a confirmation; POST is RFC 8058 one-click) ---------- */
  app.get('/u/:token', { config: { public: true, rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const ok = lifecycle.parseUnsubscribeToken(deps.config.identifierPepper, token) !== null;
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    if (!ok) return reply.status(404).send(page('Link not valid', '<h1>This link is not valid</h1><p>It may have been copied incompletely.</p>'));
    // Link scanners prefetch GET; the change itself needs the POST below (a single click).
    return page('Unsubscribe', `<h1>Unsubscribe from marketing email?</h1><form method="post" action="/u/${esc(token)}"><input type="hidden" name="confirm" value="1"><button type="submit">Unsubscribe</button></form>`);
  });
  app.post('/u/:token', { config: { public: true, rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const res = await lifecycle.processUnsubscribe(deps, token);
    reply.header('cache-control', 'no-store');
    const oneClick = (req.body as Record<string, string> | null)?.['List-Unsubscribe'] === 'One-Click';
    if (!res.ok) return reply.status(404).type('text/html; charset=utf-8').send(page('Link not valid', '<h1>This link is not valid</h1>'));
    if (oneClick) return reply.status(200).send({ ok: true });
    return reply.type('text/html; charset=utf-8').send(page('Unsubscribed', '<h1>You are unsubscribed</h1><p>You will no longer receive marketing email from us. Transactional messages about your account or orders may still be sent.</p>'));
  });

  /* ---------- M22: referral redirect ---------- */
  app.get('/r/:code', { config: { public: true, rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const code = (req.params as { code: string }).code.toUpperCase();
    const dest = await creatorsModule.trackClick(deps, code, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
    if (!dest) return reply.status(404).type('text/html; charset=utf-8').send(page('Not found', '<h1>Link not found</h1>'));
    return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(dest, 302);
  });

  /* ---------- M19: app installs (server keys only: the mobile backend relays referrer data) ---------- */
  app.post('/ingest/v1/app-installs', { config: { public: true, rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { tenantId, keyId } = await resolveIngestionKey(ctx, req);
    if (!(req.headers.authorization ?? '').startsWith('Bearer fgk_sk_')) throw new FgError('FORBIDDEN', 'install ingestion requires a server key', 403);
    return reply.status(202).send(await appGrowth.recordInstall(deps, tenantId, `key:${keyId}`, req.body));
  });

  /* ---------- M21: chat widget (CORS is resolved per widget key in app.ts) ---------- */
  app.post('/chat/v1/w/:key/conversations', { config: { public: true, rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => reply.status(201).send(await conversationsModule.startConversation(deps, widgetKey(req), req.headers.origin)));
  app.post('/chat/v1/w/:key/conversations/:id/messages', { config: { public: true, rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const text = (req.body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') throw new FgError('INVALID', 'text required', 422);
    return conversationsModule.postCustomerMessage(deps, {
      publicKey: widgetKey(req),
      origin: req.headers.origin,
      conversationId: convId(req),
      visitorToken: visitorToken(req),
      text,
      ...(ctx.embedder ? { embedder: ctx.embedder } : {}),
    });
  });
  app.get('/chat/v1/w/:key/conversations/:id/messages', { config: { public: true, rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => conversationsModule.visitorMessages(deps, { publicKey: widgetKey(req), origin: req.headers.origin, conversationId: convId(req), visitorToken: visitorToken(req) }));
}
