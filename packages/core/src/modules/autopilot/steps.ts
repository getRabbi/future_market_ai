import { type BlockNeed, getActionType, type TaskKind } from '@futuregrow/contracts';
import {
  analyticsRequests,
  appStoreReports,
  claims,
  competitorObservations,
  connections,
  creativeBriefs,
  evidenceRecords,
  experimentResults,
  experiments,
  forecastRuns,
  type goalCycles,
  type goalTasks,
  growthDecisions,
  growthIdeas,
  metricPoints,
  metricSeries,
  seoAudits,
  type Tx,
  trends,
  withTenant,
} from '@futuregrow/db';
import { and, desc, eq, gte, inArray, isNull, lt, max, min, or, sql } from 'drizzle-orm';
import { type CoreDeps, systemActor } from '../../deps.js';
import { generateIdeas, rankedIdeas } from '../m06-ideas/index.js';
import { autoAcceptDecision, proposeDecision, riskFromParams } from '../m07-brain/index.js';
import { requestAnalytics } from '../m08-analytics/index.js';
import { requestAnalysis } from '../m10-experiments/index.js';
import { generateBrief } from '../m13-creative/index.js';
import { FACEBOOK_INSIGHT_SERIES, isFacebookInsightsKey, postForPublishAction, syncPageInsights } from '../m16-social/index.js';
import { keywordOpportunities, queueSeoAudit } from '../m18-discovery/index.js';
import { DOWNLOADS_SERIES_KEY, syncDownloadsSeries } from '../m19-app-growth/index.js';
import { approvedJurisdictions, getTenantPolicy } from '../m24-governance/index.js';
import { type GoalRow, goalActions, goalCategories, goalKpi } from './goals.js';

export type CycleRow = typeof goalCycles.$inferSelect;
export type TaskRow = typeof goalTasks.$inferSelect;

export const AUTOPILOT = systemActor('autopilot');
const ACTOR_REF = 'system:autopilot';
const DAY = 86_400_000;
/**
 * The forecasting engine needs 2·season+2 values plus half its backtest folds beyond the horizon
 * (daily season 7, 20 folds → 26 + horizon); the shortest useful horizon is a week.
 */
const FORECAST_OVERHEAD = 26;
export const MIN_KPI_POINTS = FORECAST_OVERHEAD + 7;
/** Action states after which nothing more happens without a new proposal. */
export const SETTLED_ACTION_STATES = ['VERIFIED', 'FAILED', 'DENIED', 'REJECTED', 'CANCELLED', 'ROLLED_BACK', 'ESCALATED'];

export interface StepContext {
  deps: CoreDeps;
  tenantId: string;
  goal: GoalRow;
  cycle: CycleRow;
  task: TaskRow;
  /** Earlier steps of this cycle, by kind. */
  prior: Partial<Record<TaskKind, TaskRow>>;
  aiCallsLeft: number;
  now: Date;
}

type Out = { output?: Record<string, unknown>; refs?: Record<string, string | undefined>; aiCalls?: number };
export type StepResult =
  | ({ kind: 'completed'; detail: string } & Out)
  | ({ kind: 'skipped'; detail: string } & Out)
  | ({ kind: 'blocked'; detail: string; needs: BlockNeed } & Out)
  | ({ kind: 'waiting'; detail: string; recheckAt: Date; maxWaitHours: number } & Out)
  | ({ kind: 'retry'; detail: string; error: string } & Out);

export type StepExecutor = (c: StepContext) => Promise<StepResult>;

/** Model calls each AI step may make (checked against the goal's daily allowance first). */
export const AI_CALLS: Partial<Record<TaskKind, number>> = { ideas: 1, decide: 2, content: 1 };

const tx = <T>(c: StepContext, fn: (t: Tx) => Promise<T>) => withTenant(c.deps.db, { tenantId: c.tenantId, actor: ACTOR_REF }, fn);
const daysLeft = (c: StepContext) => Math.max(1, Math.ceil((c.goal.targetDate.getTime() - c.now.getTime()) / DAY));
const fmtDate = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : 'never');
const money = (micros: number, currency: string) => `${(micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;

function dataHint(metricKey: string): string {
  if (metricKey === DOWNLOADS_SERIES_KEY) return 'Connect App Store Connect in Connections (daily sales reports become this series) or upload the daily values in Advanced › Analytics.';
  if (isFacebookInsightsKey(metricKey)) return 'This series comes from the daily Page insights sync of a Facebook Page in Connections. Meta returns values only when the Page token has the read_insights permission, and may withhold them for small Pages.';
  return 'Upload the daily values of this metric in Advanced › Analytics (metric series), or connect the source that produces it.';
}

/** Written into the Brain and Idea Lab prompts as goal context (fenced as untrusted text). */
export function goalConstraints(goal: GoalRow, now: Date): string {
  const kpi = goalKpi(goal);
  const days = Math.max(1, Math.ceil((goal.targetDate.getTime() - now.getTime()) / DAY));
  const target = kpi.target !== null ? `target ${kpi.target} ${kpi.unit}` : kpi.targetChangePct !== null ? `target ${kpi.targetChangePct > 0 ? '+' : ''}${kpi.targetChangePct}% versus the pre-goal baseline` : 'no numeric target';
  return [
    `Goal: ${goal.title}`,
    `Owner's words: ${goal.statement}`,
    `KPI: ${kpi.label} (${kpi.metricKey}), ${kpi.direction}, ${target}. ${days} days remain (target date ${fmtDate(goal.targetDate)}).`,
    `Authorized channels: ${goal.channels.join(', ')}.`,
    `Advertising budget for the whole goal: ${money(goal.adBudgetMicros, goal.currency)}${goal.adBudgetMicros === 0 ? ' (no paid spend of any kind)' : ''}.`,
    `Market: ${goal.market}.`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* observe: KPI data, connections, evidence, open actions (M08 M19 M01 M23) */
