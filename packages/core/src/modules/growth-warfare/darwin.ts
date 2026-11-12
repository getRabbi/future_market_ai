import { type DbOrTx, experimentResults, experiments, experimentVariants, growthCampaigns, growthChannelTasks, growthExperimentPlans, growthStrategyMemory, type Tx, withTenant } from '@futuregrow/db';
import { conflict, forbidden, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { normalizeText, record, requireMfa, requireRole } from '../../util.js';
import { sampleSizeTwoProportions } from '../m06-ideas/index.js';
import { createExperiment, proposeStart } from '../m10-experiments/index.js';
import { getBrandConfig, getSettings, requireFeature, requireOperator } from './settings.js';
import { GW_ACTOR } from './signals.js';

/**
 * F6 Campaign Darwin Engine (D-054): experiment factory, adaptive learning and strategy memory.
 * Experiments are M10 experiments (randomized assignment, Bayesian analysis by the analytics
 * job); Darwin adds the plan (sufficiency, stop conditions, measurement plan), turns finished
 * results into memory and reads memory back for the Growth Brain. Only randomized, SRM-clean
 * results can be called winners or losers; attribution and pre/post numbers are stored as
 * observational and never change tactic priorities.
 */
const DAY = 86_400_000;
const AREAS = ['positioning', 'offer', 'landing_page', 'acquisition_tool', 'onboarding', 'referral', 'campaign_variant'] as const;

export const PlanInputSchema = z.object({
  brandId: z.string().uuid(),
  campaignId: z.string().uuid().nullable().default(null),
  feature: z.enum(['F1', 'F2', 'F3', 'F4', 'F5', 'F6']).default('F6'),
  area: z.enum(AREAS),
  hypothesis: z.string().min(10).max(2000),
  control: z.object({ description: z.string().min(3).max(1000), config: z.record(z.string(), z.unknown()).default({}) }),
  variant: z.object({ description: z.string().min(3).max(1000), config: z.record(z.string(), z.unknown()).default({}) }),
  primaryKpi: z.object({ metric: z.string().min(1).max(100), type: z.enum(['binary', 'continuous']).default('binary'), exposureEvent: z.string().min(1).max(200).nullable().default(null) }),
  guardrails: z
    .array(z.object({ metric: z.string().min(1).max(100), direction: z.enum(['increase_is_bad', 'decrease_is_bad']), maxRelativeChange: z.number().positive().max(10).nullable().default(null) }))
    .max(5)
    .default([]),
  eligibility: z.object({ countries: z.array(z.string().length(2)).optional(), locales: z.array(z.string()).optional() }).default({}),
  unit: z.enum(['anonymous_id', 'profile']).default('anonymous_id'),
  /** Current conversion rate of the KPI, if measured; with it the sample size is computed. */
  baselineRate: z.number().gt(0).lt(1).nullable().default(null),
  /** Smallest relative lift worth detecting (0.1 = +10 %). */
  minDetectableEffect: z.number().gt(0).max(5).default(0.2),
  maxDurationDays: z.number().int().min(7).max(90).default(28),
  tactic: z.string().min(2).max(120).nullable().default(null),
  channel: z.string().max(40).nullable().default(null),
});

async function dailyUnits(t: DbOrTx, event: string | null, now: Date): Promise<number | null> {
  if (!event) return null;
  const r = await t.execute<{ n: number }>(sql`select count(distinct coalesce(profile_id::text, anonymous_id))::int as n from customer_events where event_name = ${event} and occurred_at >= ${new Date(now.getTime() - 28 * DAY)}`);
  return Math.round(((r.rows[0]?.n ?? 0) / 28) * 10) / 10;
}

/** Sample/data sufficiency: computed from a measured baseline and observed traffic, or 'unknown'. */
export function sufficiencyCheck(input: { baselineRate: number | null; mde: number; dailyUnits: number | null; maxDurationDays: number }) {
  if (input.baselineRate === null) return { status: 'unknown' as const, requiredPerVariant: null, expectedDays: null, reason: 'No measured baseline conversion rate; measure the KPI first (or run a discovery test) before sizing the experiment.' };
  let required: number;
  try {
    required = sampleSizeTwoProportions(input.baselineRate, input.mde);
  } catch (err) {
    return { status: 'insufficient' as const, requiredPerVariant: null, expectedDays: null, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!input.dailyUnits) return { status: 'unknown' as const, requiredPerVariant: required, expectedDays: null, reason: 'No exposure event traffic measured in the last 28 days.' };
  const days = Math.ceil((required * 2) / input.dailyUnits);
  return days <= input.maxDurationDays
    ? { status: 'sufficient' as const, requiredPerVariant: required, expectedDays: days, reason: `${required} per variant at ~${input.dailyUnits}/day ≈ ${days} days (limit ${input.maxDurationDays}).` }
    : { status: 'insufficient' as const, requiredPerVariant: required, expectedDays: days, reason: `Needs ~${days} days at current traffic (${input.dailyUnits}/day), longer than the ${input.maxDurationDays}-day limit; test a bigger change or a higher-traffic step.` };
}

export async function proposePlan(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, actor: Actor, raw: unknown) {
  requireOperator(actor, 'proposing experiments');
  const p = PlanInputSchema.parse(raw);
  await requireFeature(t, tenantId, 'F6', p.brandId);
  const now = deps.clock.now();
  const { config } = await getBrandConfig(t, p.brandId);
  if (p.campaignId) {
    const [c] = await t.select({ brandId: growthCampaigns.brandId }).from(growthCampaigns).where(eq(growthCampaigns.id, p.campaignId));
    if (!c || c.brandId !== p.brandId) throw notFound('campaign');
  }
  const exposure = p.primaryKpi.exposureEvent ?? config.funnel[0]?.events[0] ?? null;
  const sufficiency = sufficiencyCheck({ baselineRate: p.baselineRate, mde: p.minDetectableEffect, dailyUnits: await dailyUnits(t, exposure, now), maxDurationDays: p.maxDurationDays });
  const prior = await t
    .select()
    .from(growthStrategyMemory)
    .where(and(eq(growthStrategyMemory.brandId, p.brandId), eq(growthStrategyMemory.area, p.area)))
    .orderBy(desc(growthStrategyMemory.createdAt))
    .limit(20);
  const sameIdea = prior.filter((m) => normalizeText(m.hypothesis) === normalizeText(p.hypothesis));
  const dedupKey = `plan:${sha256Hex(`${p.brandId}|${p.area}|${normalizeText(p.hypothesis)}|${normalizeText(p.variant.description)}`).slice(0, 40)}`;
  const values = {
    tenantId,
    brandId: p.brandId,
    campaignId: p.campaignId,
    feature: p.feature,
    area: p.area,
    dedupKey,
    hypothesis: p.hypothesis,
    control: p.control,
    variant: p.variant,
    primaryKpi: { ...p.primaryKpi, exposureEvent: exposure },
    guardrails: p.guardrails,
    eligibility: p.eligibility,
    assignment: { method: 'deterministic hash of unit id with a per-experiment salt (M10)', unit: p.unit, weights: { control: 1, variant: 1 } },
    sufficiency: { ...sufficiency, baselineRate: p.baselineRate, minDetectableEffect: p.minDetectableEffect, exposureEvent: exposure },
    stopConditions: [{ kind: 'max_duration', days: p.maxDurationDays }, { kind: 'sample_reached', perVariant: sufficiency.requiredPerVariant }, { kind: 'guardrail_breach', metrics: p.guardrails.map((g) => g.metric) }, { kind: 'sample_ratio_mismatch', alpha: 0.001 }, { kind: 'kill_switch_or_emergency_stop' }],
    measurementPlan: {
      analysis: 'Bayesian two-arm comparison by the M10 analytics job (probability to be best, expected loss), with an SRM check',
      decisionRule: { probBestThreshold: 0.95, maxExpectedLoss: 0.002 },
      assumptions: ['randomized assignment at the unit level', 'one exposure per unit is enough to count it', 'no interference between units', 'pre-registered KPI and guardrails (this plan)'],
      notCausalIf: ['assignment was not random', 'SRM detected', 'the KPI changed during the test'],
      priorFindings: prior.slice(0, 5).map((m) => ({ id: m.id, outcome: m.outcome, summary: m.summary })),
      warnings: sameIdea.filter((m) => m.outcome === 'supported_loser').map((m) => `The same hypothesis lost on ${m.createdAt.toISOString().slice(0, 10)}; re-testing needs a new reason.`),
    },
    status: sufficiency.status === 'insufficient' ? ('insufficient_data' as const) : ('proposed' as const),
    priorMemoryIds: prior.slice(0, 5).map((m) => m.id),
    createdBy: actorRef(actor),
  };
  const [row] = await t
    .insert(growthExperimentPlans)
    .values({ ...values, stopConditions: values.stopConditions as unknown[], guardrails: values.guardrails as unknown[] })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [existing] = await t.select().from(growthExperimentPlans).where(eq(growthExperimentPlans.dedupKey, dedupKey));
    return { plan: existing!, created: false };
  }
  await record(t, tenantId, actor, 'growth.experiment.proposed', { type: 'growth_experiment_plan', id: row.id }, { area: p.area, sufficiency: sufficiency.status, tactic: p.tactic });
  return { plan: row, created: true };
}

/**
 * Approve a plan into a draft M10 experiment (owner/admin + MFA, not the author). The start is a
 * separate M23 action (experiment.start) so policy, approval and verification still apply.
 */
export async function approvePlan(t: Tx, tenantId: string, actor: Actor, planId: string, input: { tactic?: string | null; channel?: string | null } = {}) {
  requireRole(actor, ['owner', 'admin'], 'approving experiment plans');
  requireMfa(actor, 'approving experiment plans');
  const [p] = await t.select().from(growthExperimentPlans).where(eq(growthExperimentPlans.id, planId)).for('update');
  if (!p) throw notFound('experiment plan');
  const s = await requireFeature(t, tenantId, 'F6', p.brandId);
  if (p.status !== 'proposed') throw conflict(`the plan is ${p.status.replaceAll('_', ' ')}`);
  if (p.createdBy === actorRef(actor)) throw forbidden('the author of a plan cannot approve it');
  if ((p.sufficiency as { status?: string }).status === 'insufficient') throw conflict('the plan cannot reach its sample size in time');
  const [running] = await t
    .select({ n: sql<number>`count(*)::int` })
    .from(growthExperimentPlans)
    .where(and(eq(growthExperimentPlans.brandId, p.brandId), inArray(growthExperimentPlans.status, ['approved', 'running'])));
  if ((running?.n ?? 0) >= s.effective.maxParallelExperiments) throw conflict(`${running?.n} experiments are already approved or running for this brand (limit ${s.effective.maxParallelExperiments} at ${s.aggression})`);
  const kpi = p.primaryKpi as { metric: string; type: 'binary' | 'continuous' };
  const suff = p.sufficiency as { requiredPerVariant?: number | null };
  const exp = await createExperiment(t, tenantId, actor, {
    name: `Darwin ${p.area}: ${p.hypothesis.slice(0, 150)}`,
    hypothesis: p.hypothesis,
    design: 'ab_fixed',
    unit: (p.assignment as { unit?: string }).unit === 'profile' ? 'profile' : 'anonymous_id',
    targetMetric: kpi.metric,
    metricType: kpi.type,
    guardrails: (p.guardrails as { metric: string; direction: 'increase_is_bad' | 'decrease_is_bad'; maxRelativeChange: number | null }[]).map((g) => ({ ...g, type: 'binary' })),
    eligibility: p.eligibility,
    riskTier: 'low',
    variants: [
      { key: 'control', description: (p.control as { description: string }).description, config: (p.control as { config?: Record<string, unknown> }).config ?? {}, isControl: true },
      { key: 'variant', description: (p.variant as { description: string }).description, config: (p.variant as { config?: Record<string, unknown> }).config ?? {} },
    ],
    plannedSamplePerVariant: suff.requiredPerVariant ?? null,
    decisionRules: { probBestThreshold: 0.95, maxExpectedLoss: 0.002 },
  });
  const now = new Date();
  await t
    .update(growthExperimentPlans)
    .set({ status: 'approved', experimentId: exp.id, approvedBy: actorRef(actor), approvedAt: now, measurementPlan: { ...(p.measurementPlan as Record<string, unknown>), tactic: input.tactic ?? null, channel: input.channel ?? null }, updatedAt: now })
    .where(eq(growthExperimentPlans.id, planId));
  const [row] = await t.select().from(growthExperimentPlans).where(eq(growthExperimentPlans.id, planId));
  return { plan: row!, experimentId: exp.id };
}

/** Hand an approved plan's experiment start to M23 (experiment.start). */
export async function startPlan(deps: CoreDeps, tenantId: string, actor: Actor, planId: string) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'starting experiments');
  const p = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const [row] = await t.select().from(growthExperimentPlans).where(eq(growthExperimentPlans.id, planId));
    if (!row) throw notFound('experiment plan');
    await requireFeature(t, tenantId, 'F6', row.brandId);
    if (row.status !== 'approved' || !row.experimentId) throw conflict(`the plan is ${row.status}`);
    return row;
  });
  return proposeStart(deps, tenantId, actor, p.experimentId!, {});
}

