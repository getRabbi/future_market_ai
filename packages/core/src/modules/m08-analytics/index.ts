import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { ANALYTICS_KINDS, type AnalyticsKind } from '@futuregrow/contracts';
import {
  type DbOrTx,
  type Tx,
  analyticsRequests,
  evidenceRecords,
  forecastPoints,
  forecastRuns,
  metricPoints,
  metricSeries,
  mmmRuns,
  propensityModels,
  propensityScores,
  topicClusters,
  trends,
  withTenant,
} from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef, systemActor } from '../../deps.js';
import { registerEventHandlers } from '../../event-handlers.js';
import { audit, record } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';

/* ------------------------------------------------------------------ */
/* Metric series (inputs for M04/M08/M09)                              */
/* ------------------------------------------------------------------ */

export const SeriesInputSchema = z.object({
  key: z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9._:-]*$/),
  name: z.string().min(1).max(300),
  unit: z.string().min(1).max(50),
  granularity: z.enum(['hour', 'day', 'week', 'month']),
  kind: z.enum(['kpi', 'spend', 'exposure', 'signal', 'control']),
  channel: z.string().max(100).nullable().default(null),
  geography: z.string().min(2).max(10).nullable().default(null),
  sourceEvidenceId: z.string().uuid(),
});

export async function upsertSeries(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  const input = SeriesInputSchema.parse(raw);
  const [ev] = await tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, input.sourceEvidenceId));
  if (!ev) throw notFound('source evidence');
  if (ev.status !== 'admitted') throw invalid('series must be backed by admitted evidence');
  const [row] = await tx
    .insert(metricSeries)
    .values({ tenantId, ...input })
    .onConflictDoUpdate({ target: [metricSeries.tenantId, metricSeries.key], set: { name: input.name, unit: input.unit, sourceEvidenceId: input.sourceEvidenceId } })
    .returning();
  await audit(tx, tenantId, actor, 'analytics.series.upserted', { type: 'metric_series', id: row!.id }, { key: input.key });
  return row!;
}

export const PointsSchema = z.array(z.object({ ts: z.string().datetime({ offset: true }), value: z.number().finite(), evidenceId: z.string().uuid().nullable().optional() })).min(1).max(20000);

export async function appendPoints(tx: Tx, tenantId: string, seriesId: string, raw: unknown) {
  const pts = PointsSchema.parse(raw);
  const [s] = await tx.select().from(metricSeries).where(eq(metricSeries.id, seriesId));
  if (!s) throw notFound('series');
  for (let i = 0; i < pts.length; i += 500) {
    const chunk = pts.slice(i, i + 500).map((p) => ({ tenantId, seriesId, ts: new Date(p.ts), value: p.value, evidenceId: p.evidenceId ?? null }));
    await tx.insert(metricPoints).values(chunk).onConflictDoUpdate({ target: [metricPoints.seriesId, metricPoints.ts], set: { value: sql`excluded.value`, evidenceId: sql`excluded.evidence_id`, ingestedAt: new Date() } });
  }
  return { seriesId, upserted: pts.length };
}

export async function getSeriesPoints(tx: DbOrTx, seriesId: string, limit = 5000) {
  return tx.select().from(metricPoints).where(eq(metricPoints.seriesId, seriesId)).orderBy(asc(metricPoints.ts)).limit(limit);
}

/* ------------------------------------------------------------------ */
/* Analytics requests                                                  */
/* ------------------------------------------------------------------ */

