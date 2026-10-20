import { and, inArray } from 'drizzle-orm';
import { appGrowth, discovery, lifecycle, paidMedia, social } from '@futuregrow/core';
import { connections, withTenant } from '@futuregrow/db';
import { forEachTenant, registerTasks } from './tasks.js';

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function activeConnections(deps: Parameters<Parameters<typeof registerTasks>[0]>[0], tenantId: string, providers: string[]) {
  return withTenant(deps.db, { tenantId, actor: 'system:scheduler' }, (tx) =>
    tx.select().from(connections).where(and(inArray(connections.provider, providers), inArray(connections.status, ['active', 'read_only']))),
  );
}

/** Channel tasks (M16–M22). All are idempotent: re-running a tick never duplicates a send. */
registerTasks((deps) => ({
  /** M16: due scheduled posts become M23 actions. */
  social_dispatch: async () => {
    await forEachTenant(deps, async (tenantId) => {
      await social.dispatchDuePosts(deps, tenantId);
    });
  },

  /** M20: enroll from trigger events, then advance due enrollments. */
  journey_tick: async () => {
    await forEachTenant(deps, async (tenantId) => {
      await lifecycle.enrollFromEvents(deps, tenantId);
      await lifecycle.tickJourneys(deps, tenantId);
    });
  },

  /** M17: campaign + spend sync for every ads connection. */
  ads_sync: async () => {
    await forEachTenant(deps, async (tenantId) => {
      for (const c of await activeConnections(deps, tenantId, ['google_ads', 'meta'])) {
        if (c.provider === 'meta' && !c.metadata.adAccountId) continue; // page-only Meta connection
        try {
          await paidMedia.syncCampaigns(deps, tenantId, c.id);
          await paidMedia.syncSpend(deps, tenantId, c.id);
        } catch (err) {
          deps.logger.warn({ tenantId, connectionId: c.id, err: err instanceof Error ? err.message : String(err) }, 'ads sync failed');
        }
      }
    });
  },

  /** M17/M24: reconcile the last 7 settled days. */
  spend_reconcile: async () => {
    const end = day(daysAgo(paidMedia.SETTLEMENT_LAG_DAYS));
    const start = day(daysAgo(paidMedia.SETTLEMENT_LAG_DAYS + 6));
    await forEachTenant(deps, async (tenantId) => {
      for (const c of await activeConnections(deps, tenantId, ['google_ads', 'meta'])) {
        if (c.provider === 'meta' && !c.metadata.adAccountId) continue;
        await paidMedia.reconcileSpend(deps, tenantId, c.id, { start, end });
      }
    });
  },

  /** M18: one queued audit (job added by requestSeoAudit). */
  seo_audit: async (payload) => {
    const p = payload as { tenantId?: string; auditId?: string };
    if (!p.tenantId || !p.auditId) throw new Error('seo_audit needs tenantId and auditId');
    await discovery.runSeoAudit(deps, p.tenantId, p.auditId);
  },

  /** M18: Search Console query data (site URL from connection metadata). */
  search_console_sync: async () => {
    await forEachTenant(deps, async (tenantId) => {
      for (const c of await activeConnections(deps, tenantId, ['search_console'])) {
        const siteUrl = typeof c.metadata.siteUrl === 'string' ? c.metadata.siteUrl : null;
        if (!siteUrl) continue;
        // Search Console data lags ~2 days; pull a rolling 7-day window.
        await discovery.syncSearchConsole(deps, tenantId, c.id, { siteUrl, startDate: day(daysAgo(9)), endDate: day(daysAgo(3)) });
      }
    });
  },

  /** M19: App Store Connect daily sales summary (available the following day). */
  app_store_sales_sync: async () => {
    await forEachTenant(deps, async (tenantId) => {
      for (const c of await activeConnections(deps, tenantId, ['app_store_connect'])) {
        try {
          await appGrowth.syncAppStoreSales(deps, tenantId, c.id, day(daysAgo(2)));
        } catch (err) {
          deps.logger.warn({ tenantId, connectionId: c.id, err: err instanceof Error ? err.message : String(err) }, 'app store sales sync failed');
        }
      }
    });
  },
}));

export const CHANNEL_CRONTAB = [
  '* * * * * social_dispatch',
  '* * * * * journey_tick',
  '37 */6 * * * ads_sync',
  '15 7 * * * spend_reconcile',
  '45 5 * * * search_console_sync',
  '5 9 * * * app_store_sales_sync',
];