/* ------------------------------------------------------------------ */
/* Adaptive learning                                                   */
/* ------------------------------------------------------------------ */

type Outcome = 'supported_winner' | 'supported_loser' | 'inconclusive' | 'invalid' | 'guardrail_breach';

/** Map an M10 result to a memory outcome. Only randomized, SRM-clean, decided results are wins/losses. */
export function classifyResult(r: { recommendation: string; srm: Record<string, unknown>; probBest: Record<string, number> }, finished: boolean): Outcome | null {
  if ((r.srm as { mismatch?: boolean }).mismatch === true || r.recommendation === 'invalid_srm') return 'invalid';
  if (r.recommendation === 'guardrail_breach') return 'guardrail_breach';
  if (r.recommendation === 'ship_candidate') return (r.probBest.variant ?? 0) >= (r.probBest.control ?? 0) ? 'supported_winner' : 'supported_loser';
  if (r.recommendation === 'stop_rollback') return 'supported_loser';
  if (finished) return 'inconclusive';
  return null; // still running: nothing to learn yet
}

/** Turn finished experiment results into strategy memory (idempotent per result row). */
export async function syncLearning(deps: Pick<CoreDeps, 'db' | 'clock'>, tenantId: string, brandId?: string) {
  return withTenant(deps.db, { tenantId, actor: 'system:growth-warfare' }, async (t) => {
    const s = await getSettings(t, tenantId);
    if (s.emergencyStop || !s.features.F6) return { recorded: 0, skipped: s.emergencyStop ? 'emergency stop' : 'F6 is off' };
    const plans = await t
      .select()
      .from(growthExperimentPlans)
      .where(and(isNotNull(growthExperimentPlans.experimentId), inArray(growthExperimentPlans.status, ['approved', 'running', 'completed']), brandId ? eq(growthExperimentPlans.brandId, brandId) : undefined));
    let recorded = 0;
    for (const p of plans) {
      const [e] = await t.select().from(experiments).where(eq(experiments.id, p.experimentId!));
      if (!e) continue;
      if (e.status === 'running' && p.status === 'approved') await t.update(growthExperimentPlans).set({ status: 'running', updatedAt: new Date() }).where(eq(growthExperimentPlans.id, p.id));
      const [r] = await t.select().from(experimentResults).where(eq(experimentResults.experimentId, e.id)).orderBy(desc(experimentResults.computedAt)).limit(1);
      if (!r) continue;
      const finished = e.status === 'stopped' || e.status === 'completed';
      const outcome = classifyResult(r, finished);
      if (!outcome) continue;
      const variants = await t.select().from(experimentVariants).where(eq(experimentVariants.experimentId, e.id));
      const mp = p.measurementPlan as { tactic?: string | null; channel?: string | null };
      const concurrent = await t.execute<{ n: number }>(sql`select count(*)::int as n from growth_campaigns where brand_id = ${p.brandId} and status in ('in_flight','approved') and created_at <= ${r.computedAt}`);
      const confounders = [
        ...((concurrent.rows[0]?.n ?? 0) > 0 ? [`${concurrent.rows[0]!.n} campaign(s) were running for the brand during the test (affects both arms equally only if assignment held)`] : []),
        ...(e.startedAt && r.computedAt.getTime() - e.startedAt.getTime() < 7 * DAY ? ['shorter than one week: weekday effects may not be balanced'] : []),
      ];
      const pb = r.probBest;
      const summary =
        outcome === 'supported_winner'
          ? `Variant beat control on ${e.targetMetric}: “${(p.variant as { description: string }).description}” (P(best) ${Math.round((pb.variant ?? 0) * 100)}%).`
          : outcome === 'supported_loser'
            ? `Variant did not beat control on ${e.targetMetric}: “${(p.variant as { description: string }).description}” (P(variant best) ${Math.round((pb.variant ?? 0) * 100)}%).`
            : outcome === 'guardrail_breach'
              ? `A guardrail was breached; the variant must not ship (${e.targetMetric}).`
              : outcome === 'invalid'
                ? 'The test is invalid (sample ratio mismatch); no conclusion is drawn.'
                : `No supported difference on ${e.targetMetric} when the test ended.`;
      const [m] = await t
        .insert(growthStrategyMemory)
        .values({
          tenantId,
          brandId: p.brandId,
          planId: p.id,
          experimentId: e.id,
          resultId: r.id,
          tactic: mp.tactic ?? p.area,
          area: p.area,
          channel: mp.channel ?? null,
          hypothesis: p.hypothesis,
          outcome,
          inferenceKind: 'randomized_test',
          effect: { perVariant: r.perVariant, probBest: r.probBest, expectedLoss: r.expectedLoss, recommendation: r.recommendation, reason: r.recommendationReason, variants: variants.map((v) => ({ key: v.key, description: v.description })) },
          confidence: outcome === 'supported_winner' ? (pb.variant ?? null) : outcome === 'supported_loser' ? (pb.control ?? null) : null,
          confounders,
          context: { experimentStatus: e.status, startedAt: e.startedAt?.toISOString() ?? null, computedAt: r.computedAt.toISOString(), aggression: s.aggression, campaignId: p.campaignId },
          evidenceIds: [],
          summary,
        })
        .onConflictDoNothing()
        .returning({ id: growthStrategyMemory.id });
      if (m) {
        recorded++;
        await record(t, tenantId, GW_ACTOR, 'growth.learning.recorded', { type: 'growth_strategy_memory', id: m.id }, { outcome, experimentId: e.id, resultId: r.id });
      }
      if (finished) await t.update(growthExperimentPlans).set({ status: 'completed', updatedAt: new Date() }).where(eq(growthExperimentPlans.id, p.id));
    }
    // Finished campaigns leave an observational note (never a win or loss).
    const done = await t
      .select()
      .from(growthCampaigns)
      .where(and(inArray(growthCampaigns.status, ['completed', 'expired']), brandId ? eq(growthCampaigns.brandId, brandId) : undefined));
    for (const c of done) {
      const exists = await t.execute<{ n: number }>(sql`select count(*)::int as n from growth_strategy_memory where context->>'campaignId' = ${c.id} and inference_kind = 'observational'`);
      if (exists.rows[0]?.n) continue;
      const tasks = await t.select().from(growthChannelTasks).where(eq(growthChannelTasks.campaignId, c.id));
      const conv = tasks.reduce((n, x) => n + Number((x.outcome as { conversions?: number }).conversions ?? 0), 0);
      const [m] = await t
        .insert(growthStrategyMemory)
        .values({
          tenantId,
          brandId: c.brandId,
          tactic: c.kind,
          area: 'campaign_variant',
          channel: null,
          hypothesis: c.title,
          outcome: 'observational',
          inferenceKind: 'observational',
          effect: { conversionsAttributed: conv, tasks: tasks.map((x) => ({ channel: x.channel, status: x.status, conversions: (x.outcome as { conversions?: number }).conversions ?? null })) },
          confidence: null,
          confounders: ['attribution only: no control group', 'other campaigns and seasonality may explain the numbers'],
          context: { campaignId: c.id, status: c.status },
          summary: `${c.kind} campaign ${c.status}: ${conv} attributed conversion(s) across ${tasks.length} channel task(s). Observational, not a measured lift.`,
        })
        .returning({ id: growthStrategyMemory.id });
      if (m) recorded++;
    }
    return { recorded, skipped: null };
  });
}