/* ------------------------------------------------------------------ */

/**
 * A Facebook KPI is refreshed from Meta when its newest value is more than two days old (Meta
 * closes a day hours after it ends). Runs as the Autopilot, so the new evidence does not nudge
 * the goal into another cycle. `points` counts the stored values of this KPI's own metric.
 */
async function refreshPageInsights(c: StepContext, metricKey: string): Promise<{ points: number; notes: string[] }> {
  const { conns, last } = await tx(c, async (t) => ({
    conns: await t
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.provider, 'meta'), inArray(connections.status, ['active', 'read_only']))),
    last:
      (
        await t
          .select({ last: max(metricPoints.ts) })
          .from(metricPoints)
          .innerJoin(metricSeries, eq(metricSeries.id, metricPoints.seriesId))
          .where(eq(metricSeries.key, metricKey))
      )[0]?.last ?? null,
  }));
  if (last && c.now.getTime() - new Date(last).getTime() < 2 * DAY) return { points: 0, notes: [] };
  if (!conns.length) return { points: 0, notes: ['No Facebook Page is connected, so the Page insights behind this KPI cannot be synced.'] };
  const metric = Object.entries(FACEBOOK_INSIGHT_SERIES).find(([, d]) => d.key === metricKey)?.[0];
  let points = 0;
  const notes: string[] = [];
  for (const conn of conns) {
    try {
      const r = await syncPageInsights(c.deps, c.tenantId, conn.id, { actor: AUTOPILOT });
      const synced = metric ? r.metrics[metric] : undefined;
      if (synced?.seriesId) points += synced.days;
      if (r.note) notes.push(r.note);
    } catch (err) {
      notes.push(`The Page insights sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { points, notes };
}

const observe: StepExecutor = async (c) => {
  const insights = isFacebookInsightsKey(goalKpi(c.goal).metricKey) ? await refreshPageInsights(c, goalKpi(c.goal).metricKey) : null;
  return tx(c, async (t) => {
    const kpi = goalKpi(c.goal);
    const bridged = kpi.metricKey === DOWNLOADS_SERIES_KEY ? await syncDownloadsSeries(t, c.tenantId) : null;
    const [series] = await t.select().from(metricSeries).where(eq(metricSeries.key, kpi.metricKey));
    const [stats] = series
      ? await t
          .select({ n: sql<number>`count(*)::int`, first: min(metricPoints.ts), last: max(metricPoints.ts) })
          .from(metricPoints)
          .where(eq(metricPoints.seriesId, series.id))
      : [];
    const conns = await t.select({ id: connections.id, provider: connections.provider, status: connections.status, displayName: connections.displayName }).from(connections);
    const [ev] = await t.select({ n: sql<number>`count(*)::int` }).from(evidenceRecords).where(eq(evidenceRecords.status, 'admitted'));
    const [cl] = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(claims)
      .where(and(eq(claims.status, 'approved'), or(isNull(claims.expiresAt), gte(claims.expiresAt, c.now))));
    const actions = await goalActions(t, c.goal.id);
    const open = actions.filter((a) => !SETTLED_ACTION_STATES.includes(a.status));
    const [ideas] = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(growthIdeas)
      .where(and(eq(growthIdeas.targetMetric, kpi.metricKey), inArray(growthIdeas.status, ['candidate', 'queued_for_test', 'testing', 'validated'])));
    const policy = await getTenantPolicy(t, c.tenantId);
    const markets = await approvedJurisdictions(t, policy);
    const reports = kpi.metricKey === DOWNLOADS_SERIES_KEY ? ((await t.select({ n: sql<number>`count(*)::int` }).from(appStoreReports))[0]?.n ?? 0) : null;
    const points = stats?.n ?? 0;
    const warnings: string[] = [...(insights?.notes ?? [])];
    if (!policy.configured) warnings.push('Your autonomy policy is not configured, so every action will wait for approval.');
    if (!markets.includes(c.goal.market)) warnings.push(`No legal-approved rules for market ${c.goal.market}: public or messaging actions also need legal approval.`);
    if (!c.deps.models) warnings.push('No approved AI model is available, so ideas and decisions cannot be generated.');
    const active = conns.filter((x) => x.status === 'active');
    const detail = [
      series ? `${kpi.label}: ${points} data point${points === 1 ? '' : 's'} (latest ${fmtDate(stats?.last)})${bridged ? `, ${bridged.points} from App Store reports` : ''}${insights?.points ? `, ${insights.points} daily values just synced from Facebook Page insights` : ''}.` : `No ${kpi.label} data yet.`,
      `${active.length} of ${conns.length} connection${conns.length === 1 ? '' : 's'} active${active.length ? ` (${[...new Set(active.map((x) => x.provider))].join(', ')})` : ''}.`,
      `${ev?.n ?? 0} admitted evidence records, ${cl?.n ?? 0} approved claims, ${ideas?.n ?? 0} open ideas for this KPI, ${open.length} open action${open.length === 1 ? '' : 's'}.`,
      ...warnings,
    ].join(' ');
    return {
      kind: 'completed',
      detail,
      output: {
        seriesId: series?.id ?? null,
        points,
        firstPointAt: stats?.first?.toISOString() ?? null,
        lastPointAt: stats?.last?.toISOString() ?? null,
        appStoreReports: reports,
        pageInsightsSynced: insights ? insights.points : null,
        connections: conns.map((x) => ({ provider: x.provider, status: x.status })),
        evidence: ev?.n ?? 0,
        approvedClaims: cl?.n ?? 0,
        openIdeas: ideas?.n ?? 0,
        openActions: open.map((a) => ({ id: a.id, status: a.status, actionType: a.actionType })),
        policyConfigured: policy.configured,
        marketApproved: markets.includes(c.goal.market),
        modelAvailable: Boolean(c.deps.models),
        warnings,
      },
    };
  });
};

/* ------------------------------------------------------------------ */
/* forecast: no-action baseline from M08                               */
/* ------------------------------------------------------------------ */

const forecast: StepExecutor = async (c) =>
  tx(c, async (t) => {
    const kpi = goalKpi(c.goal);
    const [series] = await t.select().from(metricSeries).where(eq(metricSeries.key, kpi.metricKey));
    if (!series) return { kind: 'blocked', needs: 'data', detail: `There is no ${kpi.label} series yet, so no forecast can be made. ${dataHint(kpi.metricKey)}` };
    const [{ n } = { n: 0 }] = await t.select({ n: sql<number>`count(*)::int` }).from(metricPoints).where(eq(metricPoints.seriesId, series.id));
    if (n < MIN_KPI_POINTS) return { kind: 'blocked', needs: 'data', detail: `${kpi.label} has ${n} of the ${MIN_KPI_POINTS} daily values a forecast needs. ${dataHint(kpi.metricKey)}`, output: { points: n } };
    const reqId = c.task.refs.analyticsRequestId;
    if (!reqId) {
      const [recent] = await t
        .select()
        .from(forecastRuns)
        .where(and(eq(forecastRuns.seriesId, series.id), sql`${forecastRuns.status} <> 'abstained'`, gte(forecastRuns.createdAt, new Date(c.now.getTime() - DAY))))
        .orderBy(desc(forecastRuns.createdAt))
        .limit(1);
      if (recent) return { kind: 'completed', detail: `Using today's forecast of ${kpi.label} (${recent.championModel}, ${recent.status.replaceAll('_', ' ')}).`, output: { forecastRunId: recent.id, seriesId: series.id, reused: true } };
      // The longest horizon the history supports, up to the goal's remaining days.
      const horizon = Math.min(90, Math.max(7, daysLeft(c)), n - FORECAST_OVERHEAD);
      const req = await requestAnalytics(t, c.tenantId, AUTOPILOT, 'forecast', { seriesId: series.id, horizon, seasonLength: 7 }, 50);
      return { kind: 'waiting', detail: `Asked the forecasting engine (M08) for a ${horizon}-day no-action forecast of ${kpi.label}; waiting for the analytics job.`, recheckAt: new Date(c.now.getTime() + 5 * 60_000), maxWaitHours: 3, refs: { analyticsRequestId: req.id } };
    }
    const [req] = await t.select().from(analyticsRequests).where(eq(analyticsRequests.id, reqId));
    if (req?.status === 'completed') {
      const [run] = await t.select().from(forecastRuns).where(eq(forecastRuns.requestId, reqId)).orderBy(desc(forecastRuns.createdAt)).limit(1);
      if (!run) return { kind: 'blocked', needs: 'data', detail: 'The analytics job finished without a forecast run.' };
      if (run.status === 'abstained') return { kind: 'blocked', needs: 'data', detail: `The forecasting engine abstained: ${run.selectionReason}`, output: { forecastRunId: run.id } };
      return { kind: 'completed', detail: `Forecast ready (${run.championModel}, ${run.status.replaceAll('_', ' ')}).`, output: { forecastRunId: run.id, seriesId: series.id } };
    }
    if (req?.status === 'failed' || !req) return { kind: 'blocked', needs: 'configuration', detail: `The forecast request failed: ${req?.error ?? 'request not found'}` };
    if (c.task.waitUntil && c.now > c.task.waitUntil) return { kind: 'blocked', needs: 'configuration', detail: 'The analytics job did not produce the forecast within 3 hours (it normally runs every 15 minutes). Check Operations; the next cycle will try again.' };
    return { kind: 'waiting', detail: `Waiting for the analytics job to finish the forecast (request ${req.status}).`, recheckAt: new Date(c.now.getTime() + 5 * 60_000), maxWaitHours: 3 };
  });

