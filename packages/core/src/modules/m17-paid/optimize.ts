import { adCampaigns, adDailyMetrics, type DbOrTx, paidCampaignDrafts, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, asc, eq } from 'drizzle-orm';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { proposeBudgetChange, proposeStatusChange, requireOperator } from './index.js';

/**
 * Controlled optimisation of campaigns FUTUREGROW created (P3-06). Deterministic, conservative
 * rules over the platform's own synced campaign state and daily metrics produce suggestions; a
 * person chooses one and it becomes an ordinary M23 proposal (budget or status change) with the
 * finance approval, spend gates, kill switches and read-back verification of every other paid
 * change. Nothing here executes, auto-approves or increases spend: budget suggestions only ever
 * lower the daily budget to stay inside the lifetime cap the owner approved at creation.
 */

export const MIN_DAYS_FOR_DELIVERY_RULES = 3;
export const MIN_IMPRESSIONS_FOR_CTR_RULE = 1000;
export const LOW_CTR = 0.002;

export interface OptimizationSuggestion {
  key: 'turn_on' | 'pause_cap_reached' | 'pause_ended' | 'pause_no_clicks' | 'pause_low_ctr' | 'pace_to_cap';
  kind: 'status' | 'budget';
  title: string;
  rationale: string;
  facts: Record<string, number | string | null>;
  proposal: { status: 'PAUSED' | 'ACTIVE' } | { newDailyBudgetMicros: number };
  /** Whether choosing it starts or keeps spend (turning on), so the screen can say so. */
  startsSpend: boolean;
}

const DAY = 86_400_000;
const isActive = (s: string) => s === 'ACTIVE' || s === 'ENABLED';

async function load(t: DbOrTx, draftId: string) {
  const [d] = await t.select().from(paidCampaignDrafts).where(eq(paidCampaignDrafts.id, draftId));
  if (!d) throw notFound('campaign draft');
  return d;
}

