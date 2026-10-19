import type { EventType } from '@futuregrow/contracts';
import { type Tx, appendAudit } from '@futuregrow/db';
import { emitEvent } from '@futuregrow/events';
import { forbidden } from '@futuregrow/observability';
import type { Actor } from './deps.js';

export async function audit(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  action: string,
  subject: { type: string; id: string },
  payload: Record<string, unknown> = {},
): Promise<void> {
  await appendAudit(tx, {
    tenantId,
    actorType: actor.type,
    actorId: actor.id,
    action,
    subjectType: subject.type,
    subjectId: subject.id,
    payload,
  });
}

export async function emit(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  eventType: EventType,
  aggregate: { type: string; id: string },
  payload: Record<string, unknown>,
  causationId?: string | null,
) {
  return emitEvent(tx, {
    tenantId,
    eventType,
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    actor: { type: actor.type === 'user' ? 'user' : actor.type, id: actor.id },
    payload,
    causationId: causationId ?? null,
  });
}

/** Audit + outbox event in one call (both inside the caller's transaction). */
export async function record(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  eventType: EventType,
  subject: { type: string; id: string },
  payload: Record<string, unknown> = {},
): Promise<void> {
  await audit(tx, tenantId, actor, eventType, subject, payload);
  await emit(tx, tenantId, actor, eventType, subject, payload);
}

export function requireRole(actor: Actor, roles: readonly string[], what: string): void {
  if (actor.type !== 'user') throw forbidden(`${what} requires a human user`);
  if (!actor.roles.some((r) => roles.includes(r))) throw forbidden(`${what} requires one of roles: ${roles.join(', ')}`);
}

export function requireMfa(actor: Actor, what: string): void {
  if (!actor.mfaVerified) throw forbidden(`${what} requires a multi-factor authenticated session`, { code: 'MFA_REQUIRED' });
}

export const ADMIN_ROLES = ['owner', 'admin'] as const;

export function hoursBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 3_600_000;
}

export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%$€£.,\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
