import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { customers } from '@futuregrow/core';
import { ingestionKeys, withSystem } from '@futuregrow/db';
import { FgError, sha256Hex } from '@futuregrow/observability';
import type { ApiContext } from '../http.js';
import { registerPublicChannelRoutes } from './public-channel-routes.js';

async function resolveIngestionKey(ctx: ApiContext, req: FastifyRequest): Promise<{ tenantId: string; keyId: string }> {
  const auth = req.headers.authorization;
  const writeKey = req.headers['x-fg-write-key'];
  const raw = typeof auth === 'string' && auth.startsWith('Bearer fgk_sk_') ? auth.slice(7) : typeof writeKey === 'string' ? writeKey : null;
  if (!raw) throw new FgError('UNAUTHENTICATED', 'ingestion key required', 401);
  const [key] = await withSystem(ctx.deps.db, 'system:ingest', (tx) =>
    tx.select().from(ingestionKeys).where(and(eq(ingestionKeys.keyHash, sha256Hex(raw)), eq(ingestionKeys.status, 'active'))),
  );
  if (!key) throw new FgError('UNAUTHENTICATED', 'invalid ingestion key', 401);
  if (key.kind === 'browser') {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !key.allowedOrigins.includes(origin)) throw new FgError('FORBIDDEN', 'origin not allowed for this key', 403);
  } else if (!raw.startsWith('fgk_sk_')) {
    throw new FgError('UNAUTHENTICATED', 'server keys must be sent as a Bearer token', 401);
  }
  return { tenantId: key.tenantId, keyId: key.id };
}

/** Unauthenticated endpoints (event SDK ingestion, unsubscribe, referral redirects, chat widget). */
export function registerPublicRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.post('/ingest/v1/events', { config: { public: true, rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { tenantId, keyId } = await resolveIngestionKey(ctx, req);
    const body = req.body as { events?: unknown[] } | null;
    if (!body || !Array.isArray(body.events) || body.events.length === 0) throw new FgError('INVALID', 'body must be { events: [...] }', 422);
    // Browser keys cannot assert verified identities; server keys may (verified e-mail at signup).
    const result = await customers.ingestEvents(ctx.deps, tenantId, `key:${keyId}`, body.events);
    return reply.status(202).send(result);
  });
  registerPublicChannelRoutes(app, ctx);
}
