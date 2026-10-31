import { autopilot, brain, competitorsModule, customers, governance, knowledge, registerEventHandlers, systemActor } from '@futuregrow/core';
import { competitorSources, growthDecisions, growthIdeas, withTenant } from '@futuregrow/db';
import { loadEnv, triggerNorthflankJob } from '@futuregrow/runtime';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { forEachTenant, registerTasks } from './tasks.js';

/** Module tasks registered with the worker. Each is idempotent and tenant-scoped. */
registerTasks((deps) => ({
  competitor_crawl: async () => {
    await forEachTenant(deps, async (tenantId) => {
      const due = await withTenant(deps.db, { tenantId, actor: 'system:competitor-collector' }, (tx) =>
        tx
          .select({ id: competitorSources.id })
          .from(competitorSources)
          .where(and(eq(competitorSources.status, 'approved'), or(isNull(competitorSources.lastFetchedAt), lte(competitorSources.lastFetchedAt, sql`now() - make_interval(hours => ${competitorSources.crawlIntervalHours})`))))
          .limit(25),
      );
      for (const s of due) {
        const r = await competitorsModule.crawlSource(deps, tenantId, s.id);
        if (r.status === 'captured' && r.snapshotId && deps.models) await competitorsModule.extractObservationsWithModel(deps, tenantId, r.snapshotId);
      }
    });
  },

  /** M02 retention: tenant-configured durations only; nothing is deleted without a policy. */
  retention_sweep: async () => {
    await forEachTenant(deps, async (tenantId) => {
      const r = await customers.applyRetention(deps, tenantId);
      if (Object.keys(r).length) deps.logger.info({ tenantId, retention: r }, 'retention applied');
    });
  },

  claims_sweep: async () => {
    await forEachTenant(deps, (tenantId) =>
      withTenant(deps.db, { tenantId, actor: 'system:claims-sweep' }, async (tx) => {
        await knowledge.sweepClaims(tx, tenantId, systemActor('claims-sweep'), new Date());
      }),
    );
  },

  /** Autopilot (D-033): queue goals with due work; runs without any browser session. */
  autopilot_tick: async () => {
    const r = await autopilot.autopilotTick(deps);
    if (r.queued) deps.logger.info({ queued: r.queued }, 'autopilot goals queued');
  },

  /** Run a goal's next checkpointed steps; continues itself while work is due within minutes. */
  autopilot_advance: async (payload, helpers) => {
    const { tenantId, goalId } = payload as { tenantId: string; goalId: string };
    const r = await autopilot.advanceGoal(deps, tenantId, goalId);
    helpers.logger.info(`autopilot ${goalId}: ${JSON.stringify({ ran: r.ran, idle: r.idle })}`);
    if (r.nextAt && r.nextAt.getTime() <= Date.now() + 5 * 60_000) {
      await helpers.addJob('autopilot_advance', { tenantId, goalId }, { jobKey: `autopilot:${goalId}`, runAt: r.nextAt, maxAttempts: 3 });
    }
  },

  /** Proposals only: decisions still need human acceptance and the M23 gateway to act. */
  brain_cycle: async () => {
    if (!deps.models) return;
    await forEachTenant(deps, async (tenantId) => {
      const policy = await withTenant(deps.db, { tenantId, actor: 'system:brain' }, (tx) => governance.getTenantPolicy(tx, tenantId));
      const market = policy.approvedJurisdictions[0];
      if (!policy.configured || !market) return; // market and autonomy policy are tenant-specified [U]
      const candidates = await withTenant(deps.db, { tenantId, actor: 'system:brain' }, async (tx) => {
        const recent = await tx.select({ ideaId: growthDecisions.ideaId }).from(growthDecisions).where(gte(growthDecisions.createdAt, sql`now() - interval '7 days'`));
        const skip = new Set(recent.map((r) => r.ideaId));
        const rows = await tx
          .select()
          .from(growthIdeas)
          .where(inArray(growthIdeas.status, ['queued_for_test', 'validated']))
          .orderBy(desc(growthIdeas.evidenceStrength))
          .limit(10);
        return rows.filter((r) => !skip.has(r.id)).slice(0, 3);
      });
      for (const idea of candidates) {
        await brain.proposeDecision(deps, tenantId, systemActor('brain-cycle'), { ideaId: idea.id, market, horizon: { value: 2, unit: 'week' } });
      }
    });
  },
}));

/** Optional immediate Northflank job runs when analytics/media work is queued (D-016). */
registerEventHandlers((bus, deps) => {
  const env = loadEnv();
  bus.on('analytics.request.queued', 'northflank-analytics-trigger', async () => {
    const r = await triggerNorthflankJob({ token: env.NORTHFLANK_API_TOKEN, projectId: env.NORTHFLANK_PROJECT_ID, jobId: env.NORTHFLANK_ANALYTICS_JOB_ID });
    if (r === 'failed') deps.logger.warn('northflank analytics job trigger failed; cron schedule will pick the request up');
  });
  bus.on('media.render.requested', 'northflank-media-trigger', async () => {
    const r = await triggerNorthflankJob({ token: env.NORTHFLANK_API_TOKEN, projectId: env.NORTHFLANK_PROJECT_ID, jobId: env.NORTHFLANK_MEDIA_JOB_ID });
    if (r === 'failed') deps.logger.warn('northflank media job trigger failed; cron schedule will pick the request up');
  });
});

export const MODULE_CRONTAB = ['* * * * * autopilot_tick', '13 * * * * competitor_crawl', '41 2 * * * claims_sweep', '53 3 * * * retention_sweep', '27 6 * * * brain_cycle'];
