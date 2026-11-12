import { autopilot, brain, competitorsModule, contentStudio, customers, eventForwarding, governance, knowledge, media, registerEventHandlers, systemActor } from '@futuregrow/core';
import { competitorDiscoverySettings, competitorSources, growthDecisions, growthIdeas, withTenant } from '@futuregrow/db';
import { loadEnv, triggerNorthflankJob } from '@futuregrow/runtime';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { forEachTenant, registerTasks } from './tasks.js';

/** Module tasks registered with the worker. Each is idempotent and tenant-scoped. */
registerTasks((deps) => ({
  competitor_discovery_tick: async () => {
    await forEachTenant(deps, async (tenantId) => {
      const settings = await withTenant(deps.db, { tenantId, actor: 'system:competitor-discovery' }, (tx) =>
        tx
          .select()
          .from(competitorDiscoverySettings)
          .where(and(eq(competitorDiscoverySettings.enabled, true), or(isNull(competitorDiscoverySettings.lastAttemptAt), lte(competitorDiscoverySettings.lastAttemptAt, sql`now() - make_interval(hours => ${competitorDiscoverySettings.intervalHours})`)))),
      );
      for (const s of settings) await deps.jobs.add('competitor_discovery', { tenantId, brandId: s.brandId }, { jobKey: `competitor-discovery:${tenantId}:${s.brandId}`, queueName: 'competitor-discovery-provider', maxAttempts: 1 });
    });
  },
  competitor_discovery: async (payload) => {
    const { tenantId, brandId } = payload as { tenantId: string; brandId: string };
    try {
      await competitorsModule.discovery.runDiscovery(deps, tenantId, brandId);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 3500));
    }
  },
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

  /** Content studio: a draft whose day passed unsubmitted is expired or superseded (never published, approved or deleted). */
  studio_drafts_sweep: async () => {
    await forEachTenant(deps, (tenantId) =>
      withTenant(deps.db, { tenantId, actor: 'system:autopilot' }, async (tx) => {
        const r = await contentStudio.expireStaleDrafts(tx, tenantId, deps.clock.now());
        if (r.expired || r.superseded) deps.logger.info({ tenantId, ...r }, 'stale studio drafts closed');
      }),
    );
  },

  /** PostHog forwarding (P2-11): only enabled destinations, only consented events; failures leave the cursor in place. */
  posthog_forward: async () => {
    await forEachTenant(deps, async (tenantId) => {
      const rows = await withTenant(deps.db, { tenantId, actor: 'system:event-forwarding' }, (tx) => eventForwarding.forwardingStatus(tx));
      for (const r of rows.filter((x) => x.enabled)) {
        const out = await eventForwarding.forwardEvents(deps, tenantId, r.connectionId);
        if (out.status === 'failed') deps.logger.warn({ tenantId, connectionId: r.connectionId, error: out.error }, 'posthog forwarding failed; will retry');
      }
    });
  },

  /** Stock imports and AI images (P3-02/P3-03): up to five queued media jobs per tick, each leased and crash-safe. */
  media_jobs_tick: async () => {
    for (let i = 0; i < 5; i++) {
      const r = await media.sources.processNextMediaJob(deps);
      if (r.kind === 'none') break;
      deps.logger.info({ job: r.jobId, outcome: r.kind, ...('reason' in r ? { reason: r.reason } : {}) }, 'media job processed');
    }
  },

  /** Video Studio: rendering projects advance only from their render job's real outcome (ready, QA failed, failed). */
  video_projects_sync: async () => {
    await forEachTenant(deps, (tenantId) =>
      withTenant(deps.db, { tenantId, actor: 'system:video-studio' }, async (tx) => {
        const n = await media.video.syncVideoProjects(tx, tenantId);
        if (n) deps.logger.info({ tenantId, projects: n }, 'video projects advanced');
      }),
    );
  },

  /** Stock assets whose licence record was withdrawn stop being publish-eligible. */
  stock_licence_sweep: async () => {
    await forEachTenant(deps, (tenantId) =>
      withTenant(deps.db, { tenantId, actor: 'system:media-sources' }, async (tx) => {
        const n = await media.sources.recheckStockLicences(tx, deps, tenantId);
        if (n) deps.logger.warn({ tenantId, assets: n }, 'stock assets lost their licence');
      }),
    );
  },

  /** Universal Studio (P3-01): scheduled items advance only from their post's real state (verified, failed, measured, learned). */
  studio_items_sync: async () => {
    await forEachTenant(deps, async (tenantId) => {
      const programs = await withTenant(deps.db, { tenantId, actor: 'system:universal-studio' }, (tx) => contentStudio.universal.listGeneralPrograms(tx));
      for (const p of programs) {
        try {
          const r = await contentStudio.universal.syncProgramItems(deps, tenantId, p.id);
          if (r.verified || r.failed || r.measured || r.learned) deps.logger.info({ tenantId, programId: p.id, ...r }, 'studio items advanced');
        } catch (err) {
          deps.logger.warn({ tenantId, programId: p.id, err: err instanceof Error ? err.message : String(err) }, 'studio items sync failed');
        }
      }
    });
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

export const MODULE_CRONTAB = [
  '* * * * * autopilot_tick',
  '13 * * * * competitor_crawl',
  '7 * * * * competitor_discovery_tick',
  '41 2 * * * claims_sweep',
  '19 * * * * studio_drafts_sweep',
  '*/15 * * * * studio_items_sync',
  '* * * * * media_jobs_tick',
  '*/5 * * * * posthog_forward',
  '*/2 * * * * video_projects_sync',
  '33 4 * * * stock_licence_sweep',
  '53 3 * * * retention_sweep',
  '27 6 * * * brain_cycle',
];
