import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { AbstainError, PROMPTS, untrustedBlock } from '@futuregrow/agent-kernel';
import { type ActionRisk, type GrowthDecision, GrowthDecisionSchema, getActionType, listActionTypes } from '@futuregrow/contracts';
import {
  type DbOrTx,
  type Tx,
  connections,
  evidenceRecords,
  experimentResults,
  experiments,
  forecastPoints,
  forecastRuns,
  growthDecisions,
  growthIdeas,
  metricSeries,
  withTenant,
} from '@futuregrow/db';
import { evaluatePolicy } from '@futuregrow/policies';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef } from '../../deps.js';
import { runAgent } from '../../agents.js';
import { record, requireRole } from '../../util.js';
import { getTenantPolicy } from '../m24-governance/index.js';
import { gatherPolicyFacts } from '../m23-execution/facts.js';
import { proposeAction } from '../m23-execution/gateway.js';

const BRAIN_AGENT = 'growth-brain';

const StrategistSchema = z.object({
  abstain: z.boolean(),
  abstainReason: z.string().max(1000),
  objective: z.string().max(500),
  actionType: z.string(),
  connectionId: z.string(),
  paramsJson: z.string().max(20_000),
  rationale: z.string().max(4000),
  assumptions: z.array(z.string().max(500)).max(12),
  counterfactual: z.string().max(1000),
  downside: z.string().max(1000),
});

const CriticSchema = z.object({
  verdict: z.enum(['proceed', 'revise', 'reject']),
  unsupportedAssumptions: z.array(z.string().max(500)).max(12),
  concerns: z.array(z.string().max(500)).max(12),
});

const DAYS = { day: 1, week: 7, month: 30 } as const;
const STEP_DAYS = { hour: 1 / 24, day: 1, week: 7, month: 30 } as const;

/** Spend/audience/geography risk derived deterministically from an action's params. */
export function riskFromParams(actionType: string, params: Record<string, unknown>, market: string): ActionRisk {
  const geographies = market && market.length >= 2 ? [market.toUpperCase()] : [];
  const money = (k: string) => (params[k] as { amountMicros?: number; currency?: string } | undefined) ?? undefined;
  let spendDeltaMicros = 0;
  let currency: string | null = null;
  const next = money('newDailyBudget');
  const prev = money('previousDailyBudget');
  if (next && prev) {
    spendDeltaMicros = (next.amountMicros ?? 0) - (prev.amountMicros ?? 0);
    currency = next.currency ?? null;
  }
  if (params.status === 'ENABLED' || params.status === 'ACTIVE') {
    const d = money('dailyBudget');
    if (d) {
      spendDeltaMicros = d.amountMicros ?? 0;
      currency = d.currency ?? null;
    }
  }
  const disclosure = params.disclosure as { syntheticPersonaId?: string | null; paidPartnership?: boolean } | undefined;
  return {
    spendDeltaMicros,
    currency,
    audienceSize: actionType === 'email.send' ? 1 : null,
    geographies,
    usesSensitiveAttributes: false,
    involvesChildren: false,
    syntheticPersonaId: disclosure?.syntheticPersonaId ?? null,
    materialConnection: disclosure?.paidPartnership === true,
    regulatedClaim: false,
  };
}

export interface ProposeDecisionInput {
  ideaId: string;
  objective?: string;
  market: string;
  horizon: { value: number; unit: 'day' | 'week' | 'month' };
  seriesId?: string;
}

/**
 * Growth Brain cycle (M07): Observer -> Strategist -> Critic -> deterministic scoring -> policy
 * dry-run -> typed GrowthDecision. The Brain holds no credentials and has no write path; an
 * accepted decision becomes an M23 ActionRequest.
 */
