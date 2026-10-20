import { randomUUID } from 'node:crypto';
import { EVENT_TYPES, type EventEnvelope, EventEnvelopeSchema, type EventType } from '@futuregrow/contracts';
import { outboxEvents, type Tx } from '@futuregrow/db';

export interface EmitInput {
  tenantId: string;
  eventType: EventType;
  aggregateType: string;
  aggregateId: string;
  actor: EventEnvelope['actor'];
  payload: Record<string, unknown>;
  correlationId?: string | null;
  causationId?: string | null;
}

/**
 * Write a domain event to the transactional outbox. Must be called inside the same transaction
 * as the state change it describes; the database trigger enqueues dispatch atomically (D-009).
 */
export async function emitEvent(tx: Tx, input: EmitInput): Promise<EventEnvelope> {
  const envelope: EventEnvelope = EventEnvelopeSchema.parse({
    eventId: randomUUID(),
    eventType: input.eventType,
    eventVersion: EVENT_TYPES[input.eventType],
    tenantId: input.tenantId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    occurredAt: new Date().toISOString(),
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    actor: input.actor,
    payload: input.payload,
  });
  await tx.insert(outboxEvents).values({
    id: envelope.eventId,
    tenantId: envelope.tenantId,
    eventType: envelope.eventType,
    eventVersion: envelope.eventVersion,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    occurredAt: new Date(envelope.occurredAt),
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
    actorType: envelope.actor.type,
    actorId: envelope.actor.id,
    payload: envelope.payload,
  });
  return envelope;
}

export type EventHandler = (event: EventEnvelope) => Promise<void>;

/**
 * In-process subscriber registry used by the worker's `dispatch_event` task. Handlers must be
 * idempotent: an event may be delivered more than once (at-least-once semantics).
 */
export class EventBus {
  private readonly handlers = new Map<string, { name: string; fn: EventHandler }[]>();

  on(eventType: EventType | '*', name: string, fn: EventHandler): this {
    const list = this.handlers.get(eventType) ?? [];
    if (list.some((h) => h.name === name)) throw new Error(`duplicate handler ${name} for ${eventType}`);
    list.push({ name, fn });
    this.handlers.set(eventType, list);
    return this;
  }

  handlersFor(eventType: string): { name: string; fn: EventHandler }[] {
    return [...(this.handlers.get(eventType) ?? []), ...(this.handlers.get('*') ?? [])];
  }

  /** Runs every handler; collects failures so one bad subscriber does not hide the others. */
  async dispatch(event: EventEnvelope): Promise<{ handler: string; error: string }[]> {
    const failures: { handler: string; error: string }[] = [];
    for (const h of this.handlersFor(event.eventType)) {
      try {
        await h.fn(event);
      } catch (err) {
        failures.push({ handler: h.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }
}

export function rowToEnvelope(row: typeof outboxEvents.$inferSelect): EventEnvelope {
  return {
    eventId: row.id,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    tenantId: row.tenantId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    occurredAt: row.occurredAt.toISOString(),
    correlationId: row.correlationId,
    causationId: row.causationId,
    actor: { type: row.actorType as EventEnvelope['actor']['type'], id: row.actorId },
    payload: row.payload,
  };
}
