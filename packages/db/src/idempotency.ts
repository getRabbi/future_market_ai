import { and, eq } from 'drizzle-orm';
import type { Tx } from './client.js';
import { idempotencyKeys } from './schema/index.js';

export type IdempotencyBegin = { state: 'new' } | { state: 'replay'; status: number; body: unknown } | { state: 'conflict' } | { state: 'in_progress' };

const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_RE.test(key);
}

/**
 * Claim an idempotency key inside the caller's tenant transaction. Because the claim row is part
 * of the same transaction as the side effect, a crash rolls both back and the client may retry;
 * a concurrent duplicate blocks on the primary key until the first commits and then replays.
 */
export async function beginIdempotent(tx: Tx, args: { tenantId: string; scope: string; key: string; requestHash: string; ttlHours?: number }): Promise<IdempotencyBegin> {
  const expiresAt = new Date(Date.now() + (args.ttlHours ?? 72) * 3_600_000);
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({
      tenantId: args.tenantId,
      scope: args.scope,
      key: args.key,
      requestHash: args.requestHash,
      status: 'in_progress',
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length === 1) return { state: 'new' };

  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.tenantId, args.tenantId), eq(idempotencyKeys.scope, args.scope), eq(idempotencyKeys.key, args.key)));
  if (!existing) return { state: 'in_progress' };
  if (existing.requestHash !== args.requestHash) return { state: 'conflict' };
  if (existing.status === 'completed') {
    return { state: 'replay', status: existing.responseStatus ?? 200, body: existing.responseBody };
  }
  return { state: 'in_progress' };
}

export async function completeIdempotent(tx: Tx, args: { tenantId: string; scope: string; key: string; status: number; body: unknown }): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ status: 'completed', responseStatus: args.status, responseBody: args.body })
    .where(and(eq(idempotencyKeys.tenantId, args.tenantId), eq(idempotencyKeys.scope, args.scope), eq(idempotencyKeys.key, args.key)));
}
