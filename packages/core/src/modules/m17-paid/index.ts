import { READ_CONNECTORS, type SpendRow } from '@futuregrow/connectors';
import { type actionRequests, adBudgetHistory, adCampaigns, adDailyMetrics, type DbOrTx, spendLedger, spendReconciliations, type Tx, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { record, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { proposeAction } from '../m23-execution/gateway.js';
import { registerHooks } from '../m23-execution/registry.js';
import { raiseAlert } from '../m24-governance/index.js';

const PLATFORM_BY_PROVIDER = { google_ads: 'google_ads', meta: 'meta' } as const;
type AdProvider = keyof typeof PLATFORM_BY_PROVIDER;

/**
 * Days whose provider-reported spend is treated as settled. Google Ads and Meta both restate
 * recent days (late conversions, invalid-click credits); only settled days enter the
 * append-only spend ledger. Newer days live in ad_daily_metrics, which is overwritten.
 */
export const SETTLEMENT_LAG_DAYS = 3;

/** Google Ads may spend up to 2x the average daily budget on a single day (documented overdelivery). */
export const MAX_DAILY_OVERDELIVERY = 2;

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

function adProvider(p: string): AdProvider {
  if (p !== 'google_ads' && p !== 'meta') throw invalid(`${p} is not an ads connection`);
  return p;
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

/**
 * Pull campaigns from the provider. Budget changes that FUTUREGROW did not make (no VERIFIED
 * action explains them) are recorded as external changes and raise a drift alert.
 */
export async function syncCampaigns(deps: CoreDeps, tenantId: string, connectionId: string) {
  const { connection, ctx } = await readContext(deps, tenantId, connectionId);
  const provider = adProvider(connection.provider);
  const reader = READ_CONNECTORS[provider];
  if (!reader?.listCampaigns) throw invalid(`${provider} cannot list campaigns`);
  const snapshots = await reader.listCampaigns(ctx);
  const now = deps.clock.now();
  const actor = systemActor('paid-media-sync');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const ev = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'api_response',
      sourceType: 'primary',
      owner: provider,
      uri: `${provider}://${connection.externalAccountId}/campaigns@${now.toISOString()}`,
      content: { campaigns: snapshots.map((s) => ({ id: s.externalCampaignId, status: s.status, dailyBudgetMicros: s.dailyBudgetMicros, currency: s.currency })) },
      summary: `${snapshots.length} campaigns synced from ${provider}`,
      confidence: 1,
      license: `${provider} API terms (authorized account data)`,
      permittedUses: ['analytics', 'autonomous_execution', 'causal_measurement'],
      externalPlatformTerms: provider,
      freshnessSlaHours: 24,
      now,
    });
    let drift = 0;
    for (const s of snapshots) {
      const [prev] = await tx
        .select()
        .from(adCampaigns)
        .where(and(eq(adCampaigns.connectionId, connectionId), eq(adCampaigns.externalCampaignId, s.externalCampaignId)));
      const [row] = await tx
        .insert(adCampaigns)
        .values({ tenantId, connectionId, platform: PLATFORM_BY_PROVIDER[provider], externalCampaignId: s.externalCampaignId, externalBudgetId: s.externalBudgetId, name: s.name, status: s.status, dailyBudgetMicros: s.dailyBudgetMicros, currency: s.currency, objective: s.objective, raw: s.raw, lastSyncedAt: now })
        .onConflictDoUpdate({
          target: [adCampaigns.tenantId, adCampaigns.connectionId, adCampaigns.externalCampaignId],
          set: { externalBudgetId: s.externalBudgetId, name: s.name, status: s.status, dailyBudgetMicros: s.dailyBudgetMicros, currency: s.currency, objective: s.objective, raw: s.raw, lastSyncedAt: now },
        })
        .returning();
      if (s.dailyBudgetMicros === null || !s.currency) continue;
      if (!prev) {
        await tx.insert(adBudgetHistory).values({ tenantId, campaignId: row!.id, effectiveFrom: now, dailyBudgetMicros: s.dailyBudgetMicros, currency: s.currency, source: 'sync' });
      } else if (prev.dailyBudgetMicros !== s.dailyBudgetMicros) {
        // Does a verified action explain the new value? (Its hook already wrote history.)
        const [latest] = await tx.select().from(adBudgetHistory).where(eq(adBudgetHistory.campaignId, row!.id)).orderBy(desc(adBudgetHistory.effectiveFrom)).limit(1);
        if (latest?.dailyBudgetMicros !== s.dailyBudgetMicros) {
          drift++;
          await tx.insert(adBudgetHistory).values({ tenantId, campaignId: row!.id, effectiveFrom: now, dailyBudgetMicros: s.dailyBudgetMicros, currency: s.currency, source: 'external_change' });
          await raiseAlert(tx, tenantId, {
            kind: 'ads.budget.external_change',
            severity: 'warning',
            message: `Budget of ${s.name} changed outside FUTUREGROW: ${prev.dailyBudgetMicros} → ${s.dailyBudgetMicros} micros ${s.currency}`,
            refs: { campaignId: row!.id, evidenceId: ev.evidenceId },
            dedupKey: `budget-drift:${row!.id}:${s.dailyBudgetMicros}`,
          });
        }
      }
    }
    await record(tx, tenantId, actor, 'ads.campaigns.synced', { type: 'connection', id: connectionId }, { count: snapshots.length, drift, evidenceId: ev.evidenceId });
    return { campaigns: snapshots.length, externalBudgetChanges: drift, evidenceId: ev.evidenceId };
  });
}

