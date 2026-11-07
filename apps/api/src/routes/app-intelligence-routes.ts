import { appIntelligence } from '@futuregrow/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });
const Body = z.record(z.string(), z.unknown());
const Range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  granularity: z.enum(['day', 'week', 'month']).optional(),
  platform: z.enum(['android', 'ios']).optional(),
  accountId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  window: z.enum(['calendar', 'reported']).optional(),
});

/**
 * App intelligence (M19, D-045): developer accounts, discovered apps and official store reports.
 * Credentials are accepted only on connect and never returned; provider calls happen server-side
 * (connect probes, queued syncs). All reads are tenant-scoped through RLS.
 */
export function registerAppIntelligenceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;

  r.get('/v1/app-intelligence/accounts', { schema: { tags: ['app'] } }, async (req) => tenantTx(ctx, req, (t) => appIntelligence.developerAccountsOverview(t)));
  r.post('/v1/app-intelligence/accounts', { schema: { tags: ['app'], body: Body }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => reply.status(201).send(await appIntelligence.connectStoreAccount(deps, tenantOf(req), actorOf(req), req.body)));
  r.patch('/v1/app-intelligence/accounts/:id', { schema: { tags: ['app'], params: Id, body: Body } }, async (req) => appIntelligence.updateStoreAccount(deps, tenantOf(req), actorOf(req), req.params.id, req.body));
  r.post('/v1/app-intelligence/accounts/:id/key', { schema: { tags: ['app'], params: Id, body: Body }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => appIntelligence.rotateStoreAccountKey(deps, tenantOf(req), actorOf(req), req.params.id, req.body));
  r.post('/v1/app-intelligence/accounts/:id/sync', { schema: { tags: ['app'], params: Id, body: Body.optional() }, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) =>
    reply.status(202).send(await appIntelligence.requestStoreSync(deps, tenantOf(req), actorOf(req), req.params.id, req.body ?? {})),
  );
  r.post('/v1/app-intelligence/accounts/:id/apps', { schema: { tags: ['app'], params: Id, body: Body } }, async (req, reply) => reply.status(201).send(await appIntelligence.addStoreAppManually(deps, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.post('/v1/app-intelligence/apps/:id/decision', { schema: { tags: ['app'], params: Id, body: Body } }, async (req) => appIntelligence.decideStoreApp(deps, tenantOf(req), actorOf(req), req.params.id, req.body));
  r.post('/v1/app-intelligence/apps/:id/apple-analytics', { schema: { tags: ['app'], params: Id, body: Body.optional() }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => appIntelligence.requestAppleAnalytics(deps, tenantOf(req), actorOf(req), req.params.id, req.body ?? {}));
  r.get('/v1/app-intelligence/overview', { schema: { tags: ['app'], querystring: Range } }, async (req) => tenantTx(ctx, req, (t) => appIntelligence.appIntelligenceOverview(t, req.query, deps.clock.now())));
  r.get('/v1/app-intelligence/apps/:id', { schema: { tags: ['app'], params: Id, querystring: Range } }, async (req) => tenantTx(ctx, req, (t) => appIntelligence.appIntelligenceDetail(t, req.params.id, req.query, deps.clock.now())));
  r.get('/v1/app-intelligence/signals', { schema: { tags: ['app'] } }, async (req) => tenantTx(ctx, req, (t) => appIntelligence.storeKpiSignals(t, deps.clock.now())));
  r.get('/v1/app-intelligence/definitions', { schema: { tags: ['app'] } }, async () => ({
    metrics: appIntelligence.METRIC_DEFINITIONS,
    playFamilies: appIntelligence.PLAY_FAMILIES.map((f) => ({ family: f.family, label: f.label, dimensions: f.dimensions.map((d) => ({ suffix: d.suffix, defaultOn: d.defaultOn })) })),
    appleFamilies: appIntelligence.APPLE_FAMILIES.map((f) => ({ family: f.family, label: f.label, completenessDays: f.completenessDays })),
  }));
}
