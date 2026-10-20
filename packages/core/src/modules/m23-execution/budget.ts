import { budgetReservations, rateLimitBuckets, type Tx } from '@futuregrow/db';
import { and, eq, sql } from 'drizzle-orm';

/** Serialise budget decisions per tenant so concurrent actions cannot oversubscribe a ceiling. */
export async function lockTenantBudget(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`budget:${tenantId}`}, 0))`);
}

export async function holdReservation(tx: Tx, args: { tenantId: string; actionId: string; connectionId: string | null; currency: string; amountMicros: number; now: Date }): Promise<void> {
  await tx.insert(budgetReservations).values({ tenantId: args.tenantId, actionId: args.actionId, connectionId: args.connectionId, currency: args.currency, amountMicros: args.amountMicros, createdAt: args.now }).onConflictDoNothing();
}

export async function settleReservation(tx: Tx, actionId: string, to: 'committed' | 'released'): Promise<void> {
  await tx
    .update(budgetReservations)
    .set({ status: to, settledAt: new Date() })
    .where(and(eq(budgetReservations.actionId, actionId), eq(budgetReservations.status, 'held')));
}

/**
 * Token bucket persisted in PostgreSQL (no Redis; tech stack). Returns 0 when a token was taken,
 * otherwise the milliseconds to wait before one becomes available.
 */
export async function takeToken(tx: Tx, args: { tenantId: string; key: string; capacity: number; refillPerSecond: number; now: Date }): Promise<number> {
  await tx.insert(rateLimitBuckets).values({ tenantId: args.tenantId, bucketKey: args.key, tokens: args.capacity, capacity: args.capacity, refillPerSecond: args.refillPerSecond, updatedAt: args.now }).onConflictDoNothing();
  const [b] = await tx
    .select()
    .from(rateLimitBuckets)
    .where(and(eq(rateLimitBuckets.tenantId, args.tenantId), eq(rateLimitBuckets.bucketKey, args.key)))
    .for('update');
  if (!b) throw new Error('rate limit bucket missing');
  const elapsed = Math.max(0, (args.now.getTime() - b.updatedAt.getTime()) / 1000);
  const tokens = Math.min(args.capacity, b.tokens + elapsed * args.refillPerSecond);
  if (tokens >= 1) {
    await tx
      .update(rateLimitBuckets)
      .set({ tokens: tokens - 1, capacity: args.capacity, refillPerSecond: args.refillPerSecond, updatedAt: args.now })
      .where(and(eq(rateLimitBuckets.tenantId, args.tenantId), eq(rateLimitBuckets.bucketKey, args.key)));
    return 0;
  }
  await tx
    .update(rateLimitBuckets)
    .set({ tokens, updatedAt: args.now })
    .where(and(eq(rateLimitBuckets.tenantId, args.tenantId), eq(rateLimitBuckets.bucketKey, args.key)));
  return Math.ceil(((1 - tokens) / args.refillPerSecond) * 1000);
}