/**
 * Pull daily spend. All fetched days update ad_daily_metrics; settled days are appended to the
 * spend ledger once. A settled day the provider later restates produces a discrepancy alert
 * instead of a silent ledger edit (the ledger is append-only).
 */
export async function syncSpend(deps: CoreDeps, tenantId: string, connectionId: string, range?: { from: string; to: string }) {
  const { connection, ctx } = await readContext(deps, tenantId, connectionId);
  const provider = adProvider(connection.provider);
  const reader = READ_CONNECTORS[provider];
  if (!reader?.fetchSpend) throw invalid(`${provider} cannot report spend`);
  const now = deps.clock.now();
  const from = range?.from ?? day(addDays(now, -14));
  const to = range?.to ?? day(addDays(now, -1));
  const rows = await reader.fetchSpend(ctx, from, to);
  const settledThrough = day(addDays(now, -SETTLEMENT_LAG_DAYS));
  const actor = systemActor('paid-media-sync');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const ev = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'metric',
      sourceType: 'primary',
      owner: provider,
      uri: `${provider}://${connection.externalAccountId}/spend/${from}..${to}@${now.toISOString()}`,
      content: { from, to, rows },
      summary: `${rows.length} campaign-day spend rows from ${provider} (${from}..${to})`,
      confidence: 1,
      license: `${provider} API terms (authorized account data)`,
      permittedUses: ['analytics', 'forecasting', 'causal_measurement', 'autonomous_execution'],
      externalPlatformTerms: provider,
      freshnessSlaHours: 36,
      now,
    });
    const campaigns = await tx.select({ id: adCampaigns.id, ext: adCampaigns.externalCampaignId }).from(adCampaigns).where(eq(adCampaigns.connectionId, connectionId));
    const byExt = new Map(campaigns.map((c) => [c.ext, c.id]));
    let unknown = 0;
    let ledgered = 0;
    let restated = 0;
    for (const r of rows) {
      const campaignId = byExt.get(r.campaignRef);
      if (!campaignId) {
        unknown++;
        continue;
      }
      await tx
        .insert(adDailyMetrics)
        .values({ tenantId, campaignId, date: r.date, impressions: r.impressions, clicks: r.clicks, costMicros: r.costMicros, conversions: r.conversions, conversionValueMicros: r.conversionValueMicros, evidenceId: ev.evidenceId, fetchedAt: now })
        .onConflictDoUpdate({
          target: [adDailyMetrics.campaignId, adDailyMetrics.date],
          set: { impressions: r.impressions, clicks: r.clicks, costMicros: r.costMicros, conversions: r.conversions, conversionValueMicros: r.conversionValueMicros, evidenceId: ev.evidenceId, fetchedAt: now },
        });
      if (r.date > settledThrough) continue;
      const inserted = await tx
        .insert(spendLedger)
        .values({ tenantId, connectionId, campaignRef: r.campaignRef, spendDate: r.date, currency: r.currency, amountMicros: r.costMicros, source: 'provider_report', reportRef: `${from}..${to}`, evidenceId: ev.evidenceId })
        .onConflictDoNothing()
        .returning({ id: spendLedger.id });
      if (inserted.length) {
        ledgered++;
        continue;
      }
      const [existing] = await tx
        .select()
        .from(spendLedger)
        .where(and(eq(spendLedger.connectionId, connectionId), eq(spendLedger.campaignRef, r.campaignRef), eq(spendLedger.spendDate, r.date), eq(spendLedger.source, 'provider_report')));
      if (existing && (existing.amountMicros !== r.costMicros || existing.currency !== r.currency)) {
        restated++;
        await raiseAlert(tx, tenantId, {
          kind: 'ads.spend.restated',
          severity: 'warning',
          message: `${provider} restated settled spend for campaign ${r.campaignRef} on ${r.date}: ledger ${existing.amountMicros} vs report ${r.costMicros} ${r.currency}`,
          refs: { connectionId, campaignRef: r.campaignRef, date: r.date, evidenceId: ev.evidenceId },
          dedupKey: `spend-restated:${connectionId}:${r.campaignRef}:${r.date}:${r.costMicros}`,
        });
      }
    }
    if (unknown) {
      await raiseAlert(tx, tenantId, { kind: 'ads.spend.unknown_campaign', severity: 'info', message: `${unknown} spend rows reference campaigns that have not been synced yet`, refs: { connectionId }, dedupKey: `spend-unknown:${connectionId}:${to}` });
    }
    await record(tx, tenantId, actor, 'ads.spend.synced', { type: 'connection', id: connectionId }, { from, to, rows: rows.length, ledgered, restated, unknown, evidenceId: ev.evidenceId });
    return { rows: rows.length, ledgered, restated, unknownCampaigns: unknown, evidenceId: ev.evidenceId };
  });
}

