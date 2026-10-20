import { desc, eq, inArray, sql } from 'drizzle-orm';
import { PROMPTS, untrustedBlock } from '@futuregrow/agent-kernel';
import { type DbOrTx, type Tx, evidenceRecords, growthIdeas, topicClusters, trends, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef, systemActor } from '../../deps.js';
import { runAgent } from '../../agents.js';
import { normalizeText, record, requireRole } from '../../util.js';
import { getTenantPolicy } from '../m24-governance/index.js';
import { featureGaps, listObservations } from '../m05-competitors/index.js';
import { effectiveFreshness } from '../m23-execution/facts.js';

/* ------------------------------------------------------------------ */
/* Screening                                                           */
/* ------------------------------------------------------------------ */

const DECEPTIVE = [
  /\b(buy|purchase|fake|bought)\s+(followers|likes|reviews|views|engagement|comments)\b/i,
  /\bfake (reviews?|testimonials?|accounts?|customers?)\b/i,
  /\b(astroturf|sockpuppet|bot (farm|accounts)|review swap|incentivi[sz]ed (positive )?reviews?)\b/i,
  /\b(spam|cold[- ]blast|scrape (personal|private)|harvest (emails|contacts))\b/i,
  /\b(impersonat\w+|pose as|pretend to be (a )?(customer|user|celebrity))\b/i,
  /\b(hidden (fees?|charges?)|hard to cancel|roach motel|bait and switch|fake (scarcity|countdown|urgency))\b/i,
  /\b(bypass|circumvent|evade)\s+(captcha|rate limits?|platform rules|detection|terms)\b/i,
];
const SENSITIVE_AUDIENCE = /\b(age[sd]?|teen|kids?|children|minors?|race|ethnic|religio|gay|lesbian|lgbt|pregnan|disabilit|illness|diagnos|health condition|immigra|political|union member)\b/i;

export function screenIdea(text: { title: string; hypothesis: string; mechanism: string; audience: string }) {
  const all = `${text.title} ${text.hypothesis} ${text.mechanism}`;
  const deceptive = DECEPTIVE.filter((re) => re.test(all) || re.test(text.audience)).map((r) => r.source);
  const sensitive = SENSITIVE_AUDIENCE.test(text.audience);
  const reasons = [...(deceptive.length ? ['deceptive or prohibited growth tactic'] : []), ...(sensitive ? ['audience defined by sensitive attributes or minors'] : [])];
  return { passed: reasons.length === 0, reasons, deceptivePatterns: deceptive, sensitiveAudience: sensitive };
}

/* ------------------------------------------------------------------ */
/* Value model (product plan IdeaValue)                               */
/* ------------------------------------------------------------------ */

export interface ValueInputs {
  /** Historical success prior from the tenant's own experiments. */
  prior: { successes: number; failures: number };
  /** Incremental impact in target-metric units per period, as a range (p10, p90). */
  impact: { p10: number; p90: number; periods: number } | null;
  valuePerUnit: number | null;
  expectedCost: number | null;
  riskScore: number;
  lambdas: { risk: number; cost: number; uncertainty: number } | null;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gammaSample(k: number, rnd: () => number): number {
  // Marsaglia-Tsang for k >= 1, boost for k < 1.
  if (k < 1) return gammaSample(k + 1, rnd) * rnd() ** (1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      const u1 = rnd() || 1e-12;
      const u2 = rnd();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(rnd: () => number) {
  return Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
}

const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.floor(p * (xs.length - 1))))]!;

/**
 * IdeaValue = P(success | evidence) * IncrementalImpact * valuePerUnit - ExpectedCost - RiskPenalty,
 * sampled by Monte Carlo. Inputs that are unknown [U] produce an explicit unscored status instead
 * of a number; P(success) comes from the tenant's own experiment history, never from a model.
 */