/* ------------------------------------------------------------------ */
/* research: market inputs (M04 M05 M18); read-only audits and trends   */
/* ------------------------------------------------------------------ */

const research: StepExecutor = async (c) =>
  tx(c, async (t) => {
    const since = new Date(c.now.getTime() - 30 * DAY);
    const [tr] = await t.select({ n: sql<number>`count(*)::int` }).from(trends).where(gte(trends.createdAt, since));
    const [ob] = await t.select({ n: sql<number>`count(*)::int` }).from(competitorObservations).where(gte(competitorObservations.createdAt, since));
    const keywords = (await keywordOpportunities(t, { limit: 20 })).rows;
    const notes: string[] = [];
    const refs: Record<string, string> = {};
    if (c.goal.channels.includes('seo') && c.goal.siteUrl) {
      const origin = new URL(c.goal.siteUrl).origin;
      const [recent] = await t
        .select({ id: seoAudits.id })
        .from(seoAudits)
        .where(and(eq(seoAudits.siteUrl, origin), gte(seoAudits.createdAt, new Date(c.now.getTime() - 7 * DAY))))
        .limit(1);
      if (!recent) {
        const a = await queueSeoAudit(t, c.deps, c.tenantId, AUTOPILOT, { siteUrl: origin, maxPages: 50 });
        refs.seoAuditId = a.id;
        notes.push(`queued a read-only site audit of ${origin} (robots.txt honoured)`);
      }
    }
    const kpi = goalKpi(c.goal);
    const seriesId = c.prior.observe?.output.seriesId as string | null | undefined;
    const points = Number(c.prior.observe?.output.points ?? 0);
    if (seriesId && points >= 28) {
      const [pending] = await t
        .select({ id: analyticsRequests.id })
        .from(analyticsRequests)
        .where(and(eq(analyticsRequests.kind, 'trend_detection'), gte(analyticsRequests.requestedAt, new Date(c.now.getTime() - 7 * DAY)), sql`${analyticsRequests.params}->'seriesIds' ? ${seriesId}`))
        .limit(1);
      if (!pending) {
        const r = await requestAnalytics(t, c.tenantId, AUTOPILOT, 'trend_detection', { seriesIds: [seriesId] }, 80);
        refs.trendRequestId = r.id;
        notes.push(`asked M04 to test ${kpi.label} for a trend`);
      }
    }
    const detail = `Market inputs from the last 30 days: ${tr?.n ?? 0} trends, ${ob?.n ?? 0} competitor observations, ${keywords.length} keyword opportunities.${notes.length ? ` Also ${notes.join('; ')}.` : ''}`;
    return { kind: 'completed', detail, refs, output: { trends: tr?.n ?? 0, competitorObservations: ob?.n ?? 0, keywordOpportunities: keywords.length } };
  });

