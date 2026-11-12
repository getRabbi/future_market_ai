import os from 'node:os';
import { AbstainError, type PlannedCall } from '@futuregrow/agent-kernel';
import { aiSpendReservations, type Db, type DbOrTx, withTenant } from '@futuregrow/db';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { CoreConfig } from './deps.js';
import { getTenantPolicy, raiseAlert } from './modules/m24-governance/index.js';

/**
 * Per-tenant AI spending limits (FG-P2-001). Spend is the month-to-date (UTC) sum of the cost
 * ledger's llm/embedding rows at registry prices. Before every model attempt the gateway asks
 * `guardAiCall` with the attempt's upper-bound cost; the call is refused (the agent abstains)
 * when spent + in-flight reservations + this bound would exceed the limit. With a limit in force
 * an unpriced model or unpriced ledger rows make spend unmeasurable, so calls are refused rather
 * than estimated.
 *
 * D-054: reservations are durable rows in `ai_spend_reservations`, taken under a per-tenant
 * transaction advisory lock, so the api, the worker and the jobs (separate processes) share one
 * view of what is in flight and together cannot exceed the limit. A reservation is deleted when
 * its attempt finishes (the real cost is in the ledger by then); one left behind by a crashed
 * process stops counting after RESERVATION_TTL_MS.
 */
export interface AiBudget {
  limitUsd: number | null;
  source: 'tenant' | 'platform' | 'none';
  warnAtFraction: number;
  periodStart: string;
  spentUsd: number;
  unpricedCalls: number;
  reservedUsd: number;
  remainingUsd: number | null;
}

/** Longer than any model attempt (provider timeouts are minutes), short enough to self-heal. */
export const RESERVATION_TTL_MS = 15 * 60_000;
/** Advisory-lock namespace ('FG', 2); the second key is hashtext(tenant id). */
export const AI_BUDGET_LOCK = 0x46470002;
const HOLDER = `${os.hostname()}:${process.pid}`;