export function scoreIdea(v: ValueInputs, seed = 42, draws = 20_000) {
  const a = 1 + v.prior.successes;
  const b = 1 + v.prior.failures;
  const pMean = a / (a + b);
  if (!v.impact || v.valuePerUnit === null || v.expectedCost === null) {
    return { status: 'unscored', reason: !v.impact ? 'impact range unknown [U]' : v.valuePerUnit === null ? 'value per unit unknown [U]' : 'cost unknown [U]', pSuccess: { alpha: a, beta: b, mean: pMean } } as const;
  }
  const rnd = mulberry32(seed);
  const mu = (v.impact.p10 + v.impact.p90) / 2;
  const sd = Math.max((v.impact.p90 - v.impact.p10) / 2.5631, 1e-12); // p10..p90 of a normal
  const out: number[] = [];
  for (let i = 0; i < draws; i++) {
    const ga = gammaSample(a, rnd);
    const gb = gammaSample(b, rnd);
    const p = ga / (ga + gb);
    const impact = (mu + sd * normalSample(rnd)) * v.impact.periods;
    const success = rnd() < p;
    out.push((success ? impact : 0) * v.valuePerUnit - v.expectedCost);
  }
  out.sort((x, y) => x - y);
  const mean = out.reduce((s, x) => s + x, 0) / out.length;
  const width = q(out, 0.9) - q(out, 0.1);
  const riskPenalty = v.lambdas ? v.lambdas.risk * v.riskScore * Math.abs(mean) + v.lambdas.uncertainty * width : null;
  return {
    status: v.lambdas ? 'scored' : 'scored_without_risk_penalty',
    reason: v.lambdas ? null : 'risk/uncertainty lambdas unconfigured [U]',
    pSuccess: { alpha: a, beta: b, mean: pMean },
    value: { mean, p10: q(out, 0.1), p50: q(out, 0.5), p90: q(out, 0.9), probPositive: out.filter((x) => x > 0).length / out.length },
    riskPenalty,
    riskAdjustedMean: riskPenalty === null ? null : mean - riskPenalty,
  } as const;
}

/** Per-variant sample size for a two-proportion test (normal approximation). */
export function sampleSizeTwoProportions(baseline: number, mde: number, alpha = 0.05, power = 0.8): number {
  const p1 = baseline;
  const p2 = baseline * (1 + mde);
  if (p1 <= 0 || p1 >= 1 || p2 <= 0 || p2 >= 1) throw invalid('baseline and lifted rate must be in (0, 1)');
  const z = (p: number): number => {
    // Acklam inverse normal (sufficient precision for planning)
    const a1 = -39.69683028665376, a2 = 220.9460984245205, a3 = -275.928510446969, a4 = 138.357751867269, a5 = -30.66479806614716, a6 = 2.506628277459239;
    const b1 = -54.47609879822406, b2 = 161.5858368580409, b3 = -155.6989798598866, b4 = 66.80131188771972, b5 = -13.28068155288572;
    const c1 = -0.007784894002430293, c2 = -0.3223964580411365, c3 = -2.400758277161838, c4 = -2.549732539343734, c5 = 4.374664141464968, c6 = 2.938163982698783;
    const d1 = 0.007784695709041462, d2 = 0.3224671290700398, d3 = 2.445134137142996, d4 = 3.754408661907416;
    if (p < 0.02425) {
      const qq = Math.sqrt(-2 * Math.log(p));
      return (((((c1 * qq + c2) * qq + c3) * qq + c4) * qq + c5) * qq + c6) / ((((d1 * qq + d2) * qq + d3) * qq + d4) * qq + 1);
    }
    if (p > 1 - 0.02425) return -z(1 - p);
    const qq = p - 0.5;
    const r = qq * qq;
    return ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * qq) / (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
  };
  const za = z(1 - alpha / 2);
  const zb = z(power);
  const pbar = (p1 + p2) / 2;
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2;
  return Math.ceil(n);
}

async function historicalPrior(tx: DbOrTx) {
  const res = await tx.execute<{ wins: number; losses: number }>(sql`
    select count(*) filter (where recommendation = 'ship_candidate')::int as wins,
           count(*) filter (where recommendation in ('stop_rollback','guardrail_breach'))::int as losses
    from (select distinct on (experiment_id) experiment_id, recommendation from experiment_results order by experiment_id, computed_at desc) r`);
  return { successes: res.rows[0]?.wins ?? 0, failures: res.rows[0]?.losses ?? 0 };
}

