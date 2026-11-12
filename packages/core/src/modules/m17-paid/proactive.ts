import { adCampaigns, adDailyMetrics, alerts, connections, type DbOrTx, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { autopilotAvailable, autopilotEnabled } from '../autopilot/goals.js';
import { isSystemHalted, raiseAlert } from '../m24-governance/index.js';
import { proposeStatusChange, requireOperator } from './index.js';

const DAY = 86_400_000;
const MAX_AGE = 36 * 3_600_000;
type Campaign = Pick<typeof adCampaigns.$inferSelect, 'id' | 'status' | 'dailyBudgetMicros' | 'lastSyncedAt'>;
type Metric = Pick<typeof adDailyMetrics.$inferSelect, 'date' | 'impressions' | 'clicks' | 'costMicros' | 'conversions' | 'evidenceId' | 'fetchedAt'>;
export interface CampaignSignal {
  key: 'low_ctr' | 'no_clicks' | 'budget_risk' | 'declining_outcomes' | 'efficiency_opportunity';
  reason: string;
  confidence: number;
  evidenceIds: string[];
  facts: Record<string, number | string>;
  suggestedStatus: 'PAUSED' | null;
}

/** Conservative rules over complete recent provider days; absent data never means zero performance. */
export function campaignSignals(c: Campaign, rows: Metric[], now: Date): { signals: CampaignSignal[]; note: string | null } {
  const age = now.getTime() - c.lastSyncedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE) return { signals: [], note: 'Campaign state is stale; sync before analysis.' };
  if (!['ACTIVE', 'ENABLED'].includes(c.status)) return { signals: [], note: 'Campaign is not active.' };
  const today = Date.parse(now.toISOString().slice(0, 10));
  const days = Array.from({ length: 14 }, (_, i) => new Date(today - (i + 1) * DAY).toISOString().slice(0, 10));
  const usable = rows.filter((r) => days.includes(r.date) && r.evidenceId && now.getTime() - r.fetchedAt.getTime() >= 0 && now.getTime() - r.fetchedAt.getTime() <= MAX_AGE && [r.impressions, r.clicks, r.costMicros, r.conversions].every((v) => Number.isFinite(v) && v >= 0));
  if (new Set(usable.map((r) => r.date)).size !== usable.length || days.slice(0, 3).some((d) => !usable.some((r) => r.date === d))) return { signals: [], note: 'Three complete recent days with fresh evidence are required.' };
  const recent = usable.filter((r) => days.slice(0, 7).includes(r.date));
  const sum = (rs: Metric[], key: 'impressions' | 'clicks' | 'costMicros' | 'conversions') => rs.reduce((a, r) => a + r[key], 0);
  const impressions = sum(recent, 'impressions'),
    clicks = sum(recent, 'clicks'),
    cost = sum(recent, 'costMicros');
  const evidenceIds = [...new Set(usable.map((r) => r.evidenceId!))].sort();
  const facts = { impressions, clicks, costMicros: cost, days: recent.length, through: days[0]! };
  const signals: CampaignSignal[] = [];
  const add = (key: CampaignSignal['key'], reason: string, confidence: number, suggestedStatus: 'PAUSED' | null, extra: Record<string, number> = {}) => signals.push({ key, reason, confidence, suggestedStatus, evidenceIds, facts: { ...facts, ...extra } });
  if (impressions >= 1000 && cost > 0 && clicks === 0) add('no_clicks', `No clicks across ${recent.length} reported days with ${impressions} impressions and positive spend. Review delivery and creative.`, 0.9, 'PAUSED');
  else if (impressions >= 1000 && clicks / impressions < 0.002 && cost > 0) add('low_ctr', `Reported CTR ${((100 * clicks) / impressions).toFixed(2)}% is below the 0.2% review threshold; this does not prove negative incremental return.`, 0.7, 'PAUSED');
  const yesterday = usable.find((r) => r.date === days[0])!;
  if (c.dailyBudgetMicros && yesterday.costMicros > 2 * c.dailyBudgetMicros)
    add('budget_risk', 'Last reported daily spend exceeds twice the currently synced daily budget. Review budget history before deciding; the historical limit may differ.', 0.6, 'PAUSED', { dailyBudgetMicros: c.dailyBudgetMicros, lastDayCostMicros: yesterday.costMicros });
  if (usable.length === 14) {
    const previous = usable.filter((r) => days.slice(7).includes(r.date));
    const prevConversions = sum(previous, 'conversions'),
      conversions = sum(recent, 'conversions');
    const prevImpressions = sum(previous, 'impressions'),
      prevCost = sum(previous, 'costMicros');
    if (prevConversions >= 5 && prevImpressions >= 1000 && impressions >= 1000 && conversions / impressions < (0.5 * prevConversions) / prevImpressions)
      add('declining_outcomes', 'Reported conversions per impression fell by more than 50% across two complete seven-day windows. Attribution lag may contribute; investigate before changing delivery.', 0.65, 'PAUSED', { prevConversions, conversions, prevImpressions });
    if (prevConversions >= 5 && conversions >= 5 && prevCost > 0 && cost > 0 && cost / conversions < (0.75 * prevCost) / prevConversions)
      add('efficiency_opportunity', 'Reported cost per conversion improved by more than 25% over two complete weeks. Review creative and test reuse; no spend increase is proposed.', 0.65, null, { prevConversions, conversions, prevCostMicros: prevCost });
  }
  return { signals, note: signals.length ? null : 'No rule met its evidence threshold. This is not a claim of good performance.' };
}