/* ------------------------------------------------------------------ */
/* Reconciliation (M24 spend reconciliation)                          */
/* ------------------------------------------------------------------ */

interface BudgetPoint {
  effectiveFrom: Date;
  dailyBudgetMicros: number;
  currency: string;
}

/** Budget in effect at the end of `date` (UTC), or null when nothing was known by then. */
export function budgetOn(history: BudgetPoint[], date: string): BudgetPoint | null {
  const end = new Date(`${date}T23:59:59.999Z`).getTime();
  let cur: BudgetPoint | null = null;
  for (const h of history) if (h.effectiveFrom.getTime() <= end) cur = h;
  return cur;
}

export interface ReconcileResult {
  status: 'ok' | 'discrepancy' | 'insufficient_data';
  authorizedMicros: number;
  reportedMicros: number;
  deltaMicros: number;
  currency: string;
  findings: { campaignRef: string; date?: string; code: string; detail: string }[];
}

/**
 * Pure reconciliation: reported spend vs the authorized envelope (daily budget in effect per
 * day). A period is a discrepancy when total reported spend exceeds the total envelope by more
 * than `tolerance` (fraction), when one day exceeds MAX_DAILY_OVERDELIVERY × its budget, or when
 * currencies disagree. Unknown budgets make the result insufficient_data — never "ok".
 */
