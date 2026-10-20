import { ANALYTICS_KINDS } from '@futuregrow/contracts';
import { analytics, audiences, experimentsModule } from '@futuregrow/core';
import { metricSeries, segmentSnapshots } from '@futuregrow/db';
import { identifierHash } from '@futuregrow/observability';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';
import { registerBrainRoutes } from './brain-routes.js';

const Id = z.object({ id: z.string().uuid() });
const Body = z.record(z.string(), z.unknown());

/** Routes for M04–M11: series, analytics requests/results, experiments, audiences. */
export function registerIntelligenceRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;

  r.get('/v1/analytics/series', { schema: { tags: ['analytics'] } }, async (req) => tenantTx(ctx, req, (tx) => tx.select().from(metricSeries).orderBy(metricSeries.key)));
  r.post('/v1/analytics/series', { schema: { tags: ['analytics'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => analytics.upsertSeries(tx, tenantOf(req), actorOf(req), req.body))));
  r.post('/v1/analytics/series/:id/points', { schema: { tags: ['analytics'], params: Id, body: z.object({ points: z.array(z.unknown()).min(1).max(20000) }) } }, async (req) => tenantTx(ctx, req, (tx) => analytics.appendPoints(tx, tenantOf(req), req.params.id, req.body.points)));
  r.get('/v1/analytics/series/:id/points', { schema: { tags: ['analytics'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => analytics.getSeriesPoints(tx, req.params.id)));

  r.post('/v1/analytics/requests', { schema: { tags: ['analytics'], body: z.object({ kind: z.enum(ANALYTICS_KINDS), params: Body, priority: z.number().int().min(1).max(1000).default(100) }) } }, async (req, reply) =>
    reply.status(202).send(await tenantTx(ctx, req, (tx) => analytics.requestAnalytics(tx, tenantOf(req), actorOf(req), req.body.kind, req.body.params, req.body.priority))),
  );
  r.get('/v1/analytics/requests', { schema: { tags: ['analytics'] } }, async (req) => tenantTx(ctx, req, (tx) => analytics.listRequests(tx)));
  r.get('/v1/analytics/requests/:id', { schema: { tags: ['analytics'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => analytics.getRequest(tx, req.params.id)));

  r.get('/v1/forecasts/latest', { schema: { tags: ['forecasting'], querystring: z.object({ seriesId: z.string().uuid() }) } }, async (req) => tenantTx(ctx, req, (tx) => analytics.latestForecast(tx, req.query.seriesId)));
  r.get('/v1/forecasts/:id', { schema: { tags: ['forecasting'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => analytics.forecastDetail(tx, req.params.id)));
  r.get('/v1/mmm/:id', { schema: { tags: ['mmm'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => analytics.mmmDetail(tx, req.params.id)));
  r.get('/v1/market/trends', { schema: { tags: ['market'] } }, async (req) => tenantTx(ctx, req, (tx) => analytics.listTrends(tx)));
  r.get('/v1/market/topics', { schema: { tags: ['market'] } }, async (req) => tenantTx(ctx, req, (tx) => analytics.listTopics(tx)));

  /* ---------------- M10 experiments ---------------- */
  r.get('/v1/experiments', { schema: { tags: ['experiments'] } }, async (req) => tenantTx(ctx, req, (tx) => experimentsModule.listExperiments(tx)));
  r.post('/v1/experiments', { schema: { tags: ['experiments'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => experimentsModule.createExperiment(tx, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/experiments/:id', { schema: { tags: ['experiments'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => experimentsModule.experimentDetail(tx, req.params.id)));
  r.post('/v1/experiments/:id/propose-start', { schema: { tags: ['experiments'], params: Id, body: z.object({ evidenceIds: z.array(z.string().uuid()).default([]) }) } }, async (req, reply) => reply.status(201).send(await experimentsModule.proposeStart(deps, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.post('/v1/experiments/:id/stop', { schema: { tags: ['experiments'], params: Id, body: z.object({ reason: z.string().min(3) }) } }, async (req) => tenantTx(ctx, req, (tx) => experimentsModule.stopExperiment(tx, tenantOf(req), actorOf(req), req.params.id, req.body.reason)));
  r.post('/v1/experiments/:id/analyze', { schema: { tags: ['experiments'], params: Id } }, async (req, reply) => reply.status(202).send(await tenantTx(ctx, req, (tx) => experimentsModule.requestAnalysis(tx, tenantOf(req), actorOf(req), req.params.id))));

  /* ---------------- M11 audiences ---------------- */
  r.get('/v1/audiences/segments', { schema: { tags: ['audiences'] } }, async (req) => tenantTx(ctx, req, (tx) => audiences.listSegments(tx)));
  r.post('/v1/audiences/segments', { schema: { tags: ['audiences'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => audiences.defineSegment(tx, tenantOf(req), actorOf(req), req.body))));
  r.post('/v1/audiences/segments/:id/snapshot', { schema: { tags: ['audiences'], params: Id } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => audiences.computeSnapshot(tx, tenantOf(req), req.params.id, (email) => identifierHash(deps.config.identifierPepper, 'email', email)))));
  r.get('/v1/audiences/segments/:id/snapshots', { schema: { tags: ['audiences'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => tx.select().from(segmentSnapshots).where(eq(segmentSnapshots.segmentId, req.params.id)).orderBy(desc(segmentSnapshots.computedAt))));
  r.get('/v1/audiences/snapshots/:id/members', { schema: { tags: ['audiences'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => audiences.snapshotMembers(tx, req.params.id)));
  r.get('/v1/audiences/propensity/:id', { schema: { tags: ['audiences'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => analytics.propensityDetail(tx, req.params.id)));

  registerBrainRoutes(app, ctx);
}
