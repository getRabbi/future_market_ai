import { randomUUID } from 'node:crypto';
import { brandChannels, competitorObservations, competitors, connections, type DbOrTx, evidenceRecords, growthOpportunities, growthSignals, growthWarfareSettings, keywordMetrics, type Tx, trends, withTenant } from '@futuregrow/db';
import { invalid, notFound, sha256Canonical, sha256Hex } from '@futuregrow/observability';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { type Actor, type CoreDeps, systemActor } from '../../deps.js';
import { audit, normalizeText, record, requireRole } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { effectiveFreshness } from '../m23-execution/facts.js';
import { raiseAlert } from '../m24-governance/index.js';
import { runOperation } from './operations.js';
import { type BrandConfig, effectiveLimits, getBrandConfig, getSettings, requireFeature, type Settings, workingBrandIds } from './settings.js';

/**
 * F1 Market Signal Hunter (D-054). Reads only authorized, already-stored evidence: M04 trends,
 * M05 competitor observations from approved sources, Search Console / uploaded keyword metrics,
 * first-party customer inquiries (redacted text, aggregated, k ≥ 5) and consented app telemetry
 * (aggregated, k ≥ 5). Nothing is fetched from new sources here and no number is estimated: every
 * signal stores the source numbers it was computed from, its evidence ids and an expiry.
 */
const DAY = 86_400_000;
export const GW_ACTOR = systemActor('growth-warfare');
const ACTOR_REF = 'system:growth-warfare';
/** Minimum distinct people behind an aggregated first-party signal (no individual is exposed). */
export const MIN_AGGREGATE = 5;
const LOOKBACK_DAYS = 30;

type SignalKind = 'high_intent_demand' | 'unmet_need' | 'switching_intent' | 'emerging_problem' | 'demand_shift' | 'competitor_price_change' | 'competitor_feature_change' | 'competitor_packaging_change' | 'competitor_positioning_change' | 'competitor_availability_change' | 'competitor_policy_change';

export interface CandidateSignal {
  kind: SignalKind;
  dedupKey: string;
  subject: string;
  sourceTable: string;
  sourceRef: string;
  evidenceIds: string[];
  metrics: Record<string, unknown>;
  confidence: number;
  observedAt: Date;
  /** 0..1 data sufficiency measured from the source (impressions, people, p-value). */
  sufficiency: number;
  matched: string[];
}

/** Heuristic priority weights per kind (documented, not probabilities of conversion). */
const INTENT: Record<SignalKind, number> = {
  switching_intent: 0.9,
  high_intent_demand: 0.8,
  competitor_price_change: 0.8,
  competitor_availability_change: 0.8,
  competitor_packaging_change: 0.7,
  competitor_feature_change: 0.6,
  competitor_policy_change: 0.6,
  competitor_positioning_change: 0.5,
  unmet_need: 0.5,
  emerging_problem: 0.5,
  demand_shift: 0.4,
};
const HALF_LIFE_DAYS: Record<string, number> = { competitor: 14, query: 30, trend: 30, inquiry: 21, telemetry: 21 };
const SLA_DAYS: Record<string, number> = { competitor: 30, query: 45, trend: 30, inquiry: 30, telemetry: 30 };
const WEIGHTS = { relevance: 0.2, evidenceConfidence: 0.15, commercialIntent: 0.2, freshness: 0.1, urgency: 0.1, competition: 0.05, acquisitionEffort: 0.1, dataSufficiency: 0.1 } as const;

const family = (k: SignalKind) => (k.startsWith('competitor_') ? 'competitor' : k === 'demand_shift' ? 'trend' : 'query');

/* ------------------------------------------------------------------ */
/* Intent classification (rule-based, inspectable)                     */
/* ------------------------------------------------------------------ */

