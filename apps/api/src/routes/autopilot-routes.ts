import { GoalInputSchema } from '@futuregrow/contracts';
import { autopilot, getAiBudget, governance } from '@futuregrow/core';
import { connections, evidenceRecords, metricSeries, modelRegistry } from '@futuregrow/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });

/** Autopilot (M23 orchestrator, D-033): goals, live activity, the approvals inbox and results. */
export function registerAutopilotRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;

  r.get('/v1/autopilot/status', { schema: { tags: ['autopilot'] } }, async (req) =>
    tenantTx(ctx, req, async (tx) => {
      const tenantId = tenantOf(req);
      const halt = await autopilot.haltReason(tx);
      return { available: autopilot.autopilotAvailable(deps.config), enabled: await autopilot.autopilotEnabled(tx, tenantId), stopped: halt, modelAvailable: Boolean(deps.models) };
    }),
  );
  r.put('/v1/autopilot/settings', { schema: { tags: ['autopilot'], body: z.object({ enabled: z.boolean() }) } }, async (req) => tenantTx(ctx, req, (tx) => autopilot.setAutopilotEnabled(tx, tenantOf(req), actorOf(req), req.body.enabled)));

  /** Business setup: real readiness facts only (counts and states from the database). */
  r.get('/v1/autopilot/readiness', { schema: { tags: ['autopilot'] } }, async (req) =>
    tenantTx(ctx, req, async (tx) => {
      const tenantId = tenantOf(req);
      const policy = await governance.getTenantPolicy(tx, tenantId);
      const markets = await governance.approvedJurisdictions(tx, policy);
      const conns = await tx.select({ provider: connections.provider, status: connections.status, displayName: connections.displayName }).from(connections);
      const [ev] = await tx.select({ n: sql<number>`count(*)::int` }).from(evidenceRecords).where(eq(evidenceRecords.status, 'admitted'));
      const [claims] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from claims where status = 'approved' and (expires_at is null or expires_at > now())`).then((x) => x.rows);
      const series = await tx.select({ key: metricSeries.key, name: metricSeries.name, kind: metricSeries.kind }).from(metricSeries).where(eq(metricSeries.kind, 'kpi')).limit(50);
      const [models] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(modelRegistry)
        .where(and(eq(modelRegistry.approvedForProduction, true), eq(modelRegistry.status, 'active')));
      const ai = await getAiBudget(tx, tenantId, deps.config);
      return {
        policyConfigured: policy.configured,
        approvedMarkets: markets,
        categories: Object.fromEntries(Object.entries(policy.categories).map(([k, v]) => [k, v?.autonomy ?? null])),
        connections: conns,
        evidence: ev?.n ?? 0,
        approvedClaims: claims?.n ?? 0,
        kpiSeries: series,
        approvedModels: models?.n ?? 0,
        modelGateway: Boolean(deps.models),
        aiBudget: ai,
        mfaVerified: actorOf(req).mfaVerified,
      };
    }),
  );

  r.post('/v1/autopilot/interpret', { schema: { tags: ['autopilot'], body: z.object({ text: z.string().min(3).max(2000) }) } }, async (req) =>
    tenantTx(ctx, req, async (tx) => {
      const policy = await governance.getTenantPolicy(tx, tenantOf(req));
      const markets = await governance.approvedJurisdictions(tx, policy);
      return autopilot.interpretForTenant(tx, deps, req.body.text, markets[0] ?? policy.approvedJurisdictions[0] ?? null);
    }),
  );

  r.get('/v1/autopilot/goals', { schema: { tags: ['autopilot'] } }, async (req) => tenantTx(ctx, req, (tx) => autopilot.listGoals(tx)));
  r.post('/v1/autopilot/goals', { schema: { tags: ['autopilot'], body: GoalInputSchema } }, async (req, reply) => {
    const goal = await tenantTx(ctx, req, (tx) => autopilot.createGoal(tx, deps, tenantOf(req), actorOf(req), req.body));
    // The first cycle starts right away instead of waiting for the next minute tick.
    await autopilot.enqueueWith(deps)(tenantOf(req), goal.id);
    return reply.status(201).send(goal);
  });
  r.get('/v1/autopilot/goals/:id', { schema: { tags: ['autopilot'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => autopilot.goalDetail(tx, req.params.id)));
  r.post('/v1/autopilot/goals/:id/:command', { schema: { tags: ['autopilot'], params: z.object({ id: z.string().uuid(), command: z.enum(['pause', 'resume', 'cancel', 'run_now']) }) } }, async (req) => {
    const goal = await tenantTx(ctx, req, (tx) => autopilot.commandGoal(tx, deps, tenantOf(req), actorOf(req), req.params.id, req.params.command));
    if (goal.status === 'active' && (req.params.command === 'run_now' || req.params.command === 'resume')) await autopilot.enqueueWith(deps)(tenantOf(req), goal.id);
    return goal;
  });
  r.get('/v1/autopilot/activity', { schema: { tags: ['autopilot'], querystring: z.object({ goalId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(300).default(60) }) } }, async (req) => tenantTx(ctx, req, (tx) => autopilot.listActivity(tx, req.query)));
  r.get('/v1/autopilot/inbox', { schema: { tags: ['autopilot'] } }, async (req) => tenantTx(ctx, req, (tx) => autopilot.inbox(tx)));
}
