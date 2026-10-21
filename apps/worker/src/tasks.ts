import { type CoreDeps, connectionsModule, evidence, execution, ops, systemActor, webhooks, wireEventHandlers } from '@futuregrow/core';
import { actionRequests, connections, organization, outboxEvents, withSystem, withTenant } from '@futuregrow/db';
import { EventBus, rowToEnvelope } from '@futuregrow/events';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { JobHelpers, Task, TaskList } from 'graphile-worker';

export type TaskFactory = (deps: CoreDeps) => Record<string, Task>;
const extraTaskFactories: TaskFactory[] = [];

/** Modules contribute tasks (analytics triggers, journeys, crawls...) through this registry. */
export function registerTasks(f: TaskFactory): void {
  extraTaskFactories.push(f);
}

async function reschedule(helpers: JobHelpers, task: string, payload: Record<string, unknown>, runAt: Date, jobKey: string) {
  await helpers.addJob(task, payload, { runAt, jobKey });
}

export async function forEachTenant(deps: CoreDeps, fn: (tenantId: string) => Promise<void>): Promise<void> {
  const tenants = await withSystem(deps.db, 'system:scheduler', (tx) => tx.select({ id: organization.id }).from(organization));
  for (const t of tenants) {
    try {
      await fn(t.id);
    } catch (err) {
      deps.logger.error({ err, tenantId: t.id }, 'tenant task failed');
    }
  }
}

export function buildTaskList(deps: CoreDeps, opts: { environment?: string } = {}): TaskList {
  const bus = wireEventHandlers(new EventBus(), deps);

  const tasks: TaskList = {
    /** Transactional-outbox dispatch (at-least-once; handlers are idempotent). */
    dispatch_event: async (payload) => {
      const { eventId } = payload as { eventId: string };
      const row = await withSystem(deps.db, 'system:dispatcher', async (tx) => {
        const [r] = await tx.select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
        if (r)
          await tx
            .update(outboxEvents)
            .set({ dispatchAttempts: sql`${outboxEvents.dispatchAttempts} + 1` })
            .where(eq(outboxEvents.id, eventId));
        return r;
      });
      if (!row || row.dispatchedAt) return;
      const failures = await bus.dispatch(rowToEnvelope(row));
      if (failures.length) {
        await withSystem(deps.db, 'system:dispatcher', (tx) =>
          tx
            .update(outboxEvents)
            .set({ lastError: JSON.stringify(failures).slice(0, 4000) })
            .where(eq(outboxEvents.id, eventId)),
        );
        throw new Error(`event ${eventId} handlers failed: ${failures.map((f) => f.handler).join(', ')}`);
      }
      await withSystem(deps.db, 'system:dispatcher', (tx) => tx.update(outboxEvents).set({ dispatchedAt: new Date(), lastError: null }).where(eq(outboxEvents.id, eventId)));
    },

    execute_action: async (payload, helpers) => {
      const { tenantId, actionId } = payload as { tenantId: string; actionId: string };
      const out = await execution.executeAction(deps, tenantId, actionId);
      helpers.logger.info(`execute ${actionId}: ${JSON.stringify(out)}`);
      if (out.kind === 'reschedule') await reschedule(helpers, 'execute_action', { tenantId, actionId }, out.runAt, `exec:${actionId}`);
    },

    verify_action: async (payload, helpers) => {
      const { tenantId, actionId } = payload as { tenantId: string; actionId: string };
      const out = await execution.verifyAction(deps, tenantId, actionId);
      helpers.logger.info(`verify ${actionId}: ${JSON.stringify(out)}`);
      if (out.kind === 'reschedule') await reschedule(helpers, 'verify_action', { tenantId, actionId }, out.runAt, `verify:${actionId}`);
    },

    process_webhook: async (payload) => {
      await webhooks.processWebhook(deps, (payload as { inboxId: string }).inboxId);
    },

    /** Watchdog: re-enqueue deliveries/actions whose jobs were lost. Job keys keep this idempotent. */
    watchdog: async (_p, helpers) => {
      for (const id of await webhooks.pendingWebhooks(deps.db)) {
        await helpers.addJob('process_webhook', { inboxId: id }, { jobKey: `webhook:${id}` });
      }
      const stale = new Date(Date.now() - 10 * 60_000);
      const stuck = await withSystem(deps.db, 'system:watchdog', (tx) =>
        tx
          .select({ id: actionRequests.id, tenantId: actionRequests.tenantId, status: actionRequests.status })
          .from(actionRequests)
          .where(and(inArray(actionRequests.status, ['APPROVED', 'EXECUTED_UNVERIFIED']), lt(actionRequests.updatedAt, stale)))
          .limit(500),
      );
      for (const a of stuck) {
        if (a.status === 'APPROVED') await helpers.addJob('execute_action', { tenantId: a.tenantId, actionId: a.id }, { jobKey: `exec:${a.id}` });
        else await helpers.addJob('verify_action', { tenantId: a.tenantId, actionId: a.id }, { jobKey: `verify:${a.id}` });
      }
    },

    evidence_sweep: async () => {
      await forEachTenant(deps, (tenantId) =>
        withTenant(deps.db, { tenantId, actor: 'system:evidence-sweep' }, async (tx) => {
          await evidence.sweepEvidenceFreshness(tx, tenantId, systemActor('evidence-sweep'), new Date());
        }),
      );
    },

    connector_health: async () => {
      const conns = await withSystem(deps.db, 'system:health', (tx) =>
        tx
          .select({ id: connections.id, tenantId: connections.tenantId })
          .from(connections)
          .where(inArray(connections.status, ['active', 'read_only'])),
      );
      for (const c of conns) {
        try {
          await connectionsModule.checkConnectionHealth(deps, c.tenantId, c.id);
        } catch (err) {
          deps.logger.warn({ err, connectionId: c.id }, 'health check failed');
        }
      }
    },

    webhook_retention: async () => {
      await webhooks.webhookRetentionSweep(deps.db, 30);
    },

    /** Operator alerts: component health, critical alerts, severe incidents, failed jobs. */
    ops_monitor: async () => {
      const r = await ops.runOpsMonitor(deps.db, deps.notifier ?? new ops.LogNotifier(deps.logger), { environment: opts.environment ?? deps.config.environment });
      if (r.sent || r.failed) deps.logger.info({ sent: r.sent, failed: r.failed, ok: r.status.ok }, 'ops monitor');
    },
  };
  for (const f of extraTaskFactories) Object.assign(tasks, f(deps));
  return tasks;
}

/** Graphile crontab (UTC). Heavier jobs run on the Northflank analytics/media jobs instead. */
export const CRONTAB = ['*/5 * * * * watchdog', '*/5 * * * * ops_monitor', '7 * * * * evidence_sweep', '17 * * * * connector_health', '23 3 * * * webhook_retention'].join('\n');
