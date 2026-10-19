import type { EventBus } from '@futuregrow/events';
import type { CoreDeps } from './deps.js';

/**
 * Event → job wiring. Handlers are idempotent: job keys deduplicate repeated deliveries.
 * Module-specific subscribers register additional handlers via `extraHandlers`.
 */
export type HandlerRegistrar = (bus: EventBus, deps: CoreDeps) => void;

const registrars: HandlerRegistrar[] = [];

export function registerEventHandlers(r: HandlerRegistrar): void {
  registrars.push(r);
}

export function wireEventHandlers(bus: EventBus, deps: CoreDeps): EventBus {
  bus.on('action.request.transitioned', 'execution-scheduler', async (ev) => {
    const to = ev.payload.to as string;
    const actionId = ev.aggregateId;
    if (to === 'APPROVED') {
      await deps.jobs.add('execute_action', { tenantId: ev.tenantId, actionId }, { jobKey: `exec:${actionId}`, maxAttempts: 5 });
    } else if (to === 'EXECUTED_UNVERIFIED' || (to === 'ESCALATED' && ev.payload.from === 'EXECUTING')) {
      const runAt = new Date(Date.now() + deps.config.verification.baseDelaySeconds * 1000);
      await deps.jobs.add('verify_action', { tenantId: ev.tenantId, actionId }, { jobKey: `verify:${actionId}`, runAt, maxAttempts: 5 });
    }
  });
  for (const r of registrars) r(bus, deps);
  return bus;
}