export function reconcile(spend: { campaignRef: string; date: string; currency: string; amountMicros: number }[], budgets: Map<string, BudgetPoint[]>, tolerance: number): ReconcileResult {
  const findings: ReconcileResult['findings'] = [];
  const currencies = new Set(spend.map((s) => s.currency));
  let authorized = 0;
  let reported = 0;
  let reportedKnown = 0;
  let unknown = false;
  for (const s of spend) {
    reported += s.amountMicros;
    const b = budgetOn(budgets.get(s.campaignRef) ?? [], s.date);
    if (!b) {
      if (s.amountMicros > 0) {
        unknown = true;
        findings.push({ campaignRef: s.campaignRef, date: s.date, code: 'BUDGET_UNKNOWN', detail: 'spend on a day with no known budget' });
      }
      continue;
    }
    if (b.currency !== s.currency) findings.push({ campaignRef: s.campaignRef, date: s.date, code: 'CURRENCY_MISMATCH', detail: `${s.currency} spend vs ${b.currency} budget` });
    authorized += b.dailyBudgetMicros;
    reportedKnown += s.amountMicros;
    if (s.amountMicros > b.dailyBudgetMicros * MAX_DAILY_OVERDELIVERY) {
      findings.push({ campaignRef: s.campaignRef, date: s.date, code: 'DAILY_OVERDELIVERY', detail: `${s.amountMicros} > ${MAX_DAILY_OVERDELIVERY}× budget ${b.dailyBudgetMicros}` });
    }
  }
  if (currencies.size > 1) findings.push({ campaignRef: '*', code: 'MIXED_CURRENCIES', detail: [...currencies].join(',') });
  // Overspend is judged only where the envelope is known; unknown days make the result insufficient.
  const delta = reported - authorized;
  if (reportedKnown - authorized > authorized * tolerance) findings.push({ campaignRef: '*', code: 'PERIOD_OVERSPEND', detail: `reported ${reported} exceeds authorized ${authorized} by ${delta}` });
  const hard = findings.some((f) => f.code !== 'BUDGET_UNKNOWN');
  const status = hard ? 'discrepancy' : unknown || spend.length === 0 ? 'insufficient_data' : 'ok';
  return { status, authorizedMicros: authorized, reportedMicros: reported, deltaMicros: delta, currency: [...currencies][0] ?? 'XXX', findings };
}

export async function reconcileSpend(deps: CoreDeps, tenantId: string, connectionId: string, period: { start: string; end: string }, tolerance = 0.02) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.start) || !/^\d{4}-\d{2}-\d{2}$/.test(period.end) || period.start > period.end) throw invalid('invalid period');
  const actor = systemActor('spend-reconciliation');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const spend = await tx
      .select({ campaignRef: spendLedger.campaignRef, date: spendLedger.spendDate, currency: spendLedger.currency, amountMicros: spendLedger.amountMicros })
      .from(spendLedger)
      .where(and(eq(spendLedger.connectionId, connectionId), gte(spendLedger.spendDate, period.start), lte(spendLedger.spendDate, period.end)));
    const camps = await tx.select().from(adCampaigns).where(eq(adCampaigns.connectionId, connectionId));
    const hist = camps.length
      ? await tx
          .select()
          .from(adBudgetHistory)
          .where(
            inArray(
              adBudgetHistory.campaignId,
              camps.map((c) => c.id),
            ),
          )
          .orderBy(asc(adBudgetHistory.effectiveFrom))
      : [];
    const extById = new Map(camps.map((c) => [c.id, c.externalCampaignId]));
    const budgets = new Map<string, BudgetPoint[]>();
    for (const h of hist) {
      const ext = extById.get(h.campaignId)!;
      budgets.set(ext, [...(budgets.get(ext) ?? []), h]);
    }
    const r = reconcile(spend, budgets, tolerance);
    const [row] = await tx
      .insert(spendReconciliations)
      .values({ tenantId, connectionId, periodStart: period.start, periodEnd: period.end, currency: r.currency, authorizedMicros: r.authorizedMicros, reportedMicros: r.reportedMicros, deltaMicros: r.deltaMicros, status: r.status, details: { findings: r.findings, tolerance, rows: spend.length } })
      .returning();
    if (r.status !== 'ok') {
      await raiseAlert(tx, tenantId, {
        kind: r.status === 'discrepancy' ? 'governance.spend.discrepancy' : 'governance.spend.insufficient_data',
        severity: r.status === 'discrepancy' ? 'critical' : 'warning',
        message: `Spend reconciliation ${period.start}..${period.end}: ${r.status} (${r.findings.map((f) => f.code).join(', ') || 'no settled spend'})`,
        refs: { reconciliationId: row!.id, connectionId },
        dedupKey: `spend-recon:${connectionId}:${period.start}:${period.end}:${r.status}`,
      });
    }
    if (r.status === 'discrepancy') {
      await record(tx, tenantId, actor, 'governance.spend.discrepancy_detected', { type: 'spend_reconciliation', id: row!.id }, { connectionId, deltaMicros: r.deltaMicros, findings: r.findings.slice(0, 20) });
    }
    return row!;
  });
}