/* ------------------------------------------------------------------ */
/* ideas: M06 Idea Lab, focused on the goal                            */
/* ------------------------------------------------------------------ */

async function openIdeas(c: StepContext) {
  const kpi = goalKpi(c.goal);
  const tried = new Set(Object.keys(((c.goal.memory as { triedIdeas?: Record<string, unknown> }).triedIdeas ?? {}) as Record<string, unknown>));
  return tx(c, async (t) => {
    const recent = await t
      .select({ ideaId: growthDecisions.ideaId })
      .from(growthDecisions)
      .where(gte(growthDecisions.createdAt, new Date(c.now.getTime() - 7 * DAY)));
    const decided = new Set(recent.map((r) => r.ideaId));
    return (await rankedIdeas(t, 200)).filter((i) => i.targetMetric === kpi.metricKey && !tried.has(i.id) && !decided.has(i.id));
  });
}

const ideas: StepExecutor = async (c) => {
  const kpi = goalKpi(c.goal);
  const open = await openIdeas(c);
  if (open.length >= 2) return { kind: 'skipped', detail: `${open.length} untried ideas for ${kpi.label} are already waiting; no new ones needed.`, output: { open: open.length } };
  if (Number(c.prior.observe?.output.evidence ?? 0) === 0) return { kind: 'blocked', needs: 'evidence', detail: 'Ideas must cite evidence, and there is none yet. Add facts about your product, customers or market in Business setup (Advanced › Evidence).' };
  const r = await generateIdeas(c.deps, c.tenantId, AUTOPILOT, { maxIdeas: 3, focus: { objective: c.goal.title, targetMetric: kpi.metricKey, channels: c.goal.channels, constraints: goalConstraints(c.goal, c.now) } });
  if (r.status === 'abstained') return { kind: 'blocked', needs: r.reason === 'MODEL_UNAVAILABLE' ? 'model' : 'evidence', detail: `The Idea Lab abstained (${r.reason}).`, aiCalls: 1, refs: { agentRunId: r.runId } };
  if (r.status === 'failed') return { kind: 'retry', detail: 'The Idea Lab failed; will retry.', error: r.error, aiCalls: 1 };
  const created = (r.result as { created: string[]; abstained?: string; rejected?: { title: string; reason: string }[] }).created ?? [];
  const why = (r.result as { abstained?: string }).abstained;
  if (!created.length) return { kind: 'blocked', needs: 'evidence', detail: `No usable idea came out of the evidence${why ? `: ${why}` : ''}.`, aiCalls: 1, refs: { agentRunId: r.runId } };
  return { kind: 'completed', detail: `The Idea Lab (M06) proposed ${created.length} evidence-backed idea${created.length === 1 ? '' : 's'} for ${kpi.label}.`, aiCalls: 1, refs: { agentRunId: r.runId }, output: { created } };
};

/* ------------------------------------------------------------------ */
/* decide: M07 Growth Brain for the best untried idea                  */
/* ------------------------------------------------------------------ */

