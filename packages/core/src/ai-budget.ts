import { AbstainError, type PlannedCall } from '@futuregrow/agent-kernel';
import { type Db, type DbOrTx, withTenant } from '@futuregrow/db';
import { sql } from 'drizzle-orm';
import type { CoreConfig } from './deps.js';
import { getTenantPolicy, raiseAlert } from './modules/m24-governance/index.js';

/**
 * Per-tenant AI spending limits (FG-P2-001). Spend is the month-to-date (UTC) sum of the cost
 * ledger's llm/embedding rows at registry prices. Before every model attempt the gateway asks
 * `guardAiCall` with the attempt's upper-bound cost; the call is refused (the agent abstains)
 * when spent + in-flight reservations + this bound would exceed the limit. With a limit in force
 * an unpriced model or unpriced ledger rows make spend unmeasurable, so calls are refused rather
 * than estimated. Reservations are per process: concurrent calls in another process can overshoot
 * by at most their own bounds.
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

const reservations = new Map<string, number>();
const held = new WeakMap<PlannedCall, { tenantId: string; amount: number }>();

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getAiBudget(tx: DbOrTx, tenantId: string, config: Pick<CoreConfig, 'aiSpendDefaultMonthlyUsd'>, now = new Date()): Promise<AiBudget> {
  const policy = (await getTenantPolicy(tx, tenantId)).aiSpend;
  const limitUsd = policy?.monthlyLimitUsd ?? config.aiSpendDefaultMonthlyUsd;
  const start = monthStart(now);
  const r = await tx.execute<{ spent: number | null; unpriced: number }>(sql`
    select coalesce(sum(amount_usd), 0)::float8 as spent, count(*) filter (where amount_usd is null)::int as unpriced
    from cost_ledger where tenant_id = ${tenantId} and category in ('llm', 'embedding') and occurred_at >= ${start}`);
  const spentUsd = r.rows[0]?.spent ?? 0;
  const reservedUsd = reservations.get(tenantId) ?? 0;
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

/** Throws AbstainError (BUDGET_EXCEEDED / BUDGET_UNMEASURABLE) or reserves the call's bound. */
export async function guardAiCall(db: Db, config: Pick<CoreConfig, 'aiSpendDefaultMonthlyUsd'>, tenantId: string, call: PlannedCall, now = new Date()): Promise<void> {
  const decision = await withTenant(db, { tenantId, actor: 'system:ai-budget' }, async (tx) => {
    const b = await getAiBudget(tx, tenantId, config, now);
    if (b.limitUsd === null) return { ok: true as const, amount: 0 };
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
    return { ok: true as const, amount: call.maxCostUsd };
  });
  if (!decision.ok) throw new AbstainError(decision.reason, decision.message);
  if (decision.amount > 0) {
    reservations.set(tenantId, (reservations.get(tenantId) ?? 0) + decision.amount);
    held.set(call, { tenantId, amount: decision.amount });
  }
}

export function releaseAiCall(call: PlannedCall): void {
  const h = held.get(call);
  if (!h) return;
  held.delete(call);
  const left = (reservations.get(h.tenantId) ?? 0) - h.amount;
  if (left > 1e-12) reservations.set(h.tenantId, left);
  else reservations.delete(h.tenantId);
}