/* ------------------------------------------------------------------ */
/* Proposals (all writes go through M23)                              */
/* ------------------------------------------------------------------ */

export const BudgetProposalSchema = z.object({
  newDailyBudgetMicros: z.number().int().positive(),
  geographies: z.array(z.string().min(2)).default([]),
  evidenceIds: z.array(z.string().uuid()).default([]),
  rationale: z.string().min(10).max(2000),
});

async function loadCampaign(deps: CoreDeps, tenantId: string, actor: Actor, id: string) {
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [c] = await tx.select().from(adCampaigns).where(eq(adCampaigns.id, id));
    if (!c) throw notFound('campaign');
    return c;
  });
}

export async function proposeBudgetChange(deps: CoreDeps, tenantId: string, actor: Actor, campaignId: string, raw: unknown) {
  const input = BudgetProposalSchema.parse(raw);
  const c = await loadCampaign(deps, tenantId, actor, campaignId);
  if (c.dailyBudgetMicros === null || !c.currency) throw invalid('campaign budget unknown; sync campaigns first');
  const prev = { amountMicros: c.dailyBudgetMicros, currency: c.currency };
  const next = { amountMicros: input.newDailyBudgetMicros, currency: c.currency };
  const common = { risk: { spendDeltaMicros: next.amountMicros - prev.amountMicros, currency: c.currency, geographies: input.geographies }, evidenceIds: input.evidenceIds, connectionId: c.connectionId, target: { campaignId: c.id, rationale: input.rationale } };
  const key = `budget:${c.id}:${prev.amountMicros}->${next.amountMicros}`;
  if (c.platform === 'google_ads') {
    if (!c.externalBudgetId) throw invalid('google ads campaign has no budget id');
    const [conn] = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => tx.execute<{ external_account_id: string }>(sql`select external_account_id from connections where id = ${c.connectionId}`)).then((r) => r.rows);
    return proposeAction(deps, tenantId, actor, {
      ...common,
      actionType: 'ads.google.update_campaign_budget',
      params: { customerId: conn!.external_account_id.replaceAll('-', ''), campaignBudgetId: c.externalBudgetId, campaignRef: c.externalCampaignId, newDailyBudget: next, previousDailyBudget: prev },
      idempotencyKey: key,
    });
  }
  return proposeAction(deps, tenantId, actor, { ...common, actionType: 'ads.meta.update_campaign_budget', params: { campaignId: c.externalCampaignId, newDailyBudget: next, previousDailyBudget: prev }, idempotencyKey: key });
}

export async function proposeStatusChange(deps: CoreDeps, tenantId: string, actor: Actor, campaignId: string, input: { status: 'PAUSED' | 'ACTIVE'; geographies?: string[]; evidenceIds?: string[]; rationale: string }) {
  const c = await loadCampaign(deps, tenantId, actor, campaignId);
  if (c.dailyBudgetMicros === null || !c.currency) throw invalid('campaign budget unknown; sync campaigns first');
  const budget = { amountMicros: c.dailyBudgetMicros, currency: c.currency };
  // Enabling a paused campaign starts spend: the reservation covers one day of budget.
  const enabling = input.status === 'ACTIVE' && c.status !== 'ENABLED' && c.status !== 'ACTIVE';
  const risk = { spendDeltaMicros: enabling ? budget.amountMicros : 0, currency: c.currency, geographies: input.geographies ?? [] };
  const key = `status:${c.id}:${c.status}->${input.status}:${deps.clock.now().toISOString().slice(0, 13)}`;
  if (c.platform === 'google_ads') {
    const [conn] = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => tx.execute<{ external_account_id: string }>(sql`select external_account_id from connections where id = ${c.connectionId}`)).then((r) => r.rows);
    const map = (s: string) => (s === 'ACTIVE' || s === 'ENABLED' ? 'ENABLED' : 'PAUSED');
    return proposeAction(deps, tenantId, actor, {
      actionType: 'ads.google.set_campaign_status',
      connectionId: c.connectionId,
      target: { campaignId: c.id, rationale: input.rationale },
      params: { customerId: conn!.external_account_id.replaceAll('-', ''), campaignId: c.externalCampaignId, status: map(input.status), previousStatus: map(c.status), dailyBudget: budget },
      risk,
      evidenceIds: input.evidenceIds ?? [],
      idempotencyKey: key,
    });
  }
  return proposeAction(deps, tenantId, actor, {
    actionType: 'ads.meta.set_campaign_status',
    connectionId: c.connectionId,
    target: { campaignId: c.id, rationale: input.rationale },
    params: { campaignId: c.externalCampaignId, status: input.status, previousStatus: c.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED', dailyBudget: budget },
    risk,
    evidenceIds: input.evidenceIds ?? [],
    idempotencyKey: key,
  });
}

