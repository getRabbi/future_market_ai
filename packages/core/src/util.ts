import type { EventType } from '@futuregrow/contracts';
import { appendAudit, type Tx } from '@futuregrow/db';
import { emitEvent } from '@futuregrow/events';
import { forbidden } from '@futuregrow/observability';
import type { Actor } from './deps.js';

export async function audit(tx: Tx, tenantId: string, actor: Actor, action: string, subject: { type: string; id: string }, payload: Record<string, unknown> = {}): Promise<void> {
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

export async function emit(tx: Tx, tenantId: string, actor: Actor, eventType: EventType, aggregate: { type: string; id: string }, payload: Record<string, unknown>, causationId?: string | null) {
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
export async function record(tx: Tx, tenantId: string, actor: Actor, eventType: EventType, subject: { type: string; id: string }, payload: Record<string, unknown> = {}): Promise<void> {
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

/**
 * Cut text to at most `max` UTF-16 code units without splitting a surrogate pair. A plain
 * `slice` can leave half an emoji, which PostgreSQL rejects inside json/jsonb values.
 */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return wellFormed(s);
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return wellFormed(last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A string with every lone surrogate replaced by U+FFFD (String.prototype.toWellFormed). */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, '�');
}

/** Replace lone surrogates anywhere in a JSON-bound value so a jsonb write cannot fail on them. */
export function wellFormedJson<T>(value: T): T {
  if (typeof value === 'string') return wellFormed(value) as T;
  if (Array.isArray(value)) return value.map((v) => wellFormedJson(v)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([k, v]) => [wellFormed(k), wellFormedJson(v)])) as T;
  return value;
}

export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%$€£.,\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