async function analyze(tx: DbOrTx, campaignId: string, now: Date) {
  const [c] = await tx.select().from(adCampaigns).where(eq(adCampaigns.id, campaignId));
  if (!c) throw notFound('campaign');
  const [connection] = await tx.select().from(connections).where(eq(connections.id, c.connectionId));
  if (!connection || !['active', 'read_only'].includes(connection.status)) return { signals: [] as CampaignSignal[], note: 'Connection is unavailable.' };
  const rows = await tx
    .select()
    .from(adDailyMetrics)
    .where(and(eq(adDailyMetrics.campaignId, campaignId), gte(adDailyMetrics.date, new Date(now.getTime() - 15 * DAY).toISOString().slice(0, 10))));
  return campaignSignals(c, rows, now);
}

/** Durable review proposals in the existing alerts inbox. Choosing one then goes through M23. */
export async function evaluateCampaigns(deps: CoreDeps, tenantId: string) {
  if (!autopilotAvailable(deps.config)) return { evaluated: 0, proposed: 0 };
  const now = deps.clock.now();
  const actor = systemActor('campaign-optimizer');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    // Scheduler and spend-sync events can race; serialize proposal deduplication per tenant.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`campaign-optimizer:${tenantId}`}, 0))`);
    if (!(await autopilotEnabled(tx, tenantId)) || (await isSystemHalted(tx))) return { evaluated: 0, proposed: 0 };
    const campaigns = await tx
      .select()
      .from(adCampaigns)
      .where(inArray(adCampaigns.status, ['ACTIVE', 'ENABLED']));
    let proposed = 0;
    for (const c of campaigns) {
      for (const s of (await analyze(tx, c.id, now)).signals) {
        const [open] = await tx
          .select({ id: alerts.id })
          .from(alerts)
          .where(and(eq(alerts.kind, 'ads.optimization'), sql`${alerts.refs}->>'campaignId' = ${c.id}`, sql`${alerts.refs}->>'signal' = ${s.key}`, sql`(${alerts.acknowledgedAt} is null or ${alerts.createdAt} > ${new Date(now.getTime() - 7 * DAY)})`))
          .limit(1);
        if (open) continue;
        const alert = await raiseAlert(tx, tenantId, {
          kind: 'ads.optimization',
          severity: s.suggestedStatus ? 'warning' : 'info',
          message: `${c.name}: ${s.reason}`,
          refs: { campaignId: c.id, signal: s.key, confidence: s.confidence, evidenceIds: s.evidenceIds, facts: s.facts, suggestedStatus: s.suggestedStatus },
          dedupKey: `optimization:${c.id}:${s.key}:${now.toISOString().slice(0, 10)}`,
        });
        if (alert) proposed++;
      }
    }
    return { evaluated: campaigns.length, proposed };
  });
}

export async function listOptimizationReviews(tx: DbOrTx) {
  return tx
    .select()
    .from(alerts)
    .where(and(eq(alerts.kind, 'ads.optimization'), isNull(alerts.acknowledgedAt)))
    .orderBy(desc(alerts.createdAt))
    .limit(200);
}

/** Freshness and relevance are rechecked when an operator requests a paid change. */
export async function submitOptimizationReview(deps: CoreDeps, tenantId: string, actor: Actor, alertId: string, geographies: string[]) {
  requireOperator(actor);
  const signal = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [a] = await tx
      .select()
      .from(alerts)
      .where(and(eq(alerts.id, alertId), eq(alerts.kind, 'ads.optimization'), isNull(alerts.acknowledgedAt)));
    if (!a) throw notFound('optimization review');
    const campaignId = String(a.refs.campaignId);
    const s = (await analyze(tx, campaignId, deps.clock.now())).signals.find((r) => r.key === a.refs.signal);
    if (!s?.suggestedStatus) throw invalid('suggestion no longer applies or has no paid change');
    return { campaignId, s };
  });
  return proposeStatusChange(deps, tenantId, actor, signal.campaignId, { status: 'PAUSED', geographies, evidenceIds: signal.s.evidenceIds, rationale: `${signal.s.reason} Confidence ${signal.s.confidence}; evidence is platform-reported, not causal.`, idempotencyKey: `optimization-review:${alertId}` });
}
