import { verifyMetaSignature, verifyShopifyHmac, verifySvixSignature, verifyTikTokSignature } from '@futuregrow/connectors';
import { webhooks } from '@futuregrow/core';
import { safeEqual } from '@futuregrow/observability';
import type { Env } from '@futuregrow/runtime';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiContext } from '../http.js';

function headerMap(req: FastifyRequest): Record<string, string> {
  return Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]));
}

const h = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

/**
 * Inbound provider webhooks (public routes). Each provider's signature is verified over the exact
 * raw body. If the signing secret is not configured the endpoint refuses deliveries (503) rather
 * than accepting unauthenticated data.
 */
export function registerWebhookRoutes(app: FastifyInstance, ctx: ApiContext, env: Env): void {
  const accept = async (req: FastifyRequest, input: Omit<webhooks.InboxInput, 'headers' | 'rawBody' | 'payload'>) => {
    const stored = await webhooks.ingestWebhook(ctx.deps.db, { ...input, headers: headerMap(req), rawBody: req.rawBody ?? '', payload: req.body ?? null });
    if (!stored.duplicate && input.signatureValid) {
      // If enqueueing fails, the inbox sweep picks the delivery up later.
      await ctx.deps.jobs.add('process_webhook', { inboxId: stored.id }, { jobKey: `webhook:${stored.id}` }).catch(() => undefined);
    }
    return stored;
  };

  app.get('/webhooks/meta', { config: { public: true } }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    const token = env.META_WEBHOOK_VERIFY_TOKEN;
    if (!token) return reply.status(503).send({ error: { code: 'NOT_CONFIGURED', message: 'META_WEBHOOK_VERIFY_TOKEN not set' } });
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && safeEqual(q['hub.verify_token'], token)) return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'verification failed' } });
  });

  app.post('/webhooks/meta', { config: { public: true } }, async (req, reply) => {
    if (!env.META_APP_SECRET) return reply.status(503).send({ error: { code: 'NOT_CONFIGURED', message: 'META_APP_SECRET not set (B-005)' } });
    const valid = verifyMetaSignature(req.rawBody ?? '', h(req, 'x-hub-signature-256'), env.META_APP_SECRET);
    const body = req.body as { object?: string; entry?: { id?: string }[] } | null;
    const stored = await accept(req, { provider: 'meta', providerEventId: null, topic: body?.object ?? null, signatureValid: valid, accountRef: body?.entry?.[0]?.id ?? null });
    return reply.status(valid ? 200 : 401).send({ received: valid, duplicate: stored.duplicate });
  });

  app.post('/webhooks/shopify', { config: { public: true } }, async (req, reply) => {
    if (!env.SHOPIFY_WEBHOOK_SECRET) return reply.status(503).send({ error: { code: 'NOT_CONFIGURED', message: 'SHOPIFY_WEBHOOK_SECRET not set (B-009)' } });
    const valid = verifyShopifyHmac(req.rawBody ?? '', h(req, 'x-shopify-hmac-sha256'), env.SHOPIFY_WEBHOOK_SECRET);
    const stored = await accept(req, {
      provider: 'shopify',
      providerEventId: h(req, 'x-shopify-webhook-id') ?? h(req, 'x-shopify-event-id') ?? null,
      topic: h(req, 'x-shopify-topic') ?? null,
      signatureValid: valid,
      accountRef: h(req, 'x-shopify-shop-domain') ?? null,
    });
    return reply.status(valid ? 200 : 401).send({ received: valid, duplicate: stored.duplicate });
  });

  app.post('/webhooks/resend', { config: { public: true } }, async (req, reply) => {
    if (!env.RESEND_WEBHOOK_SECRET) return reply.status(503).send({ error: { code: 'NOT_CONFIGURED', message: 'RESEND_WEBHOOK_SECRET not set (B-008)' } });
    const valid = verifySvixSignature(req.rawBody ?? '', { id: h(req, 'svix-id'), timestamp: h(req, 'svix-timestamp'), signature: h(req, 'svix-signature') }, env.RESEND_WEBHOOK_SECRET);
    const body = req.body as { type?: string } | null;
    const stored = await accept(req, { provider: 'resend', providerEventId: h(req, 'svix-id') ?? null, topic: body?.type ?? null, signatureValid: valid, accountRef: null });
    return reply.status(valid ? 200 : 401).send({ received: valid, duplicate: stored.duplicate });
  });

  app.post('/webhooks/tiktok', { config: { public: true } }, async (req, reply) => {
    if (!env.TIKTOK_CLIENT_SECRET) return reply.status(503).send({ error: { code: 'NOT_CONFIGURED', message: 'TIKTOK_CLIENT_SECRET not set (B-006)' } });
    const valid = verifyTikTokSignature(req.rawBody ?? '', h(req, 'tiktok-signature'), env.TIKTOK_CLIENT_SECRET);
    const body = req.body as { event?: string; user_openid?: string } | null;
    const stored = await accept(req, { provider: 'tiktok', providerEventId: null, topic: body?.event ?? null, signatureValid: valid, accountRef: body?.user_openid ?? null });
    return reply.status(valid ? 200 : 401).send({ received: valid, duplicate: stored.duplicate });
  });
}