/** Verified budget/status writes update local state and the authorized-envelope history. */
async function campaignFor(tx: Tx, action: typeof actionRequests.$inferSelect) {
  const id = (action.target as { campaignId?: string } | null)?.campaignId;
  if (!id) return null;
  const [c] = await tx.select().from(adCampaigns).where(eq(adCampaigns.id, id));
  return c ?? null;
}

for (const t of ['ads.google.update_campaign_budget', 'ads.meta.update_campaign_budget']) {
  registerHooks(t, {
    async onVerified(tx, action) {
      const c = await campaignFor(tx, action);
      if (!c) return;
      const next = (action.params as { newDailyBudget: { amountMicros: number; currency: string } }).newDailyBudget;
      await tx.update(adCampaigns).set({ dailyBudgetMicros: next.amountMicros }).where(eq(adCampaigns.id, c.id));
      await tx.insert(adBudgetHistory).values({ tenantId: c.tenantId, campaignId: c.id, effectiveFrom: new Date(), dailyBudgetMicros: next.amountMicros, currency: next.currency, source: 'verified_action', actionId: action.id });
    },
  });
}
for (const t of ['ads.google.set_campaign_status', 'ads.meta.set_campaign_status']) {
  registerHooks(t, {
    async onVerified(tx, action) {
      const c = await campaignFor(tx, action);
      if (!c) return;
      await tx
        .update(adCampaigns)
        .set({ status: (action.params as { status: string }).status })
        .where(eq(adCampaigns.id, c.id));
    },
  });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listCampaigns(tx: DbOrTx) {
  return tx.select().from(adCampaigns).orderBy(asc(adCampaigns.name)).limit(500);
}

export async function campaignPerformance(tx: DbOrTx, campaignId: string, days = 30) {
  const rows = await tx.select().from(adDailyMetrics).where(eq(adDailyMetrics.campaignId, campaignId)).orderBy(desc(adDailyMetrics.date)).limit(days);
  const t = rows.reduce((a, r) => ({ cost: a.cost + r.costMicros, clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions, conversions: a.conversions + r.conversions, value: a.value + r.conversionValueMicros }), { cost: 0, clicks: 0, impressions: 0, conversions: 0, value: 0 });
  return {
    days: rows.reverse(),
    totals: t,
    // Platform-reported ratios; these are attribution, not causal effects (M09/M10 measure lift).
    ratios: { ctr: t.impressions ? t.clicks / t.impressions : null, cpcMicros: t.clicks ? t.cost / t.clicks : null, platformReportedRoas: t.cost ? t.value / t.cost : null },
    attributionNote: 'Platform-reported conversions are attributed, not incremental. Use experiments or MMM for causal effects.',
  };
}

export async function listReconciliations(tx: DbOrTx) {
  return tx.select().from(spendReconciliations).orderBy(desc(spendReconciliations.createdAt)).limit(200);
}

export function requireOperator(actor: Actor): void {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'finance_approver'], 'paid media operations');
}

export type { SpendRow };