const decide: StepExecutor = async (c) => {
  const kpi = goalKpi(c.goal);
  const limits = c.goal.limits as { maxOpenActions?: number };
  const openActions = (c.prior.observe?.output.openActions as unknown[] | undefined)?.length ?? 0;
  if (openActions >= (limits.maxOpenActions ?? 3)) return { kind: 'skipped', detail: `${openActions} of this goal's actions are still open (awaiting approval or execution); not proposing more until they settle.` };
  const forecastRunId = c.prior.forecast?.output.forecastRunId as string | undefined;
  if (!forecastRunId) return { kind: 'skipped', detail: `The Growth Brain needs a forecast of ${kpi.label} first (see the forecast step).` };
  const existing = c.task.refs.decisionId;
  if (existing) return { kind: 'completed', detail: 'Decision already made in this cycle.', output: c.task.output };
  const [idea] = await openIdeas(c);
  if (!idea) return { kind: 'skipped', detail: `No untried idea for ${kpi.label} is available.` };
  const seriesId = c.prior.observe?.output.seriesId as string | undefined;
  const r = await proposeDecision(c.deps, c.tenantId, AUTOPILOT, {
    ideaId: idea.id,
    objective: c.goal.title,
    market: c.goal.market,
    horizon: { value: Math.min(52, daysLeft(c)), unit: 'day' },
    ...(seriesId ? { seriesId } : {}),
    goal: { id: c.goal.id, constraints: goalConstraints(c.goal, c.now), allowedCategories: goalCategories(c.goal.channels, c.goal.adBudgetMicros) },
  });
  if (r.status === 'abstained')
    return { kind: 'blocked', needs: r.reason === 'MODEL_UNAVAILABLE' ? 'model' : 'evidence', detail: `The Growth Brain abstained on "${idea.title}" (${r.reason}); the next cycle tries another idea.`, aiCalls: 2, refs: { agentRunId: r.runId }, output: { ideaId: idea.id, abstained: r.reason } };
  if (r.status === 'failed') return { kind: 'retry', detail: 'The Growth Brain failed; will retry.', error: r.error, aiCalls: 2 };
  const d = r.result.decision;
  const action = d.proposedAction?.actionType ?? null;
  const detail = action
    ? `The Growth Brain (M07) proposes ${action} for "${idea.title}" (policy dry-run: ${d.policyResult.outcome.replaceAll('_', ' ').toLowerCase()}${d.approvalRequirement.required ? ', needs approval' : ''}).`
    : `The Growth Brain (M07) recommends no action yet for "${idea.title}": ${d.assumptions.find((a) => a.startsWith('[validation]')) ?? 'evidence does not justify one'}.`;
  return {
    kind: 'completed',
    detail,
    aiCalls: 2,
    refs: { decisionId: r.result.decisionId, ideaId: idea.id, agentRunId: r.runId },
    output: { decisionId: r.result.decisionId, ideaId: idea.id, ideaTitle: idea.title, actionType: action, policy: d.policyResult.outcome, approvalRequired: d.approvalRequirement.required, utility: d.utility.status },
  };
};

/* ------------------------------------------------------------------ */
/* content: M13 creative brief draft for the chosen idea               */
/* ------------------------------------------------------------------ */

const content: StepExecutor = async (c) => {
  const ideaId = (c.prior.decide?.output.ideaId as string | undefined) ?? (await openIdeas(c))[0]?.id;
  if (!ideaId) return { kind: 'skipped', detail: 'No idea to write content for in this cycle.' };
  if (Number(c.prior.observe?.output.approvedClaims ?? 0) === 0) return { kind: 'blocked', needs: 'claims', detail: 'Content may only state approved claims, and none exist yet. Approve claims about your product in Business setup (Advanced › Knowledge).' };
  const [brief] = await tx(c, (t) => t.select({ id: creativeBriefs.id }).from(creativeBriefs).where(eq(creativeBriefs.ideaId, ideaId)).limit(1));
  if (brief) return { kind: 'skipped', detail: 'A creative brief for this idea already exists.', refs: { briefId: brief.id } };
  const conns = (c.prior.observe?.output.connections as { provider: string; status: string }[] | undefined) ?? [];
  const channel = c.goal.channels.includes('organic_social') ? (conns.some((x) => x.provider === 'tiktok' && x.status === 'active') && !conns.some((x) => x.provider === 'meta' && x.status === 'active') ? 'tiktok' : 'facebook') : 'email';
  const [idea] = await tx(c, (t) => t.select().from(growthIdeas).where(eq(growthIdeas.id, ideaId)));
  if (!idea) return { kind: 'skipped', detail: 'The idea no longer exists.' };
  const r = await generateBrief(c.deps, c.tenantId, AUTOPILOT, { objective: c.goal.title, channel, audience: idea.audience, ideaId });
  if (r.status === 'abstained') return { kind: 'blocked', needs: r.reason === 'MODEL_UNAVAILABLE' ? 'model' : 'claims', detail: `The creative strategist abstained (${r.reason}).`, aiCalls: 1 };
  if (r.status === 'failed') return { kind: 'retry', detail: 'Brief generation failed; will retry.', error: r.error, aiCalls: 1 };
  const out = r.result as { briefId: string | null; abstained?: string };
  if (!out.briefId) return { kind: 'blocked', needs: 'claims', detail: `No brief: ${out.abstained ?? 'the approved claims do not support this idea'}.`, aiCalls: 1 };
  return { kind: 'completed', detail: `Drafted a ${channel} creative brief (M13) for "${idea.title}". It is a draft for your review, not a publication.`, aiCalls: 1, refs: { briefId: out.briefId, agentRunId: r.runId }, output: { briefId: out.briefId, channel } };
};

/* ------------------------------------------------------------------ */
/* submit: hand the decision to M23 (D-033)                            */
/* ------------------------------------------------------------------ */

