import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { proof } from '@futuregrow/connectors';
import {
  type DbOrTx,
  type Tx,
  banditStates,
  experimentAssignments,
  experimentExposures,
  experimentOutcomes,
  experimentResults,
  experimentVariants,
  experiments,
  withTenant,
} from '@futuregrow/db';
import { assignVariant, inHoldout } from '@futuregrow/experiments';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef, systemActor } from '../../deps.js';
import { audit, record, requireRole } from '../../util.js';
import { proposeAction } from '../m23-execution/gateway.js';
import { registerHooks, registerInternalExecutor } from '../m23-execution/registry.js';
import { requestAnalytics } from '../m08-analytics/index.js';

const GuardrailSchema = z.object({
  metric: z.string().min(1).max(100),
  type: z.enum(['binary', 'continuous']).default('binary'),
  direction: z.enum(['increase_is_bad', 'decrease_is_bad']),
  maxRelativeChange: z.number().positive().max(10).nullable().default(null),
  maxBreachProbability: z.number().gt(0).lt(1).nullable().default(null),
});

export const ExperimentInputSchema = z
  .object({
    name: z.string().min(3).max(200),
    hypothesis: z.string().min(10).max(4000),
    ideaId: z.string().uuid().nullable().default(null),
    design: z.enum(['ab_fixed', 'bandit_thompson']),
    unit: z.enum(['profile', 'anonymous_id', 'session', 'geo']),
    targetMetric: z.string().min(1).max(100),
    metricType: z.enum(['binary', 'continuous']),
    guardrails: z.array(GuardrailSchema).default([]),
    eligibility: z.object({ countries: z.array(z.string().length(2)).optional(), locales: z.array(z.string()).optional() }).default({}),
    riskTier: z.enum(['low', 'medium', 'high']),
    variants: z
      .array(z.object({ key: z.string().regex(/^[a-z0-9_-]{1,40}$/), description: z.string().min(1).max(1000), config: z.record(z.string(), z.unknown()).default({}), isControl: z.boolean().default(false), weight: z.number().positive().default(1) }))
      .min(2)
      .max(10),
    plannedSamplePerVariant: z.number().int().positive().nullable().default(null),
    holdoutFraction: z.number().min(0).max(0.5).default(0),
    decisionRules: z.object({ probBestThreshold: z.number().gt(0.5).lt(1), maxExpectedLoss: z.number().nonnegative() }).nullable().default(null),
    minExplorationShare: z.number().min(0).max(0.5).nullable().default(null),
  })
  .refine((e) => e.variants.filter((v) => v.isControl).length === 1, { message: 'exactly one control variant is required' })
  .refine((e) => new Set(e.variants.map((v) => v.key)).size === e.variants.length, { message: 'variant keys must be unique' });

export async function createExperiment(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'creating experiments');
  const input = ExperimentInputSchema.parse(raw);
  const [exp] = await tx
    .insert(experiments)
    .values({
      tenantId,
      name: input.name,
      hypothesis: input.hypothesis,
      ideaId: input.ideaId,
      design: input.design,
      unit: input.unit,
      targetMetric: input.targetMetric,
      metricType: input.metricType,
      guardrails: input.guardrails,
      eligibility: input.eligibility,
      riskTier: input.riskTier,
      assignmentSalt: randomBytes(16).toString('hex'),
      plannedSamplePerVariant: input.plannedSamplePerVariant,
      holdoutFraction: input.holdoutFraction,
      decisionRules: input.decisionRules,
      minExplorationShare: input.minExplorationShare,
      createdBy: actorRef(actor),
    })
    .returning();
  for (const v of input.variants) {
    await tx.insert(experimentVariants).values({ tenantId, experimentId: exp!.id, key: v.key, description: v.description, config: v.config, isControl: v.isControl, weight: v.weight });
  }
  await audit(tx, tenantId, actor, 'experiment.experiment.created', { type: 'experiment', id: exp!.id }, { design: input.design, riskTier: input.riskTier });
  return exp!;
}