/** Suggestions for one created campaign, from synced platform data only. Reads; changes nothing. */
export async function optimizationSuggestions(t: DbOrTx, draftId: string, now: Date) {
  const d = await load(t, draftId);
  if (d.status !== 'created' || !d.externalCampaignId) return { draftId, campaign: null, suggestions: [] as OptimizationSuggestion[], note: 'Suggestions are available once the campaign was created and verified on the platform.' };
  const [c] = await t
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.connectionId, d.connectionId), eq(adCampaigns.externalCampaignId, d.externalCampaignId)));
  if (!c) return { draftId, campaign: null, suggestions: [], note: 'The created campaign has not been synced from the platform yet (campaigns sync every 6 hours).' };
  const days = await t.select().from(adDailyMetrics).where(eq(adDailyMetrics.campaignId, c.id)).orderBy(asc(adDailyMetrics.date));
  const spec = d.spec as { lifetimeCap?: { amountMicros: number; currency: string }; endTime?: string; endDate?: string };
  const cap = spec.lifetimeCap?.amountMicros ?? null;
  const endsAt = spec.endTime ? new Date(spec.endTime) : spec.endDate ? new Date(`${spec.endDate}T23:59:59Z`) : null;
  const spent = days.reduce((a, r) => a + r.costMicros, 0);
  const clicks = days.reduce((a, r) => a + r.clicks, 0);
  const impressions = days.reduce((a, r) => a + r.impressions, 0);
  const deliveredDays = days.filter((r) => r.impressions > 0).length;
  const facts = { status: c.status, dailyBudgetMicros: c.dailyBudgetMicros, currency: c.currency, spentMicros: spent, lifetimeCapMicros: cap, clicks, impressions, reportedDays: days.length, deliveredDays, endsAt: endsAt?.toISOString() ?? null, lastSyncedAt: c.lastSyncedAt.toISOString() };
  const out: OptimizationSuggestion[] = [];
  const active = isActive(c.status);
  if (active && cap !== null && spent >= cap) {
    out.push({ key: 'pause_cap_reached', kind: 'status', title: 'Pause: the approved lifetime cap is reached', rationale: `Platform-reported spend ${spent / 1e6} ${c.currency} has reached the lifetime cap of ${cap / 1e6} ${c.currency} approved at creation.`, facts, proposal: { status: 'PAUSED' }, startsSpend: false });
  } else if (active && endsAt && now.getTime() > endsAt.getTime()) {
    out.push({ key: 'pause_ended', kind: 'status', title: 'Pause: the planned end date has passed', rationale: `The campaign was planned to end ${endsAt.toISOString().slice(0, 10)} and is still active on the platform.`, facts, proposal: { status: 'PAUSED' }, startsSpend: false });
  } else if (active && deliveredDays >= MIN_DAYS_FOR_DELIVERY_RULES && spent > 0 && clicks === 0) {
    out.push({
      key: 'pause_no_clicks',
      kind: 'status',
      title: 'Pause: spend without any clicks',
      rationale: `${deliveredDays} days of delivery spent ${spent / 1e6} ${c.currency} with ${impressions} impressions and no clicks. Review the creative and targeting before turning it on again.`,
      facts,
      proposal: { status: 'PAUSED' },
      startsSpend: false,
    });
  } else if (active && deliveredDays >= MIN_DAYS_FOR_DELIVERY_RULES && impressions >= MIN_IMPRESSIONS_FOR_CTR_RULE && clicks / impressions < LOW_CTR) {
    out.push({
      key: 'pause_low_ctr',
      kind: 'status',
      title: 'Pause: very low click-through rate',
      rationale: `Click-through rate ${((clicks / impressions) * 100).toFixed(2)}% over ${impressions} impressions is below ${(LOW_CTR * 100).toFixed(1)}%. A low CTR is a platform-reported signal, not proof the campaign does not work.`,
      facts,
      proposal: { status: 'PAUSED' },
      startsSpend: false,
    });
  }
  if (active && cap !== null && endsAt && c.dailyBudgetMicros && spent < cap && now.getTime() < endsAt.getTime()) {
    const remainingDays = Math.max(1, Math.ceil((endsAt.getTime() - now.getTime()) / DAY));
    const paced = Math.floor((cap - spent) / remainingDays / 10_000) * 10_000;
    if (paced > 0 && paced < c.dailyBudgetMicros) {
      out.push({
        key: 'pace_to_cap',
        kind: 'budget',
        title: 'Lower the daily budget to stay within the lifetime cap',
        rationale: `${(cap - spent) / 1e6} ${c.currency} of the approved cap remains for ${remainingDays} day(s); the current daily budget ${c.dailyBudgetMicros / 1e6} ${c.currency} would exceed it. ${paced / 1e6} ${c.currency} per day keeps the campaign inside the cap.`,
        facts,
        proposal: { newDailyBudgetMicros: paced },
        startsSpend: false,
      });
    }
  }
  if (!active && !out.length && (!endsAt || now.getTime() < endsAt.getTime()) && (cap === null || spent < cap)) {
    out.push({ key: 'turn_on', kind: 'status', title: 'Turn the campaign on', rationale: 'The campaign was created paused and verified. Turning it on starts spending up to its daily budget and needs a finance approval with two-factor.', facts, proposal: { status: 'ACTIVE' }, startsSpend: true });
  }
  return {
    draftId,
    campaign: { id: c.id, name: c.name, platform: c.platform, status: c.status, externalCampaignId: c.externalCampaignId },
    suggestions: out,
    note: 'Rules use platform-reported metrics (attributed, not incremental) and never raise spend. Choosing a suggestion only proposes it; a finance approver decides, and the platform state is read back afterwards.',
  };
}

/**
 * Proposes one suggestion through M23. The suggestion is recomputed on the server from synced
 * data (a client cannot choose its own numbers); if it no longer applies, nothing is proposed.
 */
export async function proposeOptimization(deps: CoreDeps, tenantId: string, actor: Actor, draftId: string, key: string) {
  requireOperator(actor);
  const now = deps.clock.now();
  const { campaign, suggestions } = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (t) => optimizationSuggestions(t, draftId, now));
  const s = suggestions.find((x) => x.key === key);
  if (!campaign || !s) throw invalid('this suggestion no longer applies; reload the campaign');
  const [d] = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (t) => t.select().from(paidCampaignDrafts).where(eq(paidCampaignDrafts.id, draftId)));
  const rationale = `Optimisation suggestion "${s.title}": ${s.rationale}`.slice(0, 2000);
  if ('status' in s.proposal) return proposeStatusChange(deps, tenantId, actor, campaign.id, { status: s.proposal.status, geographies: d!.geographies, rationale });
  return proposeBudgetChange(deps, tenantId, actor, campaign.id, { newDailyBudgetMicros: s.proposal.newDailyBudgetMicros, geographies: d!.geographies, rationale });
}
