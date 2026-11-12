import { type DbOrTx, growthOperations, withTenant } from '@futuregrow/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { CoreDeps } from '../../deps.js';
import { clipText } from '../../util.js';

export interface OperationOutcome<T extends Record<string, unknown>> {
  status: 'completed' | 'skipped' | 'failed';
  operationId: string;
  /** True when a completed earlier run with the same key was returned instead of running again. */
  reused: boolean;
  result: T | null;
  error?: string;
}

/**
 * Durable, idempotent background operation (scans, preparations, syncs). The idempotency key is
 * claimed in the database first: a completed key returns its stored result; a key another worker
 * holds under a live lease is skipped; an expired lease (worker crash/restart) or a failed run is
 * taken over and retried. State survives restarts because it lives in `growth_operations`.
 */
export async function runOperation<T extends Record<string, unknown>>(deps: CoreDeps, tenantId: string, args: { kind: string; idempotencyKey: string; brandId?: string | null; input?: Record<string, unknown>; leaseMs?: number; maxAttempts?: number }, fn: () => Promise<T>): Promise<OperationOutcome<T>> {
  const now = deps.clock.now();
  const leaseUntil = new Date(now.getTime() + (args.leaseMs ?? 10 * 60_000));
  const ctx = { tenantId, actor: 'system:growth-warfare' };
  const claim = await withTenant(deps.db, ctx, async (tx) => {
    const [fresh] = await tx
      .insert(growthOperations)
      .values({ tenantId, brandId: args.brandId ?? null, kind: args.kind, idempotencyKey: args.idempotencyKey, status: 'running', leaseUntil, input: args.input ?? {}, startedAt: now })
      .onConflictDoNothing()
      .returning();
    if (fresh) return { kind: 'run' as const, id: fresh.id };
    const [row] = await tx
      .select()
      .from(growthOperations)
      .where(and(eq(growthOperations.tenantId, tenantId), eq(growthOperations.idempotencyKey, args.idempotencyKey)))
      .for('update');
    if (!row) return { kind: 'skip' as const, id: '' };
    if (row.status === 'completed' || row.status === 'skipped') return { kind: 'done' as const, id: row.id, result: row.result as T };
    if (row.status === 'running' && row.leaseUntil && row.leaseUntil > now) return { kind: 'skip' as const, id: row.id };
    if (row.attempts >= (args.maxAttempts ?? 5)) return { kind: 'gave_up' as const, id: row.id, error: row.error ?? 'too many attempts' };
    await tx
      .update(growthOperations)
      .set({ status: 'running', leaseUntil, attempts: sql`${growthOperations.attempts} + 1`, error: null, startedAt: now })
      .where(eq(growthOperations.id, row.id));
    return { kind: 'run' as const, id: row.id };
  });
  if (claim.kind === 'done') return { status: 'completed', operationId: claim.id, reused: true, result: claim.result };
  if (claim.kind === 'skip') return { status: 'skipped', operationId: claim.id, reused: false, result: null };
  if (claim.kind === 'gave_up') return { status: 'failed', operationId: claim.id, reused: false, result: null, error: claim.error };
  try {
    const result = await fn();
    await withTenant(deps.db, ctx, (tx) => tx.update(growthOperations).set({ status: 'completed', result, leaseUntil: null, finishedAt: deps.clock.now() }).where(eq(growthOperations.id, claim.id)));
    return { status: 'completed', operationId: claim.id, reused: false, result };
  } catch (err) {
    const error = clipText(err instanceof Error ? err.message : String(err), 2000);
    await withTenant(deps.db, ctx, (tx) => tx.update(growthOperations).set({ status: 'failed', error, leaseUntil: null, finishedAt: deps.clock.now() }).where(eq(growthOperations.id, claim.id)));
    deps.logger.warn({ tenantId, kind: args.kind, key: args.idempotencyKey, error }, 'growth operation failed');
    return { status: 'failed', operationId: claim.id, reused: false, result: null, error };
  }
}

export async function listOperations(tx: DbOrTx, limit = 50) {
  return tx.select().from(growthOperations).orderBy(desc(growthOperations.startedAt)).limit(limit);
}