/** Tactic priorities from randomized results only (Beta(1+wins, 1+losses) mean); declines flagged. */
export async function tacticPriorities(t: DbOrTx, brandId: string) {
  const rows = await t.select().from(growthStrategyMemory).where(eq(growthStrategyMemory.brandId, brandId)).orderBy(desc(growthStrategyMemory.createdAt)).limit(500);
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.tactic, [...(by.get(r.tactic) ?? []), r]);
  return [...by.entries()]
    .map(([tactic, xs]) => {
      const rnd = xs.filter((x) => x.inferenceKind === 'randomized_test');
      const wins = rnd.filter((x) => x.outcome === 'supported_winner').length;
      const losses = rnd.filter((x) => x.outcome === 'supported_loser' || x.outcome === 'guardrail_breach').length;
      const decided = rnd.filter((x) => x.outcome === 'supported_winner' || x.outcome === 'supported_loser' || x.outcome === 'guardrail_breach');
      const declining =
        decided.length >= 2 && decided[0]!.outcome !== 'supported_winner' && decided[1]!.outcome !== 'supported_winner'
          ? 'two most recent decided tests did not win'
          : decided.length >= 2 && decided[1]!.outcome === 'supported_winner' && decided[0]!.outcome !== 'supported_winner'
            ? 'a previous winner lost its latest test'
            : null;
      return {
        tactic,
        randomizedTests: rnd.length,
        wins,
        losses,
        inconclusive: rnd.filter((x) => x.outcome === 'inconclusive').length,
        invalid: rnd.filter((x) => x.outcome === 'invalid').length,
        observationalNotes: xs.length - rnd.length,
        posteriorMean: Math.round(((1 + wins) / (2 + wins + losses)) * 1000) / 1000,
        declining,
        lastResultAt: rnd[0]?.createdAt.toISOString() ?? null,
      };
    })
    .sort((a, b) => b.posteriorMean - a.posteriorMean || b.randomizedTests - a.randomizedTests);
}