export async function proposeDecision(deps: CoreDeps, tenantId: string, actor: Actor, input: ProposeDecisionInput) {
  return runAgent(deps, tenantId, { kind: 'brain_cycle', agentId: BRAIN_AGENT, triggeredBy: actorRef(actor), input: input as unknown as Record<string, unknown> }, async (ctx) => {
    const tctx = { tenantId, actor: `agent:${BRAIN_AGENT}` };

    /* ---------- Observer ---------- */
    const obs = await withTenant(deps.db, tctx, async (tx) => {
      const [idea] = await tx.select().from(growthIdeas).where(eq(growthIdeas.id, input.ideaId));
      if (!idea) throw notFound('idea');
      if (['rejected', 'duplicate', 'invalidated'].includes(idea.status)) throw invalid(`idea is ${idea.status}`);
      const [series] = input.seriesId
        ? await tx.select().from(metricSeries).where(eq(metricSeries.id, input.seriesId))
        : await tx.select().from(metricSeries).where(eq(metricSeries.key, idea.targetMetric));
      const [run] = series
        ? await tx.select().from(forecastRuns).where(and(eq(forecastRuns.seriesId, series.id), ne(forecastRuns.status, 'abstained'))).orderBy(desc(forecastRuns.createdAt)).limit(1)
        : [];
      const points = run ? await tx.select().from(forecastPoints).where(eq(forecastPoints.runId, run.id)).orderBy(forecastPoints.ts) : [];
      const exps = await tx.select().from(experiments).where(eq(experiments.ideaId, idea.id));
      const results = exps.length ? await tx.select().from(experimentResults).where(inArray(experimentResults.experimentId, exps.map((e) => e.id))).orderBy(desc(experimentResults.computedAt)).limit(1) : [];
      const fcEvidence = run ? await tx.select({ id: evidenceRecords.id }).from(evidenceRecords).where(eq(evidenceRecords.sourceUriOrObjectId, `analytics://forecast/${run.id}`)) : [];
      const conns = await tx.select({ id: connections.id, provider: connections.provider, displayName: connections.displayName, externalAccountId: connections.externalAccountId, status: connections.status }).from(connections);
      return { idea, series: series ?? null, run: run ?? null, points, result: results[0] ?? null, fcEvidence: fcEvidence.map((e) => e.id), conns };
    });
    if (!obs.series || !obs.run || obs.points.length === 0) throw new AbstainError('INSUFFICIENT_EVIDENCE', `no usable forecast for target metric "${obs.idea.targetMetric}"`);
    const periods = Math.max(1, Math.min(obs.points.length, Math.round((input.horizon.value * DAYS[input.horizon.unit]) / STEP_DAYS[obs.series.granularity as keyof typeof STEP_DAYS])));
    const window = obs.points.slice(0, periods);
    const sum = (k: 'mean' | 'q10' | 'q50' | 'q90') => window.reduce((s, p) => s + p[k], 0);
    const baseline = { mean: sum('mean'), q10: sum('q10'), q50: sum('q50'), q90: sum('q90') };
    ctx.note('observe', { seriesId: obs.series.id, forecastRunId: obs.run.id, periods, baselineMean: baseline.mean, experimentResultId: obs.result?.id ?? null });

    /* ---------- Strategist ---------- */
    const allow = listActionTypes().filter((a) => a.supported).map((a) => `${a.type} (${a.category}${a.provider === 'internal' ? ', internal' : `, ${a.provider}`}): ${a.description}`);
    const strat = await ctx.think('strategist', PROMPTS.brainStrategist, {
      purpose: 'planning',
      outputSchema: StrategistSchema,
      messages: [
        {
          role: 'user',
          content: [
            `Idea ${obs.idea.id}: ${obs.idea.title}`,
            untrustedBlock('idea', `Hypothesis: ${obs.idea.hypothesis}\nMechanism: ${obs.idea.mechanism}\nAudience: ${obs.idea.audience}\nTarget metric: ${obs.idea.targetMetric}\nKill criteria: ${JSON.stringify(obs.idea.killCriteria)}`),
            `Baseline forecast for ${obs.series.key} over the next ${periods} ${obs.series.granularity}s (no action): mean ${baseline.mean.toFixed(2)}, 80% interval [${baseline.q10.toFixed(2)}, ${baseline.q90.toFixed(2)}] (model ${obs.run.championModel}, ${obs.run.status}).`,
            obs.result ? `Latest experiment result: recommendation ${obs.result.recommendation}; P(best) ${JSON.stringify(obs.result.probBest)}.` : 'No experiment has been run for this idea.',
            `Allowed action types (or "none"):\n${allow.join('\n')}`,
            `Connections:\n${obs.conns.map((c) => `- ${c.id} ${c.provider} "${c.displayName}" account ${c.externalAccountId} (${c.status})`).join('\n') || 'none'}`,
            'Return paramsJson as a JSON object string for the chosen action type, or "{}" when actionType is "none". Use connectionId "" when not applicable.',
          ].join('\n\n'),
        },
      ],
    });
    const s = strat.output;
    if (s.abstain) throw new AbstainError('INSUFFICIENT_EVIDENCE', s.abstainReason || 'strategist abstained');

    /* ---------- Critic ---------- */
    const crit = await ctx.think('critic', PROMPTS.brainCritic, {
      purpose: 'critic',
      outputSchema: CriticSchema,
      messages: [
        {
          role: 'user',
          content: [
            `Idea: ${obs.idea.title}`,
            untrustedBlock('proposal', JSON.stringify({ actionType: s.actionType, params: s.paramsJson, rationale: s.rationale, assumptions: s.assumptions, counterfactual: s.counterfactual, downside: s.downside })),
            `Evidence cited by the idea: ${obs.idea.evidenceIds.length} records; evidence strength ${obs.idea.evidenceStrength.toFixed(2)}.`,
            `Baseline forecast mean ${baseline.mean.toFixed(2)} [${baseline.q10.toFixed(2)}, ${baseline.q90.toFixed(2)}].`,
          ].join('\n\n'),
        },
      ],
    });

    /* ---------- Deterministic validation + scoring ---------- */
    let proposedAction: GrowthDecision['proposedAction'] = null;
    const notes: string[] = [];
    if (s.actionType !== 'none' && crit.output.verdict !== 'reject') {
      const def = getActionType(s.actionType);
      let params: unknown = null;
      try {
        params = JSON.parse(s.paramsJson);
      } catch {
        notes.push('strategist params were not valid JSON');
      }
      if (!def || !def.supported) notes.push(`action type ${s.actionType} is not on the supported allowlist`);
      else if (params !== null) {
        const parsed = def.paramsSchema.safeParse(params);
        const connectionOk = def.provider === 'internal' || obs.conns.some((c) => c.id === s.connectionId && c.provider === def.provider);
        if (!parsed.success) notes.push(`params invalid for ${def.type}: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
        else if (!connectionOk) notes.push('connection does not exist or does not match the action provider');
        else proposedAction = { actionType: def.type, connectionId: def.provider === 'internal' ? null : s.connectionId, target: {}, params: parsed.data as Record<string, unknown>, rationale: s.rationale };
      }
    }
    if (crit.output.verdict === 'reject') notes.push('critic rejected the proposal');

    const effect = (() => {
      const pv = (obs.result?.perVariant as { key: string; relativeLift?: { mean: number; ci95: [number, number]; probPositive: number } }[] | undefined) ?? [];
      const best = obs.result ? Object.entries(obs.result.probBest).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
      const lift = pv.find((v) => v.key === best)?.relativeLift;
      if (!obs.result || obs.result.recommendation !== 'ship_candidate' || !lift) return null;
      return { value: baseline.mean * lift.mean, low: baseline.mean * lift.ci95[0], high: baseline.mean * lift.ci95[1], pPositive: lift.probPositive, ref: `experiment_result:${obs.result.id}` };
    })();
    const def = proposedAction ? getActionType(proposedAction.actionType) : undefined;
    const risk = proposedAction ? riskFromParams(proposedAction.actionType, proposedAction.params, input.market) : riskFromParams('none', {}, input.market);
    const horizonDays = input.horizon.value * DAYS[input.horizon.unit];
    const costModel = obs.idea.costModel as { amount?: number; currency?: string };
    const expectedCost =
      def?.affectsSpend && risk.spendDeltaMicros > 0
        ? { amount: (risk.spendDeltaMicros / 1_000_000) * horizonDays, currency: risk.currency ?? 'USD', basis: `daily spend increase x ${horizonDays} days` }
        : costModel.amount !== undefined
          ? { amount: costModel.amount, currency: costModel.currency ?? 'USD', basis: 'idea cost model' }
          : { amount: 0, currency: 'USD', basis: 'no direct cost identified' };
    const riskScore = effect ? 1 - effect.pPositive : 0.5;

    const policy = await withTenant(deps.db, tctx, (tx) => getTenantPolicy(tx, tenantId));
    let policyResult: GrowthDecision['policyResult'] = { outcome: 'DENY', reasons: ['NO_ACTION_PROPOSED'], policyVersion: 'n/a' };
    let approval: GrowthDecision['approvalRequirement'] = { required: true, roles: ['approver', 'owner'] };
    if (proposedAction) {
      const evidenceIds = [...new Set([...obs.idea.evidenceIds, ...obs.fcEvidence])];
      const decision = await withTenant(deps.db, tctx, async (tx) => {
        const facts = await gatherPolicyFacts(tx, deps, { tenantId, actionId: null, definition: def, params: proposedAction!.params, target: {}, connectionId: proposedAction!.connectionId, evidenceIds, risk, proposer: { type: 'agent', id: BRAIN_AGENT, modelId: strat.servedBy } }, policy);
        return evaluatePolicy({ definition: def, actionType: proposedAction!.actionType, params: proposedAction!.params, risk, proposedBy: { type: 'agent', id: BRAIN_AGENT, modelId: strat.servedBy, promptVersion: PROMPTS.brainStrategist.version }, evidenceIds, tenantPolicy: policy, facts, now: deps.clock.now() });
      });
      policyResult = { outcome: decision.outcome, reasons: decision.reasons.map((r) => r.code), policyVersion: decision.policyVersion };
      approval = { required: decision.outcome !== 'PRE_AUTHORIZED', roles: [...new Set(decision.approvalGroups.flatMap((g) => g.anyOfRoles))] };
    }
    const valuePerUnit = (obs.idea.valueSummary as { valuePerUnit?: { amount: number } | null }).valuePerUnit?.amount ?? null;
    const utility: GrowthDecision['utility'] =
      !policy.lambdas
        ? { status: 'UNSCORED_LAMBDAS_UNCONFIGURED', value: null, components: null }
        : !effect || valuePerUnit === null
          ? { status: 'UNSCORED_INSUFFICIENT_EVIDENCE', value: null, components: null }
          : (() => {
              const ev = effect.value * valuePerUnit;
              const width = (effect.high - effect.low) * valuePerUnit;
              const components = { expectedValue: ev, costTerm: policy.lambdas!.cost * expectedCost.amount, riskTerm: policy.lambdas!.risk * riskScore * Math.abs(ev), uncertaintyTerm: policy.lambdas!.uncertainty * width };
              return { status: 'SCORED' as const, value: ev - components.costTerm - components.riskTerm - components.uncertaintyTerm, components };
            })();
    if (utility.status !== 'SCORED') approval = { ...approval, required: true };

    const decisionId = crypto.randomUUID();
    const decision: GrowthDecision = GrowthDecisionSchema.parse({
      decisionId,
      objective: input.objective ?? (s.objective || `Improve ${obs.idea.targetMetric}`),
      tenantId,
      market: input.market,
      horizon: input.horizon,
      proposedAction,
      evidenceIds: [...new Set([...obs.idea.evidenceIds, ...obs.fcEvidence])],
      predictedOutcomes: {
        metric: obs.series.key,
        distribution: { family: 'empirical', quantiles: [{ q: 0.1, value: baseline.q10 }, { q: 0.5, value: baseline.q50 }, { q: 0.9, value: baseline.q90 }], sampleSize: Math.max(1, Number((obs.run.calibration as { folds?: number }).folds ?? 1)) },
        pointSummary: baseline.mean,
        interval: { level: 0.8, low: baseline.q10, high: baseline.q90 },
        calibrationReference: `forecast_run:${obs.run.id}`,
      },
      estimatedIncrementalEffect: effect ? { value: effect.value, method: 'experiment', uncertainty: { level: 0.95, low: effect.low, high: effect.high }, sourceRef: effect.ref } : { value: null, method: 'unknown', uncertainty: null, sourceRef: null },
      expectedCost,
      downsideRisk: { description: [s.downside, ...crit.output.concerns].filter(Boolean).join(' | ').slice(0, 2000) || 'not stated', p10Outcome: baseline.q10, riskScore },
      assumptions: [
        ...s.assumptions,
        ...crit.output.unsupportedAssumptions.map((a) => `[critic: unsupported] ${a}`),
        'Interval sums per-period forecast quantiles (conservative; not the exact quantile of the sum).',
        ...notes.map((n) => `[validation] ${n}`),
      ].slice(0, 30),
      counterfactualBaseline: { description: `No-action baseline: ${obs.run.championModel} forecast (${obs.run.status}). ${s.counterfactual}`.slice(0, 1000), value: baseline.mean },
      policyResult,
      approvalRequirement: approval,
      modelVersions: {
        strategist: `${strat.servedBy}@${PROMPTS.brainStrategist.name}:${PROMPTS.brainStrategist.version}`,
        critic: `${crit.servedBy}@${PROMPTS.brainCritic.name}:${PROMPTS.brainCritic.version}`,
        forecast: `${obs.run.championModel}@${obs.run.codeVersion}`,
      },
      utility,
      status: 'PROPOSED',
    });
    await withTenant(deps.db, tctx, async (tx) => {
      await tx.insert(growthDecisions).values({
        id: decisionId,
        tenantId,
        objective: decision.objective,
        market: decision.market,
        horizon: decision.horizon,
        proposedAction: decision.proposedAction,
        evidenceIds: decision.evidenceIds,
        predictedOutcomes: decision.predictedOutcomes,
        estimatedIncrementalEffect: decision.estimatedIncrementalEffect,
        expectedCost: decision.expectedCost,
        downsideRisk: decision.downsideRisk,
        assumptions: decision.assumptions,
        counterfactualBaseline: decision.counterfactualBaseline,
        policyResult: decision.policyResult,
        approvalRequirement: decision.approvalRequirement,
        modelVersions: decision.modelVersions,
        utility: decision.utility,
        narrative: s.rationale,
        ideaId: obs.idea.id,
        agentRunId: ctx.runId,
      });
      await record(tx, tenantId, { type: 'agent', id: BRAIN_AGENT, roles: [], mfaVerified: false }, 'brain.decision.proposed', { type: 'growth_decision', id: decisionId }, { ideaId: obs.idea.id, action: decision.proposedAction?.actionType ?? null, policy: policyResult.outcome, utility: utility.status, critic: crit.output.verdict });
    });
    ctx.note('decide', { decisionId, action: proposedAction?.actionType ?? null, critic: crit.output.verdict, utility: utility.status });
    return { decisionId, decision };
  });
}

/** Human acceptance converts a decision into an ActionRequest proposed by the Brain (M23 path). */
export async function acceptDecision(deps: CoreDeps, tenantId: string, actor: Actor, decisionId: string) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'accepting growth decisions');
  const d = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [row] = await tx.select().from(growthDecisions).where(eq(growthDecisions.id, decisionId)).for('update');
    return row ?? null;
  });
  if (!d) throw notFound('decision');
  if (d.status !== 'PROPOSED') throw conflict(`decision is ${d.status}`);
  const pa = d.proposedAction as GrowthDecision['proposedAction'];
  if (!pa) throw invalid('decision has no proposed action');
  const mv = d.modelVersions as Record<string, string>;
  const view = await proposeAction(deps, tenantId, { type: 'agent', id: BRAIN_AGENT, roles: [], mfaVerified: false, modelId: mv.strategist?.split('@')[0] ?? null, promptVersion: PROMPTS.brainStrategist.version }, {
    actionType: pa.actionType,
    connectionId: pa.connectionId,
    target: pa.target,
    params: pa.params,
    decisionId,
    evidenceIds: d.evidenceIds,
    risk: riskFromParams(pa.actionType, pa.params, d.market),
    idempotencyKey: `decision:${decisionId}`,
  });
  await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) =>
    tx.update(growthDecisions).set({ status: 'ACCEPTED', actionId: view.id, decidedBy: actorRef(actor), decidedAt: new Date() }).where(eq(growthDecisions.id, decisionId)),
  );
  return view;
}

export async function rejectDecision(tx: Tx, tenantId: string, actor: Actor, decisionId: string, reason: string) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'approver'], 'rejecting growth decisions');
  const [row] = await tx.update(growthDecisions).set({ status: 'REJECTED', decidedBy: actorRef(actor), decidedAt: new Date() }).where(and(eq(growthDecisions.id, decisionId), eq(growthDecisions.status, 'PROPOSED'))).returning();
  if (!row) throw conflict('decision is not open');
  await record(tx, tenantId, actor, 'brain.decision.abstained', { type: 'growth_decision', id: decisionId }, { rejected: true, reason });
  return row;
}

export async function listDecisions(tx: DbOrTx, limit = 100) {
  return tx.select().from(growthDecisions).orderBy(desc(growthDecisions.createdAt)).limit(limit);
}