function jaccard(a: string, b: string) {
  const A = new Set(normalizeText(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(normalizeText(b).split(' ').filter((w) => w.length > 2));
  const inter = [...A].filter((x) => B.has(x)).length;
  return A.size + B.size === 0 ? 0 : inter / (A.size + B.size - inter);
}

/* ------------------------------------------------------------------ */
/* Ideas                                                               */
/* ------------------------------------------------------------------ */

export const IdeaInputSchema = z.object({
  title: z.string().min(5).max(200),
  hypothesis: z.string().min(20).max(2000),
  mechanism: z.string().min(10).max(2000),
  audience: z.string().min(3).max(500),
  targetMetric: z.string().min(2).max(100),
  evidenceIds: z.array(z.string().uuid()).min(1).max(30),
  impact: z.object({ p10: z.number(), p90: z.number(), periods: z.number().int().positive(), basis: z.string().min(3) }).refine((i) => i.p90 >= i.p10, 'p90 must be >= p10').nullable().default(null),
  valuePerUnit: z.object({ amount: z.number().nonnegative(), currency: z.string().length(3), evidenceId: z.string().uuid() }).nullable().default(null),
  expectedCost: z.object({ amount: z.number().nonnegative(), currency: z.string().length(3), basis: z.string().min(3) }).nullable().default(null),
  test: z
    .object({ type: z.enum(['ab_test', 'holdout', 'discovery_survey', 'smoke_test', 'geo_test']), baselineRate: z.number().gt(0).lt(1).optional(), minimumDetectableEffect: z.number().gt(0).lt(5).optional() })
    .default({ type: 'ab_test' }),
  killCriteria: z.array(z.string().min(5).max(500)).min(1).max(10),
  risks: z.array(z.string().max(500)).max(10).default([]),
});
export type IdeaInput = z.infer<typeof IdeaInputSchema>;

export async function createIdea(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown, source: 'agent' | 'human', agentRunId: string | null = null) {
  const input = IdeaInputSchema.parse(raw);
  const now = deps.clock.now();
  const ev = await tx.select().from(evidenceRecords).where(inArray(evidenceRecords.id, input.evidenceIds));
  if (ev.length !== new Set(input.evidenceIds).size) throw invalid('evidence not found');
  const trusted = ev.filter((e) => e.status === 'admitted' && effectiveFreshness(e, now) !== 'stale');
  if (!trusted.length) throw invalid('ideas must cite at least one admitted, non-stale evidence record');
  const evidenceStrength = Math.min(1, trusted.length / 3) * (trusted.reduce((s, e) => s + (e.confidence ?? 0), 0) / trusted.length);

  const screening = screenIdea(input);
  const existing = await tx.select({ id: growthIdeas.id, title: growthIdeas.title, hypothesis: growthIdeas.hypothesis }).from(growthIdeas).where(sql`${growthIdeas.status} <> 'rejected'`).limit(2000);
  let duplicateOf: string | null = null;
  let maxSim = 0;
  for (const e of existing) {
    const s = jaccard(`${input.title} ${input.hypothesis}`, `${e.title} ${e.hypothesis}`);
    if (s > maxSim) maxSim = s;
    if (s >= 0.6 && !duplicateOf) duplicateOf = e.id;
  }
  const policy = await getTenantPolicy(tx, tenantId);
  const currencyOk = !input.expectedCost || !input.valuePerUnit || input.expectedCost.currency === input.valuePerUnit.currency;
  if (!currencyOk) throw invalid('cost and value per unit must use the same currency');
  const riskScore = Math.min(1, (input.risks.length * 0.1) + (screening.passed ? 0 : 1));
  const value = scoreIdea({
    prior: await historicalPrior(tx),
    impact: input.impact,
    valuePerUnit: input.valuePerUnit?.amount ?? null,
    expectedCost: input.expectedCost?.amount ?? null,
    riskScore,
    lambdas: policy.lambdas,
  });
  let sampleSize: number | null = null;
  if (input.test.baselineRate && input.test.minimumDetectableEffect) sampleSize = sampleSizeTwoProportions(input.test.baselineRate, input.test.minimumDetectableEffect);
  const route = !screening.passed ? 'reject' : value.status === 'unscored' || evidenceStrength < 0.5 ? 'discovery_test' : 'full_test';
  const [row] = await tx
    .insert(growthIdeas)
    .values({
      tenantId,
      title: input.title,
      hypothesis: input.hypothesis,
      mechanism: input.mechanism,
      audience: input.audience,
      targetMetric: input.targetMetric,
      evidenceIds: input.evidenceIds,
      impactModel: input.impact ?? { status: 'unknown' },
      costModel: input.expectedCost ?? { status: 'unknown' },
      riskModel: { riskScore, risks: input.risks, basis: 'count of identified risks + screening' },
      successPrior: { family: 'beta', alpha: value.pSuccess.alpha, beta: value.pSuccess.beta, source: 'tenant experiment history' },
      valueSummary: { ...value, valuePerUnit: input.valuePerUnit },
      evidenceStrength,
      testDesign: { ...input.test, sampleSizePerVariant: sampleSize },
      killCriteria: input.killCriteria,
      noveltyScore: 1 - maxSim,
      duplicateOfId: duplicateOf,
      screening,
      route,
      status: !screening.passed ? 'rejected' : duplicateOf ? 'duplicate' : 'candidate',
      source,
      agentRunId,
      createdBy: actorRef(actor),
    })
    .returning();
  await record(tx, tenantId, actor, 'idea.growth_idea.ranked', { type: 'growth_idea', id: row!.id }, { route, status: row!.status, value: value.status });
  return row!;
}

export async function setIdeaStatus(tx: Tx, tenantId: string, actor: Actor, id: string, status: 'queued_for_test' | 'testing' | 'validated' | 'invalidated' | 'rejected') {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'approver'], 'changing idea status');
  const [row] = await tx.update(growthIdeas).set({ status, updatedAt: new Date() }).where(eq(growthIdeas.id, id)).returning();
  if (!row) throw notFound('idea');
  await record(tx, tenantId, actor, 'idea.growth_idea.ranked', { type: 'growth_idea', id }, { status });
  return row;
}