function needsFromReasons(codes: string[]): BlockNeed {
  if (codes.some((x) => x.startsWith('EVIDENCE') || x === 'NO_EVIDENCE')) return 'evidence';
  if (codes.some((x) => x.startsWith('CONNECTION') || x === 'NO_CONNECTION' || x === 'MISSING_SCOPES')) return 'connection';
  if (codes.some((x) => x.startsWith('CLAIM'))) return 'claims';
  return 'configuration';
}

const submit: StepExecutor = async (c) => {
  const decisionId = c.prior.decide?.output.decisionId as string | undefined;
  if (!decisionId) return { kind: 'skipped', detail: 'No decision was made in this cycle.' };
  const [d] = await tx(c, (t) => t.select().from(growthDecisions).where(eq(growthDecisions.id, decisionId)));
  if (!d) return { kind: 'skipped', detail: 'The decision no longer exists.' };
  if (d.actionId) return { kind: 'completed', detail: 'Already handed to the execution gateway.', refs: { actionId: d.actionId } };
  const pa = d.proposedAction as { actionType: string; connectionId: string | null; params: Record<string, unknown> } | null;
  if (!pa) return { kind: 'skipped', detail: 'The Growth Brain recommended no action, so nothing was submitted.' };
  if (d.status !== 'PROPOSED') return { kind: 'skipped', detail: `The decision is ${d.status.toLowerCase()}.` };
  const def = getActionType(pa.actionType);
  if (!def || !goalCategories(c.goal.channels, c.goal.adBudgetMicros).includes(def.category)) return { kind: 'blocked', needs: 'configuration', detail: `${pa.actionType} is outside the channels this goal authorizes (${c.goal.channels.join(', ')}); the decision waits for you in Pending approvals.` };
  if (def.affectsSpend) {
    const risk = riskFromParams(pa.actionType, pa.params, d.market);
    const committed = await tx(c, async (t) => (await goalActions(t, c.goal.id)).filter((a) => !['FAILED', 'DENIED', 'REJECTED', 'CANCELLED', 'ROLLED_BACK'].includes(a.status)).reduce((s, a) => s + Math.max(0, Number((a.risk as { spendDeltaMicros?: number }).spendDeltaMicros ?? 0)), 0));
    if (risk.spendDeltaMicros > 0 && committed + risk.spendDeltaMicros > c.goal.adBudgetMicros) {
      return { kind: 'blocked', needs: 'budget', detail: `This would add ${money(risk.spendDeltaMicros, risk.currency ?? c.goal.currency)} of spend, beyond the goal's advertising budget of ${money(c.goal.adBudgetMicros, c.goal.currency)}. Nothing was submitted.` };
    }
  }
  if (!c.goal.autoSubmit) return { kind: 'blocked', needs: 'approval', detail: 'This goal is set to suggest only: review the decision in Pending approvals to go ahead.', refs: { decisionId } };
  try {
    const view = await autoAcceptDecision(c.deps, c.tenantId, decisionId, {
      goalId: c.goal.id,
      prepare: async (proposed) => ({ ...proposed, params: await tx(c, (t) => postForPublishAction(t, c.deps, c.tenantId, { actionType: proposed.actionType, connectionId: proposed.connectionId, params: proposed.params })) }),
    });
    const refs = { actionId: view.id, decisionId };
    if (view.status === 'DENIED') {
      const codes = (view.policyDecision?.reasons ?? []).filter((r) => r.effect === 'DENY').map((r) => r.code);
      return { kind: 'blocked', needs: needsFromReasons(codes), detail: `The execution gateway (M23) denied ${pa.actionType}: ${view.statusReason ?? codes.join(', ')}`, refs, output: { actionId: view.id, status: view.status } };
    }
    const detail = view.status === 'APPROVAL_REQUIRED' ? `Submitted ${pa.actionType} to the execution gateway (M23); your policy requires approval: ${view.statusReason ?? ''}`.trim() : `Submitted ${pa.actionType}; your policy pre-authorizes it, so the worker executes it and verifies the result independently.`;
    return { kind: 'completed', detail, refs, output: { actionId: view.id, status: view.status, actionType: pa.actionType } };
  } catch (err) {
    return { kind: 'blocked', needs: 'configuration', detail: `Could not submit ${pa.actionType}: ${err instanceof Error ? err.message : String(err)}. The decision is back in Pending approvals.`, refs: { decisionId } };
  }
};

/* ------------------------------------------------------------------ */
/* track: follow the action through approval, execution, verification   */
/* ------------------------------------------------------------------ */

const track: StepExecutor = async (c) => {
  const actionId = (c.prior.submit?.output.actionId as string | undefined) ?? c.task.refs.actionId;
  if (!actionId) return { kind: 'skipped', detail: 'Nothing was submitted in this cycle.' };
  const [a] = await tx(c, async (t) => (await goalActions(t, c.goal.id)).filter((x) => x.id === actionId));
  if (!a) return { kind: 'skipped', detail: 'The action is no longer visible.' };
  const refs = { actionId };
  if (a.status === 'VERIFIED') return { kind: 'completed', detail: `${a.actionType} was executed and independently verified.`, refs, output: { actionId, status: a.status } };
  if (SETTLED_ACTION_STATES.includes(a.status)) return { kind: 'completed', detail: `${a.actionType} ended as ${a.status.toLowerCase().replaceAll('_', ' ')}: ${a.statusReason ?? ''}`.trim(), refs, output: { actionId, status: a.status } };
  if (c.task.waitUntil && c.now > c.task.waitUntil) return { kind: 'completed', detail: `${a.actionType} is still ${a.status.toLowerCase().replaceAll('_', ' ')}; it stays in Pending approvals and the next cycle checks it again.`, refs, output: { actionId, status: a.status, carriedOver: true } };
  const hours = Math.min(24, Number((c.goal.limits as { cadenceHours?: number }).cadenceHours ?? 24));
  const what = a.status === 'APPROVAL_REQUIRED' ? 'waiting for your approval' : a.status === 'EXECUTED_UNVERIFIED' ? 'executed; waiting for independent verification' : `in progress (${a.status.toLowerCase().replaceAll('_', ' ')})`;
  return { kind: 'waiting', detail: `${a.actionType} is ${what}.`, recheckAt: new Date(c.now.getTime() + 5 * 60_000), maxWaitHours: hours, refs, output: { actionId, status: a.status } };
};

