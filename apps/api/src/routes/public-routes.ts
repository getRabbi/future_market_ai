import { customers, experimentsModule } from '@futuregrow/core';
import { ingestionKeys, withSystem, withTenant } from '@futuregrow/db';
import { FgError, sha256Hex } from '@futuregrow/observability';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiContext } from '../http.js';
import { registerPublicChannelRoutes } from './public-channel-routes.js';

export async function resolveIngestionKey(ctx: ApiContext, req: FastifyRequest): Promise<{ tenantId: string; keyId: string }> {
  const auth = req.headers.authorization;
  const writeKey = req.headers['x-fg-write-key'];
  const raw = typeof auth === 'string' && auth.startsWith('Bearer fgk_sk_') ? auth.slice(7) : typeof writeKey === 'string' ? writeKey : null;
  if (!raw) throw new FgError('UNAUTHENTICATED', 'ingestion key required', 401);
  const [key] = await withSystem(ctx.deps.db, 'system:ingest', (tx) =>
    tx
      .select()
      .from(ingestionKeys)
      .where(and(eq(ingestionKeys.keyHash, sha256Hex(raw)), eq(ingestionKeys.status, 'active'))),
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

  /* Experiment SDK (server keys only): assignment -> exposure -> outcome, ordered by server time. */
  const serverKey = async (req: FastifyRequest) => {
    const k = await resolveIngestionKey(ctx, req);
    if (!(req.headers.authorization ?? '').startsWith('Bearer fgk_sk_')) throw new FgError('FORBIDDEN', 'experiment endpoints require a server key', 403);
    return k;
  };
  const expBody = (req: FastifyRequest) => {
    const b = (req.body ?? {}) as { unitId?: unknown; country?: unknown; locale?: unknown; metric?: unknown; value?: unknown };
    if (typeof b.unitId !== 'string' || b.unitId.length < 1 || b.unitId.length > 200) throw new FgError('INVALID', 'unitId required', 422);
    return b;
  };
  const expId = (req: FastifyRequest) => {
    const id = (req.params as { id?: string }).id ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FgError('INVALID', 'invalid experiment id', 422);
    return id;
  };
  app.post('/ingest/v1/experiments/:id/assign', { config: { public: true } }, async (req) => {
    const { tenantId } = await serverKey(req);
    const b = expBody(req);
    return withTenant(ctx.deps.db, { tenantId, actor: 'sdk:experiments' }, (tx) => experimentsModule.assign(tx, expId(req), b.unitId as string, { ...(typeof b.country === 'string' ? { country: b.country } : {}), ...(typeof b.locale === 'string' ? { locale: b.locale } : {}) }));
  });
  app.post('/ingest/v1/experiments/:id/exposures', { config: { public: true } }, async (req, reply) => {
    const { tenantId } = await serverKey(req);
    const b = expBody(req);
    await withTenant(ctx.deps.db, { tenantId, actor: 'sdk:experiments' }, (tx) => experimentsModule.logExposure(tx, expId(req), b.unitId as string));
    return reply.status(202).send({ ok: true });
  });
  app.post('/ingest/v1/experiments/:id/outcomes', { config: { public: true } }, async (req, reply) => {
    const { tenantId } = await serverKey(req);
    const b = expBody(req);
    if (typeof b.metric !== 'string' || typeof b.value !== 'number' || !Number.isFinite(b.value)) throw new FgError('INVALID', 'metric and numeric value required', 422);
    await withTenant(ctx.deps.db, { tenantId, actor: 'sdk:experiments' }, (tx) => experimentsModule.logOutcome(tx, expId(req), b.unitId as string, b.metric as string, b.value as number));
    return reply.status(202).send({ ok: true });
  });

  registerPublicChannelRoutes(app, ctx);
}
