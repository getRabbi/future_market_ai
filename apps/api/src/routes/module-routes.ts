import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { customers, knowledge } from '@futuregrow/core';
import { dsarRequests, ingestionKeys } from '@futuregrow/db';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';
import { registerChannelRoutes } from './channel-routes.js';
import { registerIntelligenceRoutes } from './intelligence-routes.js';
import { registerStudioRoutes } from './studio-routes.js';

const Id = z.object({ id: z.string().uuid() });
const Body = z.record(z.string(), z.unknown());

/** Routes for modules M02–M22 (authenticated, tenant-scoped). */
export function registerModuleRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;

  /* ---------------- M02 Customer 360 ---------------- */
  r.get('/v1/customers', { schema: { tags: ['customers'], querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => customers.listProfiles(tx, req.query.limit)),
  );
  r.get('/v1/customers/:id', { schema: { tags: ['customers'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => customers.getProfile360(tx, req.params.id)));
  r.post('/v1/customers/events', { schema: { tags: ['customers'], body: z.object({ events: z.array(z.unknown()).min(1).max(500) }) } }, async (req) =>
    customers.ingestEvents(deps, tenantOf(req), `api:${actorOf(req).id}`, req.body.events),
  );
  r.post('/v1/customers/consents', { schema: { tags: ['customers'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => customers.recordConsent(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post(
    '/v1/customers/suppressions',
    {
      schema: {
        tags: ['customers'],
        body: z.object({
          channel: z.enum(['email', 'sms', 'push', 'whatsapp', 'ads', 'all']),
          identifier: z.object({ kind: z.enum(['email', 'phone']), value: z.string().min(3) }),
          reason: z.enum(['unsubscribe', 'bounce', 'complaint', 'manual', 'legal']),
        }),
      },
    },
    async (req, reply) => {
      await tenantTx(ctx, req, (tx) => customers.addSuppression(tx, deps, tenantOf(req), actorOf(req), { ...req.body, source: `user:${actorOf(req).id}` }));
      return reply.status(201).send({ ok: true });
    },
  );
  r.get('/v1/customers/ingestion-keys', { schema: { tags: ['customers'] } }, async (req) =>
    tenantTx(ctx, req, (tx) =>
      tx
        .select({ id: ingestionKeys.id, kind: ingestionKeys.kind, keyPrefix: ingestionKeys.keyPrefix, allowedOrigins: ingestionKeys.allowedOrigins, status: ingestionKeys.status, createdAt: ingestionKeys.createdAt })
        .from(ingestionKeys)
        .orderBy(desc(ingestionKeys.createdAt)),
    ),
  );
  r.post(
    '/v1/customers/ingestion-keys',
    { schema: { tags: ['customers'], body: z.object({ kind: z.enum(['server', 'browser']), allowedOrigins: z.array(z.string().url()).default([]) }) } },
    async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => customers.createIngestionKey(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/customers/ingestion-keys/:id/revoke', { schema: { tags: ['customers'], params: Id } }, async (req) => {
    await tenantTx(ctx, req, (tx) => customers.revokeIngestionKey(tx, tenantOf(req), actorOf(req), req.params.id));
    return { ok: true };
  });
  r.get('/v1/customers/dsar', { schema: { tags: ['customers'] } }, async (req) =>
    tenantTx(ctx, req, (tx) => tx.select().from(dsarRequests).orderBy(desc(dsarRequests.receivedAt)).limit(200)),
  );
  r.post('/v1/customers/dsar', { schema: { tags: ['customers'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => customers.createDsar(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/customers/dsar/:id/verify', { schema: { tags: ['customers'], params: Id, body: z.object({ method: z.string().min(3) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => customers.verifyDsarIdentity(tx, tenantOf(req), actorOf(req), req.params.id, req.body.method)),
  );
  r.post('/v1/customers/dsar/:id/execute-deletion', { schema: { tags: ['customers'], params: Id } }, async (req) =>
    customers.executeDsarDeletion(deps, tenantOf(req), actorOf(req), req.params.id),
  );
  r.post('/v1/customers/dsar/:id/execute-opt-out', { schema: { tags: ['customers'], params: Id } }, async (req) =>
    customers.executeDsarOptOut(deps, tenantOf(req), actorOf(req), req.params.id),
  );

  /* ---------------- M03 Knowledge ---------------- */
  r.get('/v1/knowledge/facts', { schema: { tags: ['knowledge'], querystring: z.object({ kinds: z.string().optional() }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => knowledge.activeFacts(tx, req.query.kinds?.split(','))),
  );
  r.post('/v1/knowledge/facts', { schema: { tags: ['knowledge'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => knowledge.upsertEntity(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/knowledge/facts/:id/resolve-conflict', { schema: { tags: ['knowledge'], params: Id } }, async (req) =>
    tenantTx(ctx, req, (tx) => knowledge.resolveConflict(tx, tenantOf(req), actorOf(req), req.params.id)),
  );
  r.get('/v1/knowledge/claims', { schema: { tags: ['knowledge'], querystring: z.object({ status: z.string().optional() }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => knowledge.listClaims(tx, req.query.status)),
  );
  r.post('/v1/knowledge/claims', { schema: { tags: ['knowledge'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => knowledge.proposeClaim(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/knowledge/claims/:id/review', { schema: { tags: ['knowledge'], params: Id, body: z.object({ decision: z.enum(['approved', 'rejected']) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => knowledge.reviewClaim(tx, tenantOf(req), actorOf(req), req.params.id, req.body.decision)),
  );
  r.post('/v1/knowledge/brand-rules', { schema: { tags: ['knowledge'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => knowledge.addBrandRule(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post(
    '/v1/knowledge/lint',
    { schema: { tags: ['knowledge'], body: z.object({ text: z.string().min(1).max(20000), claimIds: z.array(z.string().uuid()).default([]), channel: z.string().optional(), requiredDisclosure: z.string().nullable().optional() }) } },
    async (req) =>
      tenantTx(ctx, req, (tx) =>
        knowledge.lintCopy(tx, req.body.text, { claimIds: req.body.claimIds, ...(req.body.channel ? { channel: req.body.channel } : {}), requiredDisclosure: req.body.requiredDisclosure ?? null, now: deps.clock.now() }),
      ),
  );
  r.post('/v1/knowledge/documents', { schema: { tags: ['knowledge'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => knowledge.ingestDocument(tx, deps, tenantOf(req), actorOf(req), req.body, ctx.embedder))),
  );
  r.get('/v1/knowledge/search', { schema: { tags: ['knowledge'], querystring: z.object({ q: z.string().min(1).max(500), limit: z.coerce.number().int().min(1).max(50).default(8) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => knowledge.searchKnowledge(tx, { query: req.query.q, limit: req.query.limit, roles: actorOf(req).roles, audience: 'internal', ...(ctx.embedder ? { embedder: ctx.embedder } : {}) })),
  );

  registerIntelligenceRoutes(app, ctx);
  registerStudioRoutes(app, ctx);
  registerChannelRoutes(app, ctx);
}