/* ------------------------------------------------------------------ */
/* measure: KPI since the goal started vs baseline and forecast (M08)  */
/* ------------------------------------------------------------------ */

export interface Measurement {
  status: 'measured' | 'insufficient_data';
  metricKey: string;
  label: string;
  unit: string;
  measuredAt: string;
  daysObserved: number;
  actual: number | null;
  baselinePerDay: number | null;
  baselineForSamePeriod: number | null;
  changeVsBaselinePct: number | null;
  target: number | null;
  progressPct: number | null;
  forecast: { runId: string; expected: number; low: number; high: number; position: 'above' | 'within' | 'below'; days: number } | null;
  note: string;
}

export async function measureGoal(t: Tx, goal: GoalRow, now: Date): Promise<Measurement> {
  const kpi = goalKpi(goal);
  const base: Measurement = { status: 'insufficient_data', metricKey: kpi.metricKey, label: kpi.label, unit: kpi.unit, measuredAt: now.toISOString(), daysObserved: 0, actual: null, baselinePerDay: null, baselineForSamePeriod: null, changeVsBaselinePct: null, target: null, progressPct: null, forecast: null, note: '' };
  const [series] = await t.select().from(metricSeries).where(eq(metricSeries.key, kpi.metricKey));
  if (!series) return { ...base, note: `No ${kpi.label} series exists.` };
  const start = goal.startsAt;
  const end = now < goal.targetDate ? now : goal.targetDate;
  const days = Math.max(0, Math.floor((end.getTime() - start.getTime()) / DAY));
  const during = await t
    .select({ ts: metricPoints.ts, value: metricPoints.value })
    .from(metricPoints)
    .where(and(eq(metricPoints.seriesId, series.id), gte(metricPoints.ts, start), lt(metricPoints.ts, end)));
  const windowDays = Math.max(7, Math.min(90, Math.ceil((goal.targetDate.getTime() - start.getTime()) / DAY)));
  const before = await t
    .select({ value: metricPoints.value })
    .from(metricPoints)
    .where(and(eq(metricPoints.seriesId, series.id), gte(metricPoints.ts, new Date(start.getTime() - windowDays * DAY)), lt(metricPoints.ts, start)));
  const baselinePerDay = before.length ? before.reduce((s, p) => s + p.value, 0) / before.length : null;
  const goalDays = Math.max(1, Math.round((goal.targetDate.getTime() - start.getTime()) / DAY));
  const target = kpi.target ?? (kpi.targetChangePct !== null && baselinePerDay !== null ? baselinePerDay * goalDays * (1 + kpi.targetChangePct / 100) : null);
  if (!during.length) return { ...base, daysObserved: days, baselinePerDay, target, note: `No ${kpi.label} values have been recorded since the goal started on ${fmtDate(start)}.` };
  const actual = during.reduce((s, p) => s + p.value, 0);
  const baselineForSamePeriod = baselinePerDay === null ? null : baselinePerDay * during.length;
  const changeVsBaselinePct = baselineForSamePeriod ? ((actual - baselineForSamePeriod) / baselineForSamePeriod) * 100 : null;

  // Compare with the latest forecast that covers recorded days (a no-action baseline, not a causal estimate).
  const [run] = await t
    .select()
    .from(forecastRuns)
    .where(and(eq(forecastRuns.seriesId, series.id), sql`${forecastRuns.status} <> 'abstained'`, lt(forecastRuns.createdAt, end)))
    .orderBy(desc(forecastRuns.createdAt))
    .limit(1);
  let fc: Measurement['forecast'] = null;
  if (run) {
    const pts = await t.execute<{ ts: Date; mean: number; q10: number; q90: number }>(sql`select ts, mean, q10, q90 from forecast_points where run_id = ${run.id} and ts < ${end}`);
    const byDay = new Map(pts.rows.map((p) => [new Date(p.ts).toISOString().slice(0, 10), p]));
    let expected = 0;
    let low = 0;
    let high = 0;
    let obs = 0;
    let matched = 0;
    for (const p of during) {
      const f = byDay.get(p.ts.toISOString().slice(0, 10));
      if (!f) continue;
      matched++;
      expected += f.mean;
      low += f.q10;
      high += f.q90;
      obs += p.value;
    }
    if (matched > 0) fc = { runId: run.id, expected, low, high, position: obs > high ? 'above' : obs < low ? 'below' : 'within', days: matched };
  }
  const progressPct = target ? (actual / target) * 100 : null;
  return {
    status: 'measured',
    metricKey: kpi.metricKey,
    label: kpi.label,
    unit: kpi.unit,
    measuredAt: now.toISOString(),
    daysObserved: during.length,
    actual,
    baselinePerDay,
    baselineForSamePeriod,
    changeVsBaselinePct,
    target,
    progressPct,
    forecast: fc,
    note: 'Observed values compared with the pre-goal baseline and a no-action forecast. This is not a causal estimate; experiments measure incrementality.',
  };
}