/** Evidence-grounded follow-ups from the latest validated finding per tactic. */
export async function recommendFollowUps(t: DbOrTx, brandId: string) {
  const rows = await t
    .select()
    .from(growthStrategyMemory)
    .where(and(eq(growthStrategyMemory.brandId, brandId), eq(growthStrategyMemory.inferenceKind, 'randomized_test')))
    .orderBy(desc(growthStrategyMemory.createdAt))
    .limit(100);
  const seen = new Set<string>();
  const out = [];
  for (const m of rows) {
    if (seen.has(m.tactic)) continue;
    seen.add(m.tactic);
    const cite = { memoryId: m.id, experimentId: m.experimentId, resultId: m.resultId, outcome: m.outcome, recordedAt: m.createdAt.toISOString() };
    if (m.outcome === 'supported_winner')
      out.push({
        ...cite,
        kind: 'extend_winner',
        recommendation: `Keep the winning ${m.area.replaceAll('_', ' ')} (“${m.summary}”) and test it in a second channel or audience before scaling; scaling spend still needs explicit approval.`,
        nextArea: m.area === 'landing_page' ? 'positioning' : 'landing_page',
        caution: 'One win is not a guarantee; re-test where the context differs.',
      });
    else if (m.outcome === 'supported_loser' || m.outcome === 'guardrail_breach')
      out.push({ ...cite, kind: 'stop_and_pivot', recommendation: `Do not repeat this ${m.area.replaceAll('_', ' ')} variant; test a different angle on the same KPI.`, nextArea: m.area, caution: 'A losing variant says nothing about untested alternatives.' });
    else if (m.outcome === 'inconclusive') out.push({ ...cite, kind: 'resize', recommendation: 'No supported difference: test a bolder change or a higher-traffic step, sized with a measured baseline.', nextArea: m.area, caution: 'Inconclusive is not “no effect”.' });
    else out.push({ ...cite, kind: 'fix_measurement', recommendation: 'Fix assignment (sample ratio mismatch) before re-running; no conclusion was drawn.', nextArea: m.area, caution: 'Invalid tests are excluded from priorities.' });
  }
  return out;
}