const SWITCH = /\b(alternative|alternatives|vs|versus|switch(ing)? from|replace|instead of|compare|comparison|better than)\b/i;
const HIGH_INTENT = /\b(buy|price|pricing|cost|cheap|best|download|app|course|book|order|subscribe|subscription|plan|fee|fees|admission|coupon|trial|sign ?up|join|near me)\b|দাম|কিনুন|কোর্স|অ্যাপ|ডাউনলোড|ভর্তি|ফি/iu;
const NEED = /^(how|why|what|can|is|does|where|which|when)\b|\?\s*$|\b(problem|issue|not working|error|fix|help|cannot|can't|unable|stuck|fail(ed|ing)?)\b|কিভাবে|কেন|সমস্যা/iu;

export function classifyQuery(q: string, competitorNames: string[]): SignalKind | null {
  const n = normalizeText(q);
  if (SWITCH.test(n) || competitorNames.some((c) => c.length >= 3 && n.includes(normalizeText(c)))) return 'switching_intent';
  if (HIGH_INTENT.test(n)) return 'high_intent_demand';
  if (NEED.test(q.trim()) || NEED.test(n)) return 'unmet_need';
  return null;
}

export function matchKeywords(text: string, keywords: string[]): string[] {
  const n = normalizeText(text);
  return keywords.filter((k) => {
    const kk = normalizeText(k);
    return kk.length >= 2 && n.includes(kk);
  });
}

function competitorKind(kind: string, summary: string): SignalKind | null {
  if (/out of stock|unavailable|discontinu|shut(ting)? down|sold out|no longer (available|offered)|availability/i.test(summary)) return 'competitor_availability_change';
  if (/\b(policy|terms|refund|return policy|warranty|service change|delivery (time|area)|cod)\b/i.test(summary)) return 'competitor_policy_change';
  if (/\b(plan|tier|bundle|package|packaging|seat|annual|monthly)\b/i.test(summary) && kind !== 'price_change') return 'competitor_packaging_change';
  switch (kind) {
    case 'price_change':
      return 'competitor_price_change';
    case 'feature_added':
    case 'feature_removed':
    case 'release':
      return 'competitor_feature_change';
    case 'positioning':
    case 'creative':
    case 'content_change':
      return 'competitor_positioning_change';
    default:
      return null; // 'gap' is an inference, never a market change
  }
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

export interface ScoreBreakdown {
  components: Record<keyof typeof WEIGHTS, number | null>;
  unknown: string[];
  score: number;
  urgency: 'low' | 'medium' | 'high';
  method: string;
}

export function scoreSignal(c: CandidateSignal, ctx: { now: Date; publishingChannels: number }): ScoreBreakdown {
  const ageDays = Math.max(0, (ctx.now.getTime() - c.observedAt.getTime()) / DAY);
  const fam = family(c.kind) === 'query' && c.sourceTable !== 'keyword_metrics' ? (c.sourceTable === 'customer_events' ? 'telemetry' : 'inquiry') : family(c.kind);
  const change = typeof c.metrics.changePct === 'number' ? (c.metrics.changePct as number) : null;
  let urgency: ScoreBreakdown['urgency'] = 'low';
  if (family(c.kind) === 'competitor') urgency = ageDays <= 7 ? 'high' : ageDays <= 21 ? 'medium' : 'low';
  else if (change !== null) urgency = change >= 50 ? 'high' : change >= 15 ? 'medium' : 'low';
  else if (c.kind === 'demand_shift' && typeof c.metrics.velocity === 'number') urgency = Math.abs(c.metrics.velocity as number) >= 0.2 ? 'high' : 'medium';
  else urgency = ageDays <= 7 ? 'medium' : 'low';
  const components: ScoreBreakdown['components'] = {
    relevance: Math.min(1, 0.6 + 0.2 * Math.max(0, c.matched.length - 1)),
    evidenceConfidence: c.confidence,
    commercialIntent: c.kind === 'demand_shift' && c.metrics.direction && /falling|down/.test(String(c.metrics.direction)) ? 0.2 : INTENT[c.kind],
    freshness: Math.exp((-Math.LN2 * ageDays) / (HALF_LIFE_DAYS[fam] ?? 21)),
    urgency: urgency === 'high' ? 1 : urgency === 'medium' ? 0.6 : 0.3,
    // No authorized provider supplies competition levels; it stays unknown rather than guessed.
    competition: null,
    acquisitionEffort: ctx.publishingChannels > 0 ? 0.7 : 0.4,
    dataSufficiency: c.sufficiency,
  };
  const known = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).filter((k) => components[k] !== null);
  const wsum = known.reduce((s, k) => s + WEIGHTS[k], 0);
  const base = known.reduce((s, k) => s + WEIGHTS[k] * (components[k] as number), 0) / wsum;
  const score = Math.round(base * (0.5 + 0.5 * c.sufficiency) * 1000) / 1000;
  return {
    components,
    unknown: (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).filter((k) => components[k] === null),
    score,
    urgency,
    method: 'weighted mean of known components × (0.5 + 0.5 × data sufficiency); a prioritisation aid, not a conversion probability',
  };
}

function nextActionFor(kind: SignalKind, metrics: Record<string, unknown>) {
  if (kind.startsWith('competitor_') || kind === 'switching_intent') return { feature: 'F2', kind: 'build_conquest_campaign', label: 'Build an evidence-backed switching campaign package (F2)' };
  if (kind === 'demand_shift') return /falling|down/.test(String(metrics.direction)) ? { feature: 'F6', kind: 'review_positioning', label: 'Propose a positioning experiment for the falling demand (F6)' } : { feature: 'F3', kind: 'trend_blitz', label: 'Prepare a time-boxed multi-channel blitz while demand rises (F3)' };
  if (kind === 'unmet_need' || kind === 'emerging_problem') return { feature: 'F4', kind: 'answer_need', label: 'Answer the need with content, an FAQ or an acquisition tool (F4)' };
  return { feature: 'F3', kind: 'capture_demand', label: 'Prepare campaign content for the high-intent searches (F3/F4)' };
}

function reasonFor(c: CandidateSignal, brandName: string): string {
  const day = c.observedAt.toISOString().slice(0, 10);
  const m = c.metrics;
  switch (c.sourceTable) {
    case 'competitor_observations':
      return `${String(m.competitor)} — ${String(m.summary)} (observed ${day} in an approved primary source; ${brandName} lists ${String(m.competitor)} as a competitor).`;
    case 'trends':
      return `“${c.subject}” is ${String(m.direction).replace('_', ' ')} (Mann-Kendall p=${m.mannKendallP ?? 'n/a'}, window to ${day}); it matches ${brandName} keywords ${c.matched.join(', ')}. Correlation only.`;
    case 'keyword_metrics':
      return `Search query “${c.subject}” had ${m.impressions} impressions and ${m.clicks} clicks (average position ${m.position ?? 'n/a'}) in ${m.periodStart}–${m.periodEnd}${typeof m.changePct === 'number' ? `, ${(m.changePct as number) >= 0 ? '+' : ''}${m.changePct}% impressions versus the previous period` : ''}; it matches ${c.matched.join(', ')}.`;
    case 'conversation_messages':
      return `${m.people} different customers asked about “${c.subject}” in ${LOOKBACK_DAYS} days of first-party conversations (redacted, aggregated).`;
    default:
      return `${m.units} consented app users searched for “${c.subject}” in ${LOOKBACK_DAYS} days (first-party telemetry, aggregated).`;
  }
}

/* ------------------------------------------------------------------ */
/* Collectors                                                          */
/* ------------------------------------------------------------------ */

async function currentEvidence(t: DbOrTx, ids: string[], now: Date): Promise<{ ok: string[]; confidence: number | null }> {
  if (!ids.length) return { ok: [], confidence: null };
  const rows = await t.select().from(evidenceRecords).where(inArray(evidenceRecords.id, ids));
  const ok = rows.filter((e) => e.status === 'admitted' && (!e.expiresAt || e.expiresAt > now) && effectiveFreshness(e, now) !== 'stale');
  const conf = ok.map((e) => e.confidence).filter((x): x is number => typeof x === 'number');
  return { ok: ok.map((e) => e.id), confidence: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null };
}

async function competitorSignals(t: DbOrTx, cfg: BrandConfig, now: Date): Promise<CandidateSignal[]> {
  if (!cfg.competitorIds.length) return [];
  const rows = await t
    .select({ o: competitorObservations, name: competitors.name })
    .from(competitorObservations)
    .innerJoin(competitors, eq(competitors.id, competitorObservations.competitorId))
    .where(and(inArray(competitorObservations.competitorId, cfg.competitorIds), eq(competitorObservations.evidenceFlag, 'P'), gte(competitorObservations.observedAt, new Date(now.getTime() - LOOKBACK_DAYS * DAY))))
    .orderBy(desc(competitorObservations.observedAt))
    .limit(200);
  const out: CandidateSignal[] = [];
  for (const { o, name } of rows) {
    const kind = competitorKind(o.kind, o.summary);
    if (!kind) continue;
    const ev = await currentEvidence(t, o.evidenceIds, now);
    if (!ev.ok.length) continue; // stale or rejected evidence never becomes a signal
    out.push({
      kind,
      dedupKey: `obs:${o.id}`,
      subject: `${name}: ${o.summary}`.slice(0, 300),
      sourceTable: 'competitor_observations',
      sourceRef: o.id,
      evidenceIds: ev.ok,
      metrics: { competitor: name, competitorId: o.competitorId, observationKind: o.kind, summary: o.summary, details: o.details },
      confidence: Math.min(o.confidence, ev.confidence ?? o.confidence),
      observedAt: o.observedAt,
      sufficiency: 1,
      matched: [name],
    });
  }
  return out;
}

async function trendSignals(t: DbOrTx, cfg: BrandConfig, now: Date): Promise<CandidateSignal[]> {
  if (!cfg.keywords.length) return [];
  const rows = await t
    .select()
    .from(trends)
    .where(and(gte(trends.createdAt, new Date(now.getTime() - LOOKBACK_DAYS * DAY)), inArray(trends.direction, ['rising', 'shift_up', 'falling', 'shift_down'])))
    .orderBy(desc(trends.createdAt))
    .limit(200);
  const out: CandidateSignal[] = [];
  for (const tr of rows) {
    const matched = matchKeywords(tr.topic, cfg.keywords);
    if (!matched.length || tr.freshnessStatus === 'stale') continue;
    const ev = await currentEvidence(t, tr.evidenceIds, now);
    if (!ev.ok.length) continue;
    const p = tr.mannKendallP;
    out.push({
      kind: 'demand_shift',
      dedupKey: `trend:${normalizeText(tr.topic)}:${tr.geography ?? '*'}`,
      subject: tr.topic,
      sourceTable: 'trends',
      sourceRef: tr.id,
      evidenceIds: ev.ok,
      metrics: { direction: tr.direction, senSlope: tr.senSlope, mannKendallP: p, velocity: tr.velocity, windowStart: tr.windowStart.toISOString(), windowEnd: tr.windowEnd.toISOString(), geography: tr.geography, inference: tr.inferenceKind },
      confidence: tr.confidence,
      observedAt: tr.windowEnd,
      sufficiency: p === null ? 0.5 : Math.max(0, Math.min(1, 1 - p * 10)),
      matched,
    });
  }
  return out;
}

async function querySignals(t: DbOrTx, cfg: BrandConfig, competitorNames: string[], now: Date): Promise<CandidateSignal[]> {
  if (!cfg.keywords.length) return [];
  const [latest] = await t.select({ end: keywordMetrics.periodEnd, start: keywordMetrics.periodStart }).from(keywordMetrics).orderBy(desc(keywordMetrics.periodEnd)).limit(1);
  if (!latest) return [];
  const agg = async (start: string, end: string) =>
    (
      await t.execute<{ query: string; impressions: number; clicks: number; position: number | null; evidence: string[] }>(sql`
        select query, sum(impressions)::int as impressions, sum(clicks)::int as clicks,
               sum(position * impressions) / nullif(sum(impressions), 0) as position,
               array_agg(distinct evidence_id) as evidence
        from keyword_metrics where period_start = ${start} and period_end = ${end} group by query`)
    ).rows;
  const current = await agg(latest.start, latest.end);
  const [prev] = await t.select({ start: keywordMetrics.periodStart, end: keywordMetrics.periodEnd }).from(keywordMetrics).where(sql`${keywordMetrics.periodEnd} < ${latest.start}`).orderBy(desc(keywordMetrics.periodEnd)).limit(1);
  const previous = prev ? new Map((await agg(prev.start, prev.end)).map((r) => [r.query, r.impressions])) : new Map<string, number>();
  const out: CandidateSignal[] = [];
  for (const r of current) {
    if (r.impressions < 20) continue; // too little data to call it demand
    const matched = matchKeywords(r.query, cfg.keywords);
    if (!matched.length) continue;
    const kind = classifyQuery(r.query, competitorNames);
    if (!kind) continue;
    const ev = await currentEvidence(t, r.evidence, now);
    if (!ev.ok.length) continue;
    const before = previous.get(r.query);
    const changePct = before ? Math.round(((r.impressions - before) / before) * 1000) / 10 : null;
    out.push({
      kind,
      dedupKey: `kw:${kind}:${normalizeText(r.query)}`,
      subject: r.query,
      sourceTable: 'keyword_metrics',
      sourceRef: `${latest.start}..${latest.end}:${r.query}`,
      evidenceIds: ev.ok,
      metrics: { impressions: r.impressions, clicks: r.clicks, position: r.position === null ? null : Math.round(r.position * 10) / 10, periodStart: latest.start, periodEnd: latest.end, previousImpressions: before ?? null, changePct },
      confidence: ev.confidence ?? 0.8,
      observedAt: new Date(`${latest.end}T23:59:59Z`),
      sufficiency: Math.min(1, r.impressions / 200),
      matched,
    });
  }
  return out;
}

/**
 * First-party inquiries and consented app searches, aggregated by matched brand keyword and need
 * pattern. Only counts of distinct people are kept (k ≥ MIN_AGGREGATE); the aggregate is admitted
 * as internal evidence so the signal has provenance without copying anyone's words.
 */
async function firstPartySignals(t: Tx, tenantId: string, cfg: BrandConfig, competitorNames: string[], now: Date): Promise<CandidateSignal[]> {
  if (!cfg.keywords.length) return [];
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY);
  const out: CandidateSignal[] = [];
  const inquiries = (
    await t.execute<{ conversation_id: string; text: string }>(sql`
      select m.conversation_id, m.redacted_text as text from conversation_messages m
      where m.role = 'customer' and m.created_at >= ${since} order by m.created_at desc limit 2000`)
  ).rows;
  const searches = (
    await t.execute<{ unit: string; text: string }>(sql`
      select coalesce(e.profile_id::text, e.anonymous_id) as unit, e.properties->>'query' as text from customer_events e
      where e.event_name in ('search', 'search_performed', 'app_search', 'product_search') and e.occurred_at >= ${since}
        and e.properties ? 'query'
        and (e.context->'consent'->>'analytics' = 'true'
             or exists (select 1 from consent_state c where c.profile_id = e.profile_id and c.purpose = 'analytics' and c.status = 'granted'))
      limit 5000`)
  ).rows;
  const groups = new Map<string, { kind: SignalKind; keyword: string; units: Set<string>; table: string }>();
  const add = (table: string, unit: string, text: string | null) => {
    if (!text || !unit) return;
    const kind = classifyQuery(text, competitorNames);
    if (!kind) return;
    for (const k of matchKeywords(text, cfg.keywords)) {
      const key = `${table}:${kind}:${normalizeText(k)}`;
      const g = groups.get(key) ?? { kind, keyword: k, units: new Set<string>(), table };
      g.units.add(unit);
      groups.set(key, g);
    }
  };
  for (const r of inquiries) add('conversation_messages', r.conversation_id, r.text);
  for (const r of searches) add('customer_events', r.unit, r.text);
  for (const [key, g] of groups) {
    if (g.units.size < MIN_AGGREGATE) continue;
    const people = g.units.size;
    const content = { aggregate: key, kind: g.kind, keyword: g.keyword, distinctPeople: people, windowDays: LOOKBACK_DAYS, until: now.toISOString().slice(0, 10), minAggregate: MIN_AGGREGATE };
    const uri = `internal:growth-warfare/${g.table}/${encodeURIComponent(key)}/${now.toISOString().slice(0, 10)}`;
    const [same] = await t
      .select({ id: evidenceRecords.id })
      .from(evidenceRecords)
      .where(and(eq(evidenceRecords.sourceUriOrObjectId, uri), eq(evidenceRecords.contentSha256, sha256Canonical(content)), eq(evidenceRecords.status, 'admitted')))
      .limit(1);
    const ev = same ?? {
      id: (
        await admitInternalEvidence(t, tenantId, GW_ACTOR, {
          kind: 'metric',
          owner: 'futuregrow:growth-warfare',
          uri,
          content,
          summary: `${people} distinct ${g.table === 'customer_events' ? 'consented app users' : 'customers'} matched “${g.keyword}” (${g.kind.replaceAll('_', ' ')}) in ${LOOKBACK_DAYS} days.`,
          confidence: 0.7,
          license: 'first-party',
          pii: 'none',
          permittedUses: ['analytics', 'competitive_analysis', 'creative_generation'],
          freshnessSlaHours: 24 * SLA_DAYS.inquiry!,
          now,
        })
      ).evidenceId,
    };
    out.push({
      kind: g.kind,
      dedupKey: `${g.table === 'customer_events' ? 'tel' : 'inq'}:${g.kind}:${normalizeText(g.keyword)}`,
      subject: g.keyword,
      sourceTable: g.table,
      sourceRef: key,
      evidenceIds: [ev.id],
      metrics: g.table === 'customer_events' ? { units: people, windowDays: LOOKBACK_DAYS } : { people, windowDays: LOOKBACK_DAYS },
      confidence: 0.7,
      observedAt: now,
      sufficiency: Math.min(1, people / 20),
      matched: [g.keyword],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Upsert, sweep, scan                                                 */
/* ------------------------------------------------------------------ */

type History = { at: string; change: string; details?: Record<string, unknown> }[];
const pushHistory = (h: unknown[], e: History[number]) => [...(h as History), e].slice(-50);

export interface ScanResult {
  brandId: string;
  candidates: number;
  created: number;
  updated: number;
  opportunities: number;
  expired: number;
  rejected: number;
  sources: Record<string, number>;
}

async function publishingChannels(t: DbOrTx, brandId: string): Promise<number> {
  const rows = await t
    .select({ provider: connections.provider })
    .from(brandChannels)
    .innerJoin(connections, eq(connections.id, brandChannels.connectionId))
    .where(and(eq(brandChannels.brandId, brandId), eq(connections.status, 'active')));
  return rows.filter((r) => ['meta', 'resend', 'tiktok', 'youtube', 'linkedin'].includes(r.provider)).length;
}

/** Expire signals/opportunities past their window and reject those whose evidence is no longer current. */
export async function sweepSignals(t: Tx, _tenantId: string, brandId: string | null, now: Date): Promise<{ expired: number; rejected: number }> {
  const scope = brandId ? eq(growthSignals.brandId, brandId) : undefined;
  const active = await t
    .select()
    .from(growthSignals)
    .where(and(eq(growthSignals.status, 'active'), scope));
  let expired = 0;
  let rejected = 0;
  for (const s of active) {
    let status: 'expired' | 'rejected' | null = null;
    let why = '';
    if (s.expiresAt <= now) {
      status = 'expired';
      why = 'past its evidence window';
    } else {
      const ev = await currentEvidence(t, s.evidenceIds, now);
      if (!ev.ok.length) {
        status = 'rejected';
        why = 'its evidence is no longer current (expired, stale or rejected)';
      }
    }
    if (!status) continue;
    if (status === 'expired') expired++;
    else rejected++;
    await t
      .update(growthSignals)
      .set({ status, history: pushHistory(s.history, { at: now.toISOString(), change: status, details: { why } }), updatedAt: now })
      .where(eq(growthSignals.id, s.id));
    await t
      .update(growthOpportunities)
      .set({ status: 'expired', reviewNote: `Expired automatically: the signal is ${why}.`, updatedAt: now })
      .where(and(eq(growthOpportunities.signalId, s.id), inArray(growthOpportunities.status, ['new', 'reviewing'])));
  }
  await t
    .update(growthOpportunities)
    .set({ status: 'expired', reviewNote: 'Expired automatically: the opportunity window passed.', updatedAt: now })
    .where(and(inArray(growthOpportunities.status, ['new', 'reviewing']), lte(growthOpportunities.expiresAt, now), brandId ? eq(growthOpportunities.brandId, brandId) : undefined));
  return { expired, rejected };
}

/** Collect, deduplicate, score and queue signals for one brand (one transaction). */
export async function scanBrand(deps: CoreDeps, tenantId: string, brandId: string, settings: Settings): Promise<ScanResult> {
  const now = deps.clock.now();
  return withTenant(deps.db, { tenantId, actor: ACTOR_REF }, async (t) => {
    const [brand] = (await t.execute<{ id: string; name: string }>(sql`select id, name from brands where id = ${brandId}`)).rows;
    if (!brand) throw notFound('brand');
    const { config } = await getBrandConfig(t, brandId);
    const names = config.competitorIds.length ? (await t.select({ name: competitors.name }).from(competitors).where(inArray(competitors.id, config.competitorIds))).map((r) => r.name) : [];
    const sweep = await sweepSignals(t, tenantId, brandId, now);
    const lists = { competitor: await competitorSignals(t, config, now), trend: await trendSignals(t, config, now), query: await querySignals(t, config, names, now), firstParty: await firstPartySignals(t, tenantId, config, names, now) };
    const limits = effectiveLimits(settings.aggression, settings.controls);
    const all = [...lists.competitor, ...lists.trend, ...lists.query, ...lists.firstParty].slice(0, limits.maxSignalsPerScan);
    const channels = await publishingChannels(t, brandId);
    let created = 0;
    let updated = 0;
    let opportunities = 0;
    for (const c of all) {
      const sla = SLA_DAYS[family(c.kind) === 'query' && c.sourceTable !== 'keyword_metrics' ? 'inquiry' : family(c.kind)] ?? 30;
      const expiresAt = new Date(c.observedAt.getTime() + sla * DAY);
      if (expiresAt <= now) continue;
      const [existing] = await t
        .select()
        .from(growthSignals)
        .where(and(eq(growthSignals.brandId, brandId), eq(growthSignals.dedupKey, c.dedupKey)))
        .for('update');
      let signalId: string;
      if (!existing) {
        const [row] = await t
          .insert(growthSignals)
          .values({
            tenantId,
            brandId,
            kind: c.kind,
            dedupKey: c.dedupKey,
            subject: c.subject,
            sourceTable: c.sourceTable,
            sourceRef: c.sourceRef,
            evidenceIds: c.evidenceIds,
            metrics: c.metrics,
            confidence: c.confidence,
            observedAt: c.observedAt,
            firstSeenAt: now,
            lastSeenAt: now,
            expiresAt,
            history: [{ at: now.toISOString(), change: 'created', details: { sourceRef: c.sourceRef } }],
          })
          .returning({ id: growthSignals.id });
        signalId = row!.id;
        created++;
      } else {
        signalId = existing.id;
        if (existing.status === 'dismissed') continue; // a person dismissed it; do not resurrect
        const changed = existing.sourceRef !== c.sourceRef || sha256Hex(JSON.stringify(existing.metrics)) !== sha256Hex(JSON.stringify(c.metrics));
        await t
          .update(growthSignals)
          .set({
            lastSeenAt: now,
            ...(changed
              ? { sourceRef: c.sourceRef, metrics: c.metrics, evidenceIds: c.evidenceIds, confidence: c.confidence, observedAt: c.observedAt, expiresAt, status: 'active', history: pushHistory(existing.history, { at: now.toISOString(), change: 'updated', details: { from: existing.metrics, to: c.metrics } }) }
              : {}),
            updatedAt: now,
          })
          .where(eq(growthSignals.id, existing.id));
        if (changed) updated++;
        else continue;
      }
      const s = scoreSignal(c, { now, publishingChannels: channels });
      if (s.score < limits.opportunityThreshold || c.confidence < 0.5) continue;
      const title = `${c.kind.replaceAll('_', ' ').replace(/^./, (x) => x.toUpperCase())}: ${c.subject}`.slice(0, 300);
      const values = { kind: c.kind, title, reason: reasonFor(c, brand.name), nextAction: nextActionFor(c.kind, c.metrics), score: s.score, scoreBreakdown: s as unknown as Record<string, unknown>, urgency: s.urgency, expiresAt, updatedAt: now };
      const [opp] = await t
        .insert(growthOpportunities)
        .values({ tenantId, brandId, signalId, ...values })
        .onConflictDoNothing()
        .returning({ id: growthOpportunities.id });
      if (opp) {
        opportunities++;
        await record(t, tenantId, GW_ACTOR, 'growth.opportunity.detected', { type: 'growth_opportunity', id: opp.id }, { brandId, kind: c.kind, score: s.score, urgency: s.urgency, evidenceIds: c.evidenceIds });
        if (s.urgency === 'high') await raiseAlert(t, tenantId, { kind: 'growth_opportunity', severity: 'info', message: `New high-urgency growth opportunity for ${brand.name}: ${title}`, refs: { opportunityId: opp.id, brandId }, dedupKey: `gw-opp:${opp.id}` });
      } else {
        // Refresh the score and reason of an open opportunity; reviewed ones stay as reviewed.
        await t
          .update(growthOpportunities)
          .set(values)
          .where(and(eq(growthOpportunities.signalId, signalId), inArray(growthOpportunities.status, ['new', 'reviewing'])));
      }
    }
    return { brandId, candidates: all.length, created, updated, opportunities, expired: sweep.expired, rejected: sweep.rejected, sources: { competitor: lists.competitor.length, trend: lists.trend.length, query: lists.query.length, firstParty: lists.firstParty.length } };
  });
}

/**
 * Scheduled monitoring: scans each working brand when F1 is on and the monitoring interval has
 * passed. The (brand, interval bucket) key makes repeated ticks and worker restarts idempotent.
 */
export async function scanTenant(deps: CoreDeps, tenantId: string, opts: { force?: boolean; brandId?: string; actor?: Actor } = {}) {
  const now = deps.clock.now();
  const ctx = { tenantId, actor: ACTOR_REF };
  const plan = await withTenant(deps.db, ctx, async (t) => {
    const s = await getSettings(t, tenantId);
    if (s.emergencyStop || !s.features.F1) return { skip: s.emergencyStop ? 'emergency stop engaged' : 'F1 is off', s, brands: [] as string[] };
    const hours = s.effective.monitoringHours;
    if (!opts.force && s.lastScanAt && now.getTime() - new Date(s.lastScanAt).getTime() < hours * 3_600_000) return { skip: `next scan due after ${hours} h`, s, brands: [] };
    const brands = (await workingBrandIds(t, s)).filter((b) => !opts.brandId || b === opts.brandId);
    return { skip: null, s, brands };
  });
  if (plan.skip) return { status: 'skipped' as const, reason: plan.skip, results: [] as ScanResult[] };
  const hours = plan.s.effective.monitoringHours;
  const bucket = Math.floor(now.getTime() / (hours * 3_600_000));
  const results: ScanResult[] = [];
  for (const brandId of plan.brands) {
    const active = await withTenant(deps.db, ctx, async (t) => {
      try {
        await requireFeature(t, tenantId, 'F1', brandId);
        return true;
      } catch {
        return false;
      }
    });
    if (!active) continue;
    // A person's manual scan always runs; scheduled scans are idempotent per (brand, interval bucket).
    const key = opts.force ? `scan:${brandId}:manual:${randomUUID()}` : `scan:${brandId}:${hours}h:${bucket}`;
    const r = await runOperation(deps, tenantId, { kind: 'signal_scan', idempotencyKey: key, brandId }, async () => (await scanBrand(deps, tenantId, brandId, plan.s)) as unknown as Record<string, unknown>);
    if (r.result) results.push(r.result as unknown as ScanResult);
  }
  await withTenant(deps.db, ctx, async (t) => {
    await t.update(growthWarfareSettings).set({ lastScanAt: now }).where(eq(growthWarfareSettings.tenantId, tenantId));
    if (opts.actor) await audit(t, tenantId, opts.actor, 'growth_warfare.scan.requested', { type: 'growth_warfare_settings', id: tenantId }, { brands: plan.brands.length });
  });
  return { status: 'completed' as const, reason: null, results };
}

/* ------------------------------------------------------------------ */
/* Review queue                                                        */
/* ------------------------------------------------------------------ */

export async function listOpportunities(t: DbOrTx, filter: { brandId?: string; status?: string[]; limit?: number } = {}) {
  return t
    .select({ o: growthOpportunities, s: growthSignals })
    .from(growthOpportunities)
    .innerJoin(growthSignals, eq(growthSignals.id, growthOpportunities.signalId))
    .where(and(filter.brandId ? eq(growthOpportunities.brandId, filter.brandId) : undefined, filter.status?.length ? inArray(growthOpportunities.status, filter.status) : undefined))
    .orderBy(desc(growthOpportunities.score), desc(growthOpportunities.createdAt))
    .limit(filter.limit ?? 100)
    .then((rows) =>
      rows.map(({ o, s }) => ({ ...o, signal: { id: s.id, kind: s.kind, subject: s.subject, sourceTable: s.sourceTable, sourceRef: s.sourceRef, evidenceIds: s.evidenceIds, metrics: s.metrics, confidence: s.confidence, observedAt: s.observedAt, expiresAt: s.expiresAt, status: s.status, history: s.history } })),
    );
}

export async function reviewOpportunity(t: Tx, tenantId: string, actor: Actor, id: string, input: { decision: 'reviewing' | 'accepted' | 'dismissed'; note?: string }) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'approver'], 'reviewing growth opportunities');
  const [o] = await t.select().from(growthOpportunities).where(eq(growthOpportunities.id, id)).for('update');
  if (!o) throw notFound('opportunity');
  if (!['new', 'reviewing', 'accepted'].includes(o.status)) throw invalid(`the opportunity is ${o.status}`);
  const now = new Date();
  await t
    .update(growthOpportunities)
    .set({ status: input.decision, reviewedBy: `${actor.type}:${actor.id}`, reviewedAt: now, reviewNote: input.note ?? null, updatedAt: now })
    .where(eq(growthOpportunities.id, id));
  if (input.decision === 'dismissed') {
    const [s] = await t.select().from(growthSignals).where(eq(growthSignals.id, o.signalId));
    if (s)
      await t
        .update(growthSignals)
        .set({ status: 'dismissed', history: pushHistory(s.history, { at: now.toISOString(), change: 'dismissed', details: { by: actor.id, note: input.note ?? null } }) })
        .where(eq(growthSignals.id, s.id));
  }
  await audit(t, tenantId, actor, `growth_warfare.opportunity.${input.decision}`, { type: 'growth_opportunity', id }, { note: input.note ?? null });
  const [row] = await t.select().from(growthOpportunities).where(eq(growthOpportunities.id, id));
  return row!;
}