const ParamsByKind: Record<AnalyticsKind, z.ZodType> = {
  forecast: z.object({ seriesId: z.string().uuid(), horizon: z.number().int().min(1).max(366), seasonLength: z.number().int().min(1).max(366).optional(), folds: z.number().int().min(4).max(60).optional(), seed: z.number().int().optional() }),
  mmm: z.object({
    kpiSeriesId: z.string().uuid(),
    channelSeriesIds: z.array(z.string().uuid()).min(1).max(12),
    controlSeriesIds: z.array(z.string().uuid()).max(12).default([]),
    experimentPriors: z.array(z.object({ channelSeriesId: z.string().uuid(), liftPerPeriod: z.number(), se: z.number().positive(), experimentId: z.string().uuid() })).default([]),
    totalBudgetPerPeriod: z.number().positive().optional(),
    seed: z.number().int().optional(),
  }),
  experiment_analysis: z.object({ experimentId: z.string().uuid(), seed: z.number().int().optional() }),
  trend_detection: z.object({ seriesIds: z.array(z.string().uuid()).min(1).max(100), alpha: z.number().gt(0).lt(0.5).optional() }),
  topic_clustering: z.object({ corpus: z.enum(['conversations', 'social_interactions', 'search_queries']), sinceDays: z.number().int().min(1).max(365).default(30) }),
  propensity_training: z.object({
    target: z.string().min(3).max(100).default('purchase_next_30d'),
    horizonDays: z.number().int().min(7).max(180).default(30),
    targetEvents: z.array(z.string()).min(1).default(['purchase', 'order_completed']),
    gates: z.object({ minAuc: z.number().min(0.5).max(1), maxEce: z.number().min(0).max(0.5) }).optional(),
  }),
  anomaly_scan: z.object({ seriesIds: z.array(z.string().uuid()).min(1).max(100), threshold: z.number().positive().optional(), recentPoints: z.number().int().positive().optional() }),
  backup_verification: z.object({ objectKey: z.string().min(1), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
};

export async function requestAnalytics(tx: Tx, tenantId: string, actor: Actor, kind: AnalyticsKind, rawParams: unknown, priority = 100) {
  if (!ANALYTICS_KINDS.includes(kind)) throw invalid(`unknown analytics kind ${kind}`);
  // Backups are platform-wide; verification runs as the scheduled backup job, never per tenant.
  if (kind === 'backup_verification') throw invalid('backup verification is a platform operation (python -m futuregrow_analytics.backup verify), not a tenant request');
  const params = ParamsByKind[kind].parse(rawParams) as Record<string, unknown>;
  const [row] = await tx.insert(analyticsRequests).values({ tenantId, kind, params, priority, requestedBy: actorRef(actor) }).returning();
  await record(tx, tenantId, actor, 'analytics.request.queued', { type: 'analytics_request', id: row!.id }, { kind });
  return row!;
}

export async function getRequest(tx: DbOrTx, id: string) {
  const [r] = await tx.select().from(analyticsRequests).where(eq(analyticsRequests.id, id));
  if (!r) throw notFound('analytics request');
  return r;
}

export async function listRequests(tx: DbOrTx, limit = 100) {
  return tx.select().from(analyticsRequests).orderBy(desc(analyticsRequests.requestedAt)).limit(Math.min(limit, 500));
}

export async function forecastDetail(tx: DbOrTx, runId: string) {
  const [run] = await tx.select().from(forecastRuns).where(eq(forecastRuns.id, runId));
  if (!run) throw notFound('forecast run');
  const points = await tx.select().from(forecastPoints).where(eq(forecastPoints.runId, runId)).orderBy(asc(forecastPoints.ts));
  return { run, points };
}

export async function latestForecast(tx: DbOrTx, seriesId: string) {
  const [run] = await tx.select().from(forecastRuns).where(eq(forecastRuns.seriesId, seriesId)).orderBy(desc(forecastRuns.createdAt)).limit(1);
  return run ? forecastDetail(tx, run.id) : null;
}

export async function mmmDetail(tx: DbOrTx, runId: string) {
  const [run] = await tx.select().from(mmmRuns).where(eq(mmmRuns.id, runId));
  if (!run) throw notFound('mmm run');
  return run;
}

export async function listTrends(tx: DbOrTx, limit = 100) {
  return tx.select().from(trends).orderBy(desc(trends.createdAt)).limit(limit);
}

export async function listTopics(tx: DbOrTx, limit = 100) {
  return tx.select().from(topicClusters).orderBy(desc(topicClusters.createdAt)).limit(limit);
}

export async function propensityDetail(tx: DbOrTx, modelId: string, top = 100) {
  const [model] = await tx.select().from(propensityModels).where(eq(propensityModels.id, modelId));
  if (!model) throw notFound('propensity model');
  const scores = await tx.select().from(propensityScores).where(eq(propensityScores.modelId, modelId)).orderBy(desc(propensityScores.score)).limit(top);
  return { model, scores };
}

/* ------------------------------------------------------------------ */
/* Completed analytics -> evidence (feedback loop into M01)            */
/* ------------------------------------------------------------------ */

/**
 * Confidence of a model-output evidence record is a *measured* quantity, never a guess:
 *   forecast -> min(1, empirical 80% coverage / 0.8) from the conformal backtest (0 if abstained)
 *   mmm      -> share of parameters whose R-hat passes the gate (0 when abstained)
 *   others   -> 1 for deterministic computations over admitted data
 * Only validated outputs (calibrated champion/baseline, converged MMM) may drive automation.
 */
export async function admitAnalyticsEvidence(tx: Tx, deps: CoreDeps, tenantId: string, requestId: string) {
  const req = await getRequest(tx, requestId);
  if (req.status !== 'completed' || !req.resultRef) return null;
  const actor = systemActor('analytics-evidence');
  const summary = (req.resultSummary ?? {}) as Record<string, unknown>;
  let confidence = 1;
  let automationOk = true;
  let parents: string[] = [];
  let content: Record<string, unknown> = { kind: req.kind, resultRef: req.resultRef, summary };
  if (req.kind === 'forecast') {
    const { run } = await forecastDetail(tx, req.resultRef);
    const cov = Number((run.calibration as { coverage80?: number }).coverage80);
    confidence = run.status === 'abstained' || !Number.isFinite(cov) ? 0 : Math.min(1, cov / 0.8);
    automationOk = run.status !== 'abstained' && (run.gate as { configured?: boolean }).configured === true;
    parents = summary.sourceEvidenceId ? [String(summary.sourceEvidenceId)] : [];
    content = { ...content, status: run.status, champion: run.championModel, calibration: run.calibration };
  } else if (req.kind === 'mmm') {
    const run = await mmmDetail(tx, req.resultRef);
    const rhat = (run.diagnostics as { rhat?: Record<string, number>; gates?: { maxRhat: number } }).rhat ?? {};
    const gate = (run.diagnostics as { gates?: { maxRhat: number } }).gates?.maxRhat ?? 1.01;
    const vals = Object.values(rhat);
    confidence = vals.length ? vals.filter((v) => v <= gate).length / vals.length : 0;
    automationOk = run.converged;
    parents = Array.isArray(summary.sourceEvidenceIds) ? (summary.sourceEvidenceIds as string[]) : [];
    content = { ...content, converged: run.converged, causalLanguageAllowed: run.causalLanguageAllowed };
  }
  const validParents = parents.length ? (await tx.select({ id: evidenceRecords.id }).from(evidenceRecords).where(inArray(evidenceRecords.id, parents))).map((p) => p.id) : [];
  return admitInternalEvidence(tx, tenantId, actor, {
    kind: 'model_output',
    owner: 'futuregrow-analytics',
    uri: `analytics://${req.kind}/${req.resultRef}`,
    content,
    summary: `${req.kind} result ${req.resultRef}`,
    confidence,
    license: 'derived from first-party evidence',
    permittedUses: automationOk ? ['analytics', 'forecasting', 'causal_measurement', 'autonomous_execution'] : ['analytics', 'forecasting'],
    parents: validParents,
    freshnessSlaHours: req.kind === 'forecast' ? 24 * 7 : req.kind === 'mmm' ? 24 * 30 : 24 * 7,
    now: deps.clock.now(),
  });
}

registerEventHandlers((bus, deps) => {
  bus.on('analytics.request.completed', 'analytics-evidence', async (ev) => {
    await withTenant(deps.db, { tenantId: ev.tenantId, actor: 'system:analytics-evidence' }, async (tx) => {
      const existing = await tx
        .select({ id: evidenceRecords.id })
        .from(evidenceRecords)
        .where(and(eq(evidenceRecords.kind, 'model_output'), eq(evidenceRecords.sourceUriOrObjectId, `analytics://${String(ev.payload.kind)}/${String(ev.payload.resultRef)}`)));
      if (existing.length || !ev.payload.resultRef) return; // idempotent redelivery
      const e = await admitAnalyticsEvidence(tx, deps, ev.tenantId, ev.aggregateId);
      await audit(tx, ev.tenantId, systemActor('analytics-job'), 'analytics.request.completed', { type: 'analytics_request', id: ev.aggregateId }, { kind: ev.payload.kind, evidenceId: e?.evidenceId ?? null });
    });
  });
});