const held = new WeakMap<PlannedCall, { db: Db; tenantId: string; id: string }>();

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getAiBudget(tx: DbOrTx, tenantId: string, config: Pick<CoreConfig, 'aiSpendDefaultMonthlyUsd'>, now = new Date()): Promise<AiBudget> {
  const policy = (await getTenantPolicy(tx, tenantId)).aiSpend;
  const limitUsd = policy?.monthlyLimitUsd ?? config.aiSpendDefaultMonthlyUsd;
  const start = monthStart(now);
  const r = await tx.execute<{ spent: number | null; unpriced: number }>(sql`
    select coalesce(sum(amount_usd), 0)::float8 as spent, count(*) filter (where amount_usd is null)::int as unpriced
    from cost_ledger where tenant_id = ${tenantId} and category in ('llm', 'embedding', 'image_generation', 'speech_generation', 'video_generation') and occurred_at >= ${start}`);
  const pending = await tx.execute<{ reserved: number }>(sql`select coalesce(sum(cost_usd), 0)::float8 as reserved from media_jobs where tenant_id = ${tenantId} and kind = 'ai_video' and (status in ('queued','running') or provenance->>'billingUnresolved' = 'true')`);
  const inFlight = await tx.execute<{ reserved: number }>(sql`select coalesce(sum(amount_usd), 0)::float8 as reserved from ai_spend_reservations where tenant_id = ${tenantId} and expires_at > ${now}`);
  const spentUsd = r.rows[0]?.spent ?? 0;
  const reservedUsd = (inFlight.rows[0]?.reserved ?? 0) + (pending.rows[0]?.reserved ?? 0);
  return {
    limitUsd: limitUsd ?? null,
    source: policy ? 'tenant' : limitUsd ? 'platform' : 'none',
    warnAtFraction: policy?.warnAtFraction ?? 0.8,
    periodStart: start.toISOString(),
    spentUsd,
    unpricedCalls: r.rows[0]?.unpriced ?? 0,
    reservedUsd,
    remainingUsd: limitUsd ? Math.max(0, limitUsd - spentUsd - reservedUsd) : null,
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Throws AbstainError (BUDGET_EXCEEDED / BUDGET_UNMEASURABLE) or reserves the call's bound.
 * The check and the reservation run in one transaction holding the tenant's budget lock, so two
 * processes can never both see the same remaining headroom.
 */
export async function guardAiCall(db: Db, config: Pick<CoreConfig, 'aiSpendDefaultMonthlyUsd'>, tenantId: string, call: PlannedCall, now = new Date()): Promise<void> {
  const decision = await withTenant(db, { tenantId, actor: 'system:ai-budget' }, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AI_BUDGET_LOCK}::int4, hashtext(${tenantId}))`);
    const b = await getAiBudget(tx, tenantId, config, now);
    if (b.limitUsd === null) return { ok: true as const, reservationId: null };
    const month = b.periodStart.slice(0, 7);
    if (call.maxCostUsd === null || b.unpricedCalls > 0) {
      return {
        ok: false as const,
        reason: 'BUDGET_UNMEASURABLE' as const,
        message: call.maxCostUsd === null ? `${call.provider}/${call.modelId} has no registry price, so spend against the ${usd(b.limitUsd)} monthly limit cannot be bounded` : `${b.unpricedCalls} unpriced model call(s) this month make spend against the limit unmeasurable`,
      };
    }
    const projected = b.spentUsd + b.reservedUsd + call.maxCostUsd;
    if (projected > b.limitUsd) {
      await raiseAlert(tx, tenantId, {
        kind: 'ai_budget_exceeded',
        severity: 'critical',
        message: `AI spending limit reached: ${usd(b.spentUsd)} of ${usd(b.limitUsd)} used this month; model calls are paused until the limit is raised or the month ends.`,
        refs: { limitUsd: b.limitUsd, spentUsd: b.spentUsd, month },
        dedupKey: `ai-budget-exceeded:${month}`,
      });
      return { ok: false as const, reason: 'BUDGET_EXCEEDED' as const, message: `monthly AI limit ${usd(b.limitUsd)}: ${usd(b.spentUsd)} spent, ${usd(b.reservedUsd)} in flight, this call may cost up to ${usd(call.maxCostUsd)}` };
    }
    if (projected >= b.warnAtFraction * b.limitUsd) {
      await raiseAlert(tx, tenantId, { kind: 'ai_budget_warning', severity: 'warning', message: `AI spend is at ${Math.round((projected / b.limitUsd) * 100)}% of the ${usd(b.limitUsd)} monthly limit.`, refs: { limitUsd: b.limitUsd, spentUsd: b.spentUsd, month }, dedupKey: `ai-budget-warning:${month}` });
    }
    // Housekeeping: reservations a crashed process left behind a day ago.
    await tx.delete(aiSpendReservations).where(and(eq(aiSpendReservations.tenantId, tenantId), lt(aiSpendReservations.expiresAt, new Date(now.getTime() - 86_400_000))));
    if (call.maxCostUsd <= 0) return { ok: true as const, reservationId: null };
    const [row] = await tx
      .insert(aiSpendReservations)
      .values({ tenantId, amountUsd: call.maxCostUsd, provider: call.provider, modelId: call.modelId, purpose: call.purpose, holder: HOLDER, expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS) })
      .returning({ id: aiSpendReservations.id });
    return { ok: true as const, reservationId: row!.id };
  });
  if (!decision.ok) throw new AbstainError(decision.reason, decision.message);
  if (decision.reservationId) held.set(call, { db, tenantId, id: decision.reservationId });
}

/**
 * Release a call's reservation. Never throws: if the database is unreachable the reservation
 * simply expires, which only makes the guard more conservative for a few minutes.
 */
export async function releaseAiCall(call: PlannedCall): Promise<void> {
  const h = held.get(call);
  if (!h) return;
  held.delete(call);
  try {
    await withTenant(h.db, { tenantId: h.tenantId, actor: 'system:ai-budget' }, (tx) => tx.delete(aiSpendReservations).where(eq(aiSpendReservations.id, h.id)));
  } catch {
    /* expires after RESERVATION_TTL_MS */
  }
}

/** In-flight reservations of a tenant (diagnostics, Control Room readiness). */
export async function activeAiReservations(tx: DbOrTx, now = new Date()) {
  return tx.select().from(aiSpendReservations).where(gt(aiSpendReservations.expiresAt, now));
}