/** Starting an experiment is a consequential action routed through M23 (policy, approval, proof). */
export async function proposeStart(deps: CoreDeps, tenantId: string, actor: Actor, experimentId: string, opts: { evidenceIds?: string[] } = {}) {
  const exp = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [e] = await tx.select().from(experiments).where(eq(experiments.id, experimentId));
    return e;
  });
  if (!exp) throw notFound('experiment');
  const countries = (exp.eligibility as { countries?: string[] }).countries ?? [];
  return proposeAction(deps, tenantId, actor, {
    actionType: 'experiment.start',
    connectionId: null,
    params: { experimentId },
    evidenceIds: opts.evidenceIds ?? [],
    risk: { geographies: countries },
    idempotencyKey: `experiment-start:${experimentId}`,
  });
}

registerInternalExecutor('experiment.start', {
  async execute(deps, action) {
    const id = (action.params as { experimentId: string }).experimentId;
    const updated = await withTenant(deps.db, { tenantId: action.tenantId, actor: 'system:execution-gateway' }, (tx) =>
      tx
        .update(experiments)
        .set({ status: 'running', startedAt: deps.clock.now() })
        .where(and(eq(experiments.id, id), sql`${experiments.status} in ('draft','approved')`))
        .returning({ id: experiments.id }),
    );
    if (!updated.length) throw new Error('experiment not in a startable state');
    return {
      receipt: { providerRequestId: null, providerObjectId: id, httpStatus: null, responseSha256: null, observedAt: deps.clock.now().toISOString(), details: {} },
      beforeState: { status: 'draft_or_approved' },
      rawResponse: { started: id },
    };
  },
  async verify(deps, action) {
    const id = (action.params as { experimentId: string }).experimentId;
    const [e] = await withTenant(deps.db, { tenantId: action.tenantId, actor: 'system:execution-gateway' }, (tx) =>
      tx.select({ status: experiments.status, startedAt: experiments.startedAt }).from(experiments).where(eq(experiments.id, id)),
    );
    return proof(e?.status === 'running' ? 'VERIFIED' : 'MISMATCH', 'database_readback', { status: 'running' }, { status: e?.status ?? null }, deps.clock.now());
  },
});

registerHooks('experiment.start', {
  async onVerified(tx, action) {
    await record(tx, action.tenantId, systemActor('experiments'), 'experiment.experiment.started', { type: 'experiment', id: (action.params as { experimentId: string }).experimentId }, {});
  },
});

export async function stopExperiment(tx: Tx, tenantId: string, actor: Actor, id: string, reason: string) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'approver'], 'stopping experiments');
  const [e] = await tx.update(experiments).set({ status: 'stopped', endedAt: new Date() }).where(and(eq(experiments.id, id), eq(experiments.status, 'running'))).returning();
  if (!e) throw conflict('experiment is not running');
  await audit(tx, tenantId, actor, 'experiment.experiment.stopped', { type: 'experiment', id }, { reason });
  return e;
}

export interface AssignmentResult {
  variant: string | null;
  holdout: boolean;
  reason?: string;
}

/**
 * Deterministic assignment. Assignment is logged before exposure and outcomes (enforced by DB
 * triggers). Bandits use the latest Thompson allocation computed by the analytics job.
 */