const measure: StepExecutor = async (c) => {
  const m = await tx(c, (t) => measureGoal(t, c.goal, c.now));
  if (m.status !== 'measured') return { kind: 'completed', detail: `Nothing to measure yet: ${m.note}`, output: m as unknown as Record<string, unknown> };
  const parts = [`${m.label} since the goal started: ${Math.round(m.actual!).toLocaleString('en-US')} over ${m.daysObserved} day${m.daysObserved === 1 ? '' : 's'}`];
  if (m.changeVsBaselinePct !== null) parts.push(`${m.changeVsBaselinePct >= 0 ? '+' : ''}${m.changeVsBaselinePct.toFixed(1)}% versus the pre-goal daily average`);
  if (m.forecast) parts.push(`${m.forecast.position} the no-action forecast range (${Math.round(m.forecast.low)}–${Math.round(m.forecast.high)})`);
  if (m.progressPct !== null) parts.push(`${m.progressPct.toFixed(0)}% of the target`);
  return { kind: 'completed', detail: `${parts.join('; ')}.`, output: m as unknown as Record<string, unknown> };
};

/* ------------------------------------------------------------------ */
/* learn: record outcomes, request experiment analysis, set the replan  */
/* ------------------------------------------------------------------ */

const learn: StepExecutor = async (c) => {
  const decide = c.prior.decide;
  const ideaId = decide?.output.ideaId as string | undefined;
  const actionStatus = (c.prior.track?.output.status ?? c.prior.submit?.output.status) as string | undefined;
  const m = c.prior.measure?.output as unknown as Measurement | undefined;
  const lessons: string[] = [];
  let replanHours: number | null = null;
  let replanReason: string | null = null;
  const cadence = Number((c.goal.limits as { cadenceHours?: number }).cadenceHours ?? 24);
  const sooner = Math.max(2, Math.round(cadence / 2));
  if (ideaId) {
    const outcome = decide?.output.abstained ? `abstained (${decide.output.abstained})` : actionStatus ? actionStatus.toLowerCase() : decide?.output.actionType ? 'proposed' : 'no action recommended';
    lessons.push(`Idea "${String(decide?.output.ideaTitle ?? ideaId)}": ${outcome}.`);
  }
  if (actionStatus && ['FAILED', 'DENIED', 'REJECTED', 'CANCELLED', 'ROLLED_BACK', 'ESCALATED'].includes(actionStatus)) {
    replanHours = sooner;
    replanReason = `the last action ended as ${actionStatus.toLowerCase()}`;
  } else if (m?.forecast?.position === 'below') {
    replanHours = sooner;
    replanReason = `${m.label} is below the no-action forecast range`;
  } else if (decide?.status === 'blocked' && decide.output.abstained) {
    replanHours = sooner;
    replanReason = 'the Growth Brain abstained on the last idea';
  }
  if (m?.forecast) lessons.push(`${m.label} was ${m.forecast.position} the no-action forecast range over ${m.forecast.days} day${m.forecast.days === 1 ? '' : 's'} (observational, not causal).`);

  // Experiments behind this goal's ideas get a fresh analysis at most once a day (M10).
  const analyses = await tx(c, async (t) => {
    const ids = (await t.select({ ideaId: growthDecisions.ideaId }).from(growthDecisions).where(eq(growthDecisions.goalId, c.goal.id))).map((r) => r.ideaId).filter((x): x is string => Boolean(x));
    if (!ids.length) return [] as string[];
    const running = await t
      .select()
      .from(experiments)
      .where(and(inArray(experiments.ideaId, ids), eq(experiments.status, 'running')));
    const out: string[] = [];
    for (const e of running) {
      const [recent] = await t
        .select({ id: experimentResults.id })
        .from(experimentResults)
        .where(and(eq(experimentResults.experimentId, e.id), gte(experimentResults.computedAt, new Date(c.now.getTime() - DAY))))
        .limit(1);
      const [queued] = await t
        .select({ id: analyticsRequests.id })
        .from(analyticsRequests)
        .where(and(eq(analyticsRequests.kind, 'experiment_analysis'), gte(analyticsRequests.requestedAt, new Date(c.now.getTime() - DAY)), sql`${analyticsRequests.params}->>'experimentId' = ${e.id}`))
        .limit(1);
      if (recent || queued) continue;
      await requestAnalysis(t, c.tenantId, AUTOPILOT, e.id);
      out.push(e.name);
    }
    return out;
  });
  if (analyses.length) lessons.push(`Requested a fresh analysis of experiment${analyses.length === 1 ? '' : 's'} ${analyses.join(', ')} (M10).`);
  const detail = [...lessons, replanReason ? `Next cycle brought forward to ${sooner} h because ${replanReason}.` : `Next cycle in ${cadence} h.`].join(' ');
  return { kind: 'completed', detail, output: { lessons, replanHours, replanReason, ideaId: ideaId ?? null, actionStatus: actionStatus ?? null, experimentAnalyses: analyses } };
};

export const EXECUTORS: Record<TaskKind, StepExecutor> = { observe, forecast, research, ideas, decide, content, submit, track, measure, learn };