/**
 * Lines the Growth Brain and Idea Lab read as context (fenced as untrusted text by the callers).
 * Randomized findings are labelled validated; observational notes are labelled as such; nothing
 * is presented as a forecast or a guarantee.
 */
export async function brainContext(t: DbOrTx, brandId: string, limit = 8): Promise<string[]> {
  const rows = await t
    .select()
    .from(growthStrategyMemory)
    .where(eq(growthStrategyMemory.brandId, brandId))
    .orderBy(desc(growthStrategyMemory.createdAt))
    .limit(limit * 2);
  const follow = await recommendFollowUps(t, brandId);
  const lines = rows
    .sort((a, b) => Number(b.inferenceKind === 'randomized_test') - Number(a.inferenceKind === 'randomized_test'))
    .slice(0, limit)
    .map(
      (m) =>
        `${m.inferenceKind === 'randomized_test' ? '[validated, randomized test]' : '[observational, not validated]'} ${m.tactic} / ${m.area.replaceAll('_', ' ')}${m.channel ? ` / ${m.channel}` : ''}: ${m.summary} (recorded ${m.createdAt.toISOString().slice(0, 10)}${m.confounders.length ? `; confounders: ${m.confounders.join('; ')}` : ''}).`,
    );
  if (!lines.length) return [];
  return [...lines, ...follow.slice(0, 3).map((f) => `[follow-up] ${f.recommendation} (from memory ${f.memoryId}).`), 'Past results describe the conditions they were measured in; they are not a guarantee of future performance.'];
}

