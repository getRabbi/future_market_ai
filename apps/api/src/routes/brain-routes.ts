import { brain, competitorsModule, ideas } from '@futuregrow/core';
import { agentRuns } from '@futuregrow/db';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });
const Body = z.record(z.string(), z.unknown());

/** Routes for M05 competitors, M06 ideas and M07 Growth Brain. */
export function registerBrainRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;

  /* ---------------- M05 ---------------- */
  r.get('/v1/competitors', { schema: { tags: ['competitors'] } }, async (req) => tenantTx(ctx, req, (tx) => competitorsModule.listCompetitors(tx)));
  r.post('/v1/competitors', { schema: { tags: ['competitors'], body: z.object({ name: z.string().min(1).max(200), domains: z.array(z.string()).min(1).max(20), notes: z.string().max(2000).optional() }) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => competitorsModule.addCompetitor(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/competitors/sources', { schema: { tags: ['competitors'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => competitorsModule.proposeSource(tx, tenantOf(req), actorOf(req), req.body))));
  r.post('/v1/competitors/sources/:id/review', { schema: { tags: ['competitors'], params: Id, body: z.object({ decision: z.enum(['approved', 'revoked']) }) } }, async (req) => tenantTx(ctx, req, (tx) => competitorsModule.reviewSource(tx, tenantOf(req), actorOf(req), req.params.id, req.body.decision)));
  r.post('/v1/competitors/sources/:id/crawl', { schema: { tags: ['competitors'], params: Id } }, async (req) => competitorsModule.crawlSource(deps, tenantOf(req), req.params.id));
  r.get('/v1/competitors/observations', { schema: { tags: ['competitors'], querystring: z.object({ competitorId: z.string().uuid().optional() }) } }, async (req) => tenantTx(ctx, req, (tx) => competitorsModule.listObservations(tx, req.query.competitorId)));
  r.get('/v1/competitors/gaps', { schema: { tags: ['competitors'] } }, async (req) => tenantTx(ctx, req, (tx) => competitorsModule.featureGaps(tx)));
  r.post('/v1/competitors/rea-jobs', { schema: { tags: ['competitors'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => competitorsModule.registerReaJob(tx, tenantOf(req), actorOf(req), req.body))));

  /* ---------------- M06 ---------------- */
  r.get('/v1/ideas', { schema: { tags: ['ideas'] } }, async (req) => tenantTx(ctx, req, (tx) => ideas.rankedIdeas(tx)));
  r.post('/v1/ideas', { schema: { tags: ['ideas'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => ideas.createIdea(tx, deps, tenantOf(req), actorOf(req), req.body, 'human'))));
  r.post('/v1/ideas/generate', { schema: { tags: ['ideas'], body: z.object({ maxIdeas: z.number().int().min(1).max(8).default(5) }) } }, async (req, reply) => reply.status(202).send(await ideas.generateIdeas(deps, tenantOf(req), actorOf(req), req.body)));
  r.post('/v1/ideas/:id/status', { schema: { tags: ['ideas'], params: Id, body: z.object({ status: z.enum(['queued_for_test', 'testing', 'validated', 'invalidated', 'rejected']) }) } }, async (req) => tenantTx(ctx, req, (tx) => ideas.setIdeaStatus(tx, tenantOf(req), actorOf(req), req.params.id, req.body.status)));

  /* ---------------- M07 ---------------- */
  r.get('/v1/brain/decisions', { schema: { tags: ['brain'] } }, async (req) => tenantTx(ctx, req, (tx) => brain.listDecisions(tx)));
  r.post(
    '/v1/brain/decisions',
    {
      schema: {
        tags: ['brain'],
        body: z.object({
          ideaId: z.string().uuid(),
          objective: z.string().max(500).optional(),
          market: z.string().min(2).max(10),
          horizon: z.object({ value: z.number().int().min(1).max(52), unit: z.enum(['day', 'week', 'month']) }),
          seriesId: z.string().uuid().optional(),
        }),
      },
    },
    async (req, reply) => reply.status(202).send(await brain.proposeDecision(deps, tenantOf(req), actorOf(req), req.body)),
  );
  r.post('/v1/brain/decisions/:id/accept', { schema: { tags: ['brain'], params: Id } }, async (req, reply) => reply.status(201).send(await brain.acceptDecision(deps, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/brain/decisions/:id/reject', { schema: { tags: ['brain'], params: Id, body: z.object({ reason: z.string().min(3) }) } }, async (req) => tenantTx(ctx, req, (tx) => brain.rejectDecision(tx, tenantOf(req), actorOf(req), req.params.id, req.body.reason)));
  r.get('/v1/brain/runs', { schema: { tags: ['brain'] } }, async (req) => tenantTx(ctx, req, (tx) => tx.select().from(agentRuns).orderBy(desc(agentRuns.startedAt)).limit(100)));
  r.get('/v1/brain/runs/:id', { schema: { tags: ['brain'], params: Id } }, async (req) => tenantTx(ctx, req, async (tx) => (await tx.select().from(agentRuns).where(eq(agentRuns.id, req.params.id)))[0] ?? null));
}