export async function rankedIdeas(tx: DbOrTx, limit = 100) {
  const rows = await tx.select().from(growthIdeas).where(inArray(growthIdeas.status, ['candidate', 'queued_for_test', 'testing', 'validated'])).orderBy(desc(growthIdeas.createdAt)).limit(500);
  const key = (r: typeof rows[number]) => {
    const v = r.valueSummary as { riskAdjustedMean?: number | null; value?: { mean: number } };
    return v.riskAdjustedMean ?? v.value?.mean ?? Number.NEGATIVE_INFINITY;
  };
  return rows.sort((a, b) => key(b) - key(a) || b.evidenceStrength - a.evidenceStrength).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Model-assisted idea generation                                      */
/* ------------------------------------------------------------------ */

const GeneratedSchema = z.object({
  abstain: z.boolean(),
  abstainReason: z.string().max(500),
  ideas: z
    .array(
      z.object({
        title: z.string(),
        hypothesis: z.string(),
        mechanism: z.string(),
        audience: z.string(),
        targetMetric: z.string(),
        evidenceIds: z.array(z.string()),
        cheapFirstTest: z.enum(['ab_test', 'holdout', 'discovery_survey', 'smoke_test', 'geo_test']),
        killCriteria: z.array(z.string()),
        risks: z.array(z.string()),
      }),
    )
    .max(8),
});

export async function generateIdeas(deps: CoreDeps, tenantId: string, actor: Actor, opts: { maxIdeas?: number } = {}) {
  return runAgent(deps, tenantId, { kind: 'idea_generation', agentId: 'idea-lab', triggeredBy: actorRef(actor), input: opts }, async (ctx) => {
    const material = await withTenant(deps.db, { tenantId, actor: 'agent:idea-lab' }, async (tx) => {
      const now = deps.clock.now();
      const ev = (await tx.select().from(evidenceRecords).where(eq(evidenceRecords.status, 'admitted')).orderBy(desc(evidenceRecords.createdAt)).limit(60)).filter((e) => effectiveFreshness(e, now) !== 'stale').slice(0, 30);
      const tr = (await tx.select().from(trends).orderBy(desc(trends.createdAt)).limit(20)).filter((t) => t.direction !== 'flat');
      const topics = await tx.select().from(topicClusters).orderBy(desc(topicClusters.createdAt)).limit(10);
      const obs = (await listObservations(tx)).slice(0, 20);
      const gaps = (await featureGaps(tx)).slice(0, 20);
      return { ev, tr, topics, obs, gaps };
    });
    if (material.ev.length === 0) {
      ctx.note('observe', { evidence: 0 });
      return { created: [], abstained: 'no admitted evidence' };
    }
    ctx.note('observe', { evidence: material.ev.length, trends: material.tr.length, topics: material.topics.length, observations: material.obs.length, gaps: material.gaps.length });
    const allowedIds = new Set(material.ev.map((e) => e.id));
    for (const t of material.tr) for (const id of t.evidenceIds) allowedIds.add(id);
    for (const o of material.obs) for (const id of o.evidenceIds) allowedIds.add(id);
    const evidenceText = material.ev.map((e) => `- evidence ${e.id} [${e.kind}, ${e.sourceType}, confidence ${e.confidence}]: ${e.summary ?? ''}`).join('\n');
    const trendText = material.tr.map((t) => `- trend in "${t.topic}": ${t.direction}, Sen slope ${t.senSlope?.toFixed(3)}, confidence ${t.confidence.toFixed(2)}, evidence ${t.evidenceIds.join(',')}`).join('\n');
    const topicText = material.topics.map((t) => `- customer topic "${t.label}" (${t.size} messages): ${t.terms.slice(0, 6).join(', ')}`).join('\n');
    const obsText = material.obs.map((o) => `- [${o.evidenceFlag}] ${o.kind}: ${o.summary} (evidence ${o.evidenceIds.join(',')})`).join('\n');
    const gapText = material.gaps.map((g) => `- [I] ${g.competitor} lists "${g.feature}" (evidence ${g.evidenceId})`).join('\n');
    const r = await ctx.think('strategize', PROMPTS.ideaGeneration, {
      purpose: 'generation',
      outputSchema: GeneratedSchema,
      messages: [
        {
          role: 'user',
          content: `Generate up to ${opts.maxIdeas ?? 5} growth hypotheses.\n\nEvidence summaries:\n${untrustedBlock('evidence', evidenceText)}\n\nTrends:\n${untrustedBlock('trends', trendText || 'none')}\n\nCustomer language:\n${untrustedBlock('topics', topicText || 'none')}\n\nCompetitor observations:\n${untrustedBlock('competitors', obsText || 'none')}\n\nPotential gaps:\n${untrustedBlock('gaps', gapText || 'none')}`,
        },
      ],
    });
    if (r.output.abstain) return { created: [], abstained: r.output.abstainReason };
    const created: string[] = [];
    const rejected: { title: string; reason: string }[] = [];
    await withTenant(deps.db, { tenantId, actor: 'agent:idea-lab' }, async (tx) => {
      for (const idea of r.output.ideas) {
        const cited = idea.evidenceIds.filter((id) => allowedIds.has(id));
        if (cited.length !== idea.evidenceIds.length || cited.length === 0) {
          rejected.push({ title: idea.title, reason: 'cited evidence that was not provided' });
          continue;
        }
        try {
          const row = await createIdea(
            tx,
            deps,
            tenantId,
            systemActor('idea-lab'),
            { ...idea, evidenceIds: cited, test: { type: idea.cheapFirstTest }, killCriteria: idea.killCriteria.length ? idea.killCriteria : ['no measurable improvement in the target metric'] },
            'agent',
            ctx.runId,
          );
          created.push(row.id);
        } catch (err) {
          rejected.push({ title: idea.title, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    });
    ctx.note('validate', { proposed: r.output.ideas.length, created: created.length, rejected });
    return { created, rejected };
  });
}