export async function listPlans(t: DbOrTx, brandId?: string) {
  return t
    .select()
    .from(growthExperimentPlans)
    .where(brandId ? eq(growthExperimentPlans.brandId, brandId) : undefined)
    .orderBy(desc(growthExperimentPlans.createdAt))
    .limit(200);
}

export async function listMemory(t: DbOrTx, brandId?: string) {
  return t
    .select()
    .from(growthStrategyMemory)
    .where(brandId ? eq(growthStrategyMemory.brandId, brandId) : undefined)
    .orderBy(desc(growthStrategyMemory.createdAt))
    .limit(300);
}

export async function rejectPlan(t: Tx, _tenantId: string, actor: Actor, planId: string, reason: string) {
  requireRole(actor, ['owner', 'admin', 'approver'], 'rejecting experiment plans');
  const [p] = await t.select().from(growthExperimentPlans).where(eq(growthExperimentPlans.id, planId));
  if (!p) throw notFound('experiment plan');
  if (!['proposed', 'insufficient_data'].includes(p.status)) throw invalid(`the plan is ${p.status}`);
  await t
    .update(growthExperimentPlans)
    .set({ status: 'rejected', measurementPlan: { ...(p.measurementPlan as Record<string, unknown>), rejectedReason: reason }, updatedAt: new Date() })
    .where(eq(growthExperimentPlans.id, planId));
  const [row] = await t.select().from(growthExperimentPlans).where(eq(growthExperimentPlans.id, planId));
  return row!;
}
