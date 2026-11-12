import { growthWarfare, registerEventHandlers } from '@futuregrow/core';
import { forEachTenant, registerTasks } from './tasks.js';

/**
 * Growth Warfare OS (D-054) worker tasks. The tick does nothing for a tenant whose features are
 * all OFF (the default) or whose emergency stop is engaged; every step re-checks its own switch.
 * Work is idempotent through growth_operations keys, so overlapping ticks and restarts are safe.
 */
registerTasks((deps) => ({
  growth_warfare_tick: async () => {
    await forEachTenant(deps, async (tenantId) => {
      const r = await growthWarfare.tick(deps, tenantId);
      if (!r.skipped) deps.logger.info({ tenantId, prepared: r.prepared?.length ?? 0, synced: r.synced, learning: r.learning }, 'growth warfare tick');
    });
  },
  growth_warfare_tenant: async (payload) => {
    const { tenantId } = payload as { tenantId: string };
    await growthWarfare.tick(deps, tenantId);
  },
}));

/** A new high-urgency opportunity runs the tenant's tick soon instead of waiting for the next cron slot. */
registerEventHandlers((bus, deps) => {
  bus.on('growth.opportunity.detected', 'growth-warfare-blitz', async (ev) => {
    if (ev.payload.urgency !== 'high') return;
    await deps.jobs.add('growth_warfare_tenant', { tenantId: ev.tenantId }, { jobKey: `growth-warfare:${ev.tenantId}`, runAt: new Date(Date.now() + 60_000), maxAttempts: 3 });
  });
});

export const GROWTH_WARFARE_CRONTAB = ['*/15 * * * * growth_warfare_tick'];
