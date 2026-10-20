import { brain, competitorsModule, governance, knowledge, registerEventHandlers, systemActor } from '@futuregrow/core';
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

  claims_sweep: async () => {
    await forEachTenant(deps, (tenantId) =>
      withTenant(deps.db, { tenantId, actor: 'system:claims-sweep' }, async (tx) => {
        await knowledge.sweepClaims(tx, tenantId, systemActor('claims-sweep'), new Date());
      }),
    );
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

export const MODULE_CRONTAB = ['13 * * * * competitor_crawl', '41 2 * * * claims_sweep', '27 6 * * * brain_cycle'];