export async function assign(tx: Tx, experimentId: string, unitId: string, attrs: { country?: string; locale?: string } = {}): Promise<AssignmentResult> {
  const [e] = await tx.select().from(experiments).where(eq(experiments.id, experimentId));
  if (!e) throw notFound('experiment');
  if (e.status !== 'running') return { variant: null, holdout: false, reason: `experiment is ${e.status}` };
  const elig = e.eligibility as { countries?: string[]; locales?: string[] };
  if (elig.countries?.length && (!attrs.country || !elig.countries.includes(attrs.country))) return { variant: null, holdout: false, reason: 'not eligible (country)' };
  if (elig.locales?.length && (!attrs.locale || !elig.locales.includes(attrs.locale))) return { variant: null, holdout: false, reason: 'not eligible (locale)' };
  if (inHoldout(e.assignmentSalt, unitId, e.holdoutFraction)) return { variant: null, holdout: true };
  const [existing] = await tx
    .select({ key: experimentVariants.key })
    .from(experimentAssignments)
    .innerJoin(experimentVariants, eq(experimentVariants.id, experimentAssignments.variantId))
    .where(and(eq(experimentAssignments.experimentId, experimentId), eq(experimentAssignments.unitId, unitId)));
  if (existing) return { variant: existing.key, holdout: false };
  const variants = await tx.select().from(experimentVariants).where(eq(experimentVariants.experimentId, experimentId)).orderBy(experimentVariants.key);
  let weights = variants.map((v) => ({ key: v.key, weight: v.weight, id: v.id }));
  if (e.design === 'bandit_thompson') {
    const [b] = await tx.select().from(banditStates).where(eq(banditStates.experimentId, experimentId));
    if (b) weights = variants.map((v) => ({ key: v.key, weight: b.allocation[v.id] ?? 0, id: v.id }));
  }
  const key = assignVariant(e.assignmentSalt, unitId, weights);
  const chosen = weights.find((w) => w.key === key)!;
  await tx
    .insert(experimentAssignments)
    .values({ tenantId: e.tenantId, experimentId, variantId: chosen.id, unitId, allocationSnapshot: Object.fromEntries(weights.map((w) => [w.key, w.weight])) })
    .onConflictDoNothing();
  return { variant: key, holdout: false };
}

/**
 * Exposure/outcome ordering is defined by *server receipt time* (product plan M10: assignment and
 * exposure are logged before outcomes). Client timestamps are not trusted for ordering because of
 * clock skew; the DB triggers compare these server times.
 */
export async function logExposure(tx: Tx, experimentId: string, unitId: string) {
  const [a] = await tx.select().from(experimentAssignments).where(and(eq(experimentAssignments.experimentId, experimentId), eq(experimentAssignments.unitId, unitId)));
  if (!a) throw invalid('unit has no assignment for this experiment');
  await tx.insert(experimentExposures).values({ tenantId: a.tenantId, experimentId, variantId: a.variantId, unitId, exposedAt: sql`now()` });
  return { variantId: a.variantId };
}

export async function logOutcome(tx: Tx, experimentId: string, unitId: string, metric: string, value: number) {
  const [a] = await tx.select().from(experimentAssignments).where(and(eq(experimentAssignments.experimentId, experimentId), eq(experimentAssignments.unitId, unitId)));
  if (!a) throw invalid('unit has no assignment for this experiment');
  await tx.insert(experimentOutcomes).values({ tenantId: a.tenantId, experimentId, variantId: a.variantId, unitId, metric, value, observedAt: sql`now()` });
}

export async function requestAnalysis(tx: Tx, tenantId: string, actor: Actor, experimentId: string) {
  return requestAnalytics(tx, tenantId, actor, 'experiment_analysis', { experimentId });
}

export async function experimentDetail(tx: DbOrTx, id: string) {
  const [e] = await tx.select().from(experiments).where(eq(experiments.id, id));
  if (!e) throw notFound('experiment');
  const [variants, results, bandit, counts] = await Promise.all([
    tx.select().from(experimentVariants).where(eq(experimentVariants.experimentId, id)),
    tx.select().from(experimentResults).where(eq(experimentResults.experimentId, id)).orderBy(desc(experimentResults.computedAt)).limit(5),
    tx.select().from(banditStates).where(eq(banditStates.experimentId, id)),
    tx.execute<{ variant_id: string; assigned: number; exposed: number }>(sql`
      select v.id as variant_id,
        (select count(*) from experiment_assignments a where a.variant_id = v.id)::int as assigned,
        (select count(distinct unit_id) from experiment_exposures x where x.variant_id = v.id)::int as exposed
      from experiment_variants v where v.experiment_id = ${id}`),
  ]);
  return { experiment: e, variants, latestResults: results, bandit: bandit[0] ?? null, counts: counts.rows };
}

export async function listExperiments(tx: DbOrTx) {
  return tx.select().from(experiments).orderBy(desc(experiments.createdAt)).limit(200);
}
