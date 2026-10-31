import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type ModelProvider, PROMPTS, type ProviderOutcome, type StructuredRequest } from '@futuregrow/agent-kernel';
import { analytics, autopilot, brain, clearModelCache, connectionsModule, createModelGateway, evidence, execution, experimentsModule, governance, ideas, record, systemActor } from '@futuregrow/core';
import { actionRequests, analyticsRequests, appStoreReports, forecastPoints, forecastRuns, goalCycles, goalTasks, growthDecisions, growthGoals, killSwitches, organization, outboxEvents, socialPosts, withSystem, withTenant } from '@futuregrow/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { JobHelpers, Task } from 'graphile-worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import '../src/register-modules.js';
import { buildTaskList } from '../src/tasks.js';

/*
 * Autonomy tests: one business goal is pursued by the real worker task list (minute tick,
 * advance jobs, outbox dispatch, execute/verify jobs) with no browser and no API calls. Models
 * are scripted; Meta is a local fixture server; forecasts come from the real Python analytics
 * job when its venv exists (CI), otherwise from an equivalent recorded run.
 */

const root = path.resolve(__dirname, '../../..');
const py = [path.join(root, 'jobs/analytics/.venv/Scripts/python.exe'), path.join(root, 'jobs/analytics/.venv/bin/python')].find((p) => fs.existsSync(p));
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DAY = 86_400_000;

type Responder = (content: string) => unknown;
class ScriptedProvider implements ModelProvider {
  readonly name = 'anthropic';
  responders = new Map<string, Responder>();
  calls: { prompt: string; content: string }[] = [];
  async generateStructured<T>(req: StructuredRequest<T>): Promise<ProviderOutcome<T>> {
    const name = Object.entries(PROMPTS).find(([, p]) => p.system === req.system)?.[0] ?? 'unknown';
    const content = req.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    this.calls.push({ prompt: name, content });
    const fn = this.responders.get(name);
    if (!fn) throw new Error(`no scripted response for ${name}`);
    return { kind: 'ok', output: fn(content) as T, servedBy: 'claude-opus-5-5', usage: { inputTokens: 400, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', requestId: 'req_t' };
  }
}

const server = new FixtureServer();
let h: CoreHarness;
let provider: ScriptedProvider;
let tasks: Record<string, Task>;
let metaConnId: string;
const evidenceIds: string[] = [];
const queued: { task: string; payload: Record<string, unknown>; runAt: Date | null; key: string | null }[] = [];
const helpers = {
  addJob: async (task: string, payload: Record<string, unknown>, spec?: { runAt?: Date; jobKey?: string }) => {
    queued.push({ task, payload, runAt: spec?.runAt ?? null, key: spec?.jobKey ?? null });
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as JobHelpers;

const tx = <T>(fn: Parameters<typeof withTenant<T>>[2], tenantId = h.tenantId) => withTenant(h.t.handle.db, { tenantId, actor: 'user:test' }, fn);

/** Outbox → handlers, exactly as the worker's dispatch_event task does. */
async function dispatchOutbox() {
  for (let i = 0; i < 10; i++) {
    const rows = await withSystem(h.t.handle.db, 'test', (t) => t.select({ id: outboxEvents.id }).from(outboxEvents).where(isNull(outboxEvents.dispatchedAt)).orderBy(asc(outboxEvents.occurredAt)));
    if (!rows.length) return;
    for (const r of rows) await tasks.dispatch_event!({ eventId: r.id }, helpers);
  }
}

/** Run every due job (and the jobs they queue) like a worker process would, with job-key dedup. */
async function drain(rounds = 60) {
  for (let i = 0; i < rounds; i++) {
    await dispatchOutbox();
    for (const j of h.jobs.jobs.splice(0)) queued.push({ task: j.task, payload: j.payload, runAt: j.opts?.runAt ?? null, key: j.opts?.jobKey ?? null });
    const now = h.clock.now();
    const byKey = new Map<string, (typeof queued)[number]>();
    const later: typeof queued = [];
    for (const j of queued.splice(0)) {
      if (j.runAt && j.runAt > now) later.push(j);
      else byKey.set(j.key ?? randomUUID(), j);
    }
    queued.push(...later);
    if (!byKey.size) return;
    for (const j of byKey.values()) if (tasks[j.task]) await tasks[j.task]!(j.payload, helpers);
  }
}

/** Minute tick + drain, n times, advancing the clock between ticks. */
async function runWorker(minutes = 1, stepMs = 60_000) {
  for (let i = 0; i < minutes; i++) {
    await tasks.autopilot_tick!({}, helpers);
    await drain();
    h.clock.advance(stepMs);
  }
}

function runPythonAnalytics() {
  const r = spawnSync(py!, ['-m', 'futuregrow_analytics.runner'], {
    cwd: path.join(root, 'jobs/analytics'),
    env: { ...process.env, DATABASE_URL: h.t.url, ANALYTICS_MAX_SECONDS: '240', PYTHONPATH: path.join(root, 'jobs/analytics') },
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (r.status !== 0) throw new Error(`analytics job failed: ${r.stderr}`);
}

/** Equivalent of the analytics job for one forecast request (used where the job is not the subject). */
async function recordForecast(requestId: string) {
  await tx(async (t) => {
    const [req] = await t.select().from(analyticsRequests).where(eq(analyticsRequests.id, requestId));
    const seriesId = (req!.params as { seriesId: string }).seriesId;
    const horizon = Number((req!.params as { horizon: number }).horizon);
    const [run] = await t
      .insert(forecastRuns)
      .values({
        tenantId: h.tenantId,
        requestId,
        seriesId,
        horizon,
        status: 'champion_selected',
        championModel: 'holt_winters_damped',
        baselineModel: 'seasonal_naive',
        candidates: [],
        gate: { configured: true },
        selectionReason: 'test',
        calibration: { coverage80: 0.8, folds: 20 },
        drift: {},
        datasetSha256: 'a'.repeat(64),
        config: {},
        seed: 1,
        codeVersion: '0.1.0',
        createdAt: h.clock.now(),
      })
      .returning();
    const first = Math.floor(h.clock.now().getTime() / DAY) * DAY;
    for (let i = 0; i < horizon; i++) await t.insert(forecastPoints).values({ tenantId: h.tenantId, runId: run!.id, ts: new Date(first + i * DAY), mean: 100, q025: 80, q10: 90, q50: 100, q90: 110, q975: 120 });
    await t.update(analyticsRequests).set({ status: 'completed', resultRef: run!.id, finishedAt: h.clock.now(), resultSummary: {} }).where(eq(analyticsRequests.id, requestId));
    await record(t, h.tenantId, systemActor('analytics-job'), 'analytics.request.completed', { type: 'analytics_request', id: requestId }, { kind: 'forecast', resultRef: run!.id });
  });
}

async function recordQueuedForecasts() {
  const reqs = await tx((t) =>
    t
      .select({ id: analyticsRequests.id })
      .from(analyticsRequests)
      .where(and(eq(analyticsRequests.kind, 'forecast'), eq(analyticsRequests.status, 'queued'))),
  );
  for (const r of reqs) await recordForecast(r.id);
}

async function admit(summary: string, over: Record<string, unknown> = {}) {
  const e = await tx((t) =>
    evidence.admitEvidence(
      t,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'primary',
        sourceOwner: 'acme',
        sourceUriOrObjectId: `crm://${randomUUID()}`,
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'first-party',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: 0.95,
        freshnessSlaHours: 24 * 90,
        permittedUses: ['analytics', 'autonomous_execution', 'publishing'],
        kind: 'observation',
        summary,
        content: { n: randomUUID() },
        ...over,
      } as never,
      { now: h.clock.now() },
    ),
  );
  return e.evidenceId;
}

/** A daily KPI series with `days` values ending yesterday. */
async function series(key: string, days = 40, base = 100) {
  const ev = await admit(`daily ${key}`, { kind: 'metric' });
  const s = await tx((t) => analytics.upsertSeries(t, h.tenantId, h.users.owner, { key, name: key, unit: 'count', granularity: 'day', kind: 'kpi', sourceEvidenceId: ev }));
  const today = Math.floor(h.clock.now().getTime() / DAY) * DAY;
  await tx((t) =>
    analytics.appendPoints(
      t,
      h.tenantId,
      s.id,
      Array.from({ length: days }, (_, i) => ({ ts: new Date(today - (days - i) * DAY).toISOString(), value: base + 10 * Math.sin((2 * Math.PI * i) / 7) + (i % 3) })),
    ),
  );
  return s.id;
}

/** A strong, human-entered idea for the KPI (ranks first: three trusted evidence records). */
async function idea(metric: string, title: string) {
  return tx((t) =>
    ideas.createIdea(
      t,
      h.deps,
      h.tenantId,
      h.users.operator,
      { title, hypothesis: `${title} increases ${metric} among new visitors (${randomUUID().slice(0, 8)})`, mechanism: 'Clearer value proposition at the decision point', audience: 'new visitors in the US', targetMetric: metric, evidenceIds: evidenceIds.slice(0, 3), killCriteria: ['no lift after two weeks'] },
      'human',
    ),
  );
}

async function goal(over: Record<string, unknown> = {}) {
  return tx((t) =>
    autopilot.createGoal(t, h.deps, h.tenantId, h.users.owner, {
      title: 'Grow organic downloads',
      statement: "Grow my app's organic downloads over the next 30 days with a $0 advertising budget.",
      kpi: { metricKey: 'app.downloads.first_time', label: 'First-time downloads', unit: 'downloads' },
      market: 'US',
      targetDate: new Date(h.clock.now().getTime() + 30 * DAY).toISOString(),
      channels: ['app_store', 'organic_social', 'experiments'],
      ...over,
    }),
  );
}

const goalRow = async (id: string, tenantId = h.tenantId) => (await tx((t) => t.select().from(growthGoals).where(eq(growthGoals.id, id)), tenantId))[0]!;
const tasksOf = async (goalId: string) => tx((t) => t.select().from(goalTasks).where(eq(goalTasks.goalId, goalId)).orderBy(asc(goalTasks.createdAt), asc(goalTasks.seq)));
const byKind = async (goalId: string) => Object.fromEntries((await tasksOf(goalId)).map((x) => [x.kind, x]));
const strategistReturns = (fn: (content: string) => { actionType: string; connectionId?: string; params?: unknown }) =>
  provider.responders.set('brainStrategist', (c) => {
    const p = fn(c);
    return {
      abstain: false,
      abstainReason: '',
      objective: 'grow',
      actionType: p.actionType,
      connectionId: p.connectionId ?? '',
      paramsJson: JSON.stringify(p.params ?? {}),
      rationale: 'Evidence suggests this is the cheapest next step',
      assumptions: ['the evidence still holds'],
      counterfactual: 'KPI follows the forecast',
      downside: 'no measurable effect',
    };
  });

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
  h.clock.current = new Date();
  await governance.seedModelRegistry(h.t.handle.db);
  await governance.approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'anthropic', modelId: 'claude-opus-5-5', trainingOnCustomerData: 'no', dataRetentionTerms: 'reviewed', inputUsdPerMtok: 4, outputUsdPerMtok: 20 });
  clearModelCache();
  provider = new ScriptedProvider();
  h.deps.models = createModelGateway(h.deps, { anthropic: provider });
  process.env.DATABASE_URL ??= h.t.url; // the worker module registrar reads its env (no Northflank token: triggers are skipped)
  tasks = buildTaskList(h.deps, { environment: 'test' }) as Record<string, Task>;
  await governance.upsertJurisdictionRules(h.t.handle.db, { userId: h.users.owner.id }, { jurisdiction: 'US', domain: 'advertising', rules: { ftc: true }, sourceRefs: ['https://www.ftc.gov'], approve: true });
  await tx((t) =>
    governance.setTenantPolicy(t, h.tenantId, h.users.owner, {
      configured: true,
      currency: 'USD',
      approvedJurisdictions: ['US'],
      categories: {
        EXPERIMENT: { autonomy: 'pre_authorized_within_limits', approverRoles: ['approver'], requiresDistinctApprover: true, maxSpendDeltaMicrosPerAction: null, maxSpendDeltaMicrosPerDay: null, maxAudienceSize: null },
        PUBLIC_PUBLISHING: { autonomy: 'approval_required', approverRoles: ['approver'], requiresDistinctApprover: true, maxSpendDeltaMicrosPerAction: null, maxSpendDeltaMicrosPerDay: null, maxAudienceSize: null },
        SPEND: { autonomy: 'approval_required', approverRoles: ['finance_approver'], requiresDistinctApprover: true, maxSpendDeltaMicrosPerAction: null, maxSpendDeltaMicrosPerDay: null, maxAudienceSize: null },
      },
      forecastGates: { maxMaseRatioToBaseline: 1.0, intervalCoverageTolerance: 0.2, minBacktestFolds: 10 },
    }),
  );
  await tx((t) => autopilot.setAutopilotEnabled(t, h.tenantId, h.users.owner, true));
  metaConnId = (await connectionsModule.createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: '123', displayName: 'Acme Page', grantedScopes: ['pages_manage_posts', 'pages_read_engagement'], credentials: { accessToken: 'PAGE_TOKEN' } })).id;
  for (const s of ['Visitors who see a demo video install 2x more often', 'Store listing screenshots are outdated', 'Competitors rank for "habit tracker" with keyword-rich subtitles']) evidenceIds.push(await admit(s));

  // 40 days of App Store sales reports, as the daily M19 sync stores them.
  const today = Math.floor(h.clock.now().getTime() / DAY) * DAY;
  const ascConn = randomUUID();
  for (let i = 40; i >= 1; i--) {
    const day = new Date(today - i * DAY).toISOString().slice(0, 10);
    const downloads = 120 + Math.round(15 * Math.sin((2 * Math.PI * i) / 7)) + (i % 4);
    await tx(async (t) => {
      const e = await evidence.admitInternalEvidence(t, h.tenantId, systemActor('app-store-sync'), {
        kind: 'metric',
        sourceType: 'primary',
        owner: 'app_store_connect',
        uri: `asc://sales/DAILY/SUMMARY/${day}`,
        content: { reportDate: day, firstTimeDownloads: downloads },
        summary: `App Store sales ${day}`,
        confidence: 1,
        license: 'ASC terms',
        permittedUses: ['analytics', 'forecasting', 'causal_measurement'],
        observedAt: new Date(`${day}T23:59:59Z`),
        freshnessSlaHours: 72,
        now: h.clock.now(),
      });
      await t.insert(appStoreReports).values({ tenantId: h.tenantId, connectionId: ascConn, reportType: 'SALES_SUMMARY_DAILY', period: day, objectKey: `k/${day}`, sha256: 'b'.repeat(64), rowCount: 1, evidenceId: e.evidenceId });
    });
  }

  // Each call returns new, distinct ideas (the Idea Lab de-duplicates near-identical ones).
  provider.responders.set('ideaGeneration', (c) => {
    const ids = [...c.matchAll(new RegExp(`evidence (${UUID})`, 'g'))].map((m) => m[1]!);
    const words = () => Array.from({ length: 6 }, () => randomUUID().slice(0, 8)).join(' ');
    return {
      abstain: false,
      abstainReason: '',
      ideas: [
        {
          title: `Listing video ${words()}`,
          hypothesis: `A short demo video raises installs ${words()}`,
          mechanism: 'Visitors understand the app faster',
          audience: 'App Store visitors',
          targetMetric: 'installs',
          evidenceIds: [ids[0]],
          cheapFirstTest: 'ab_test',
          killCriteria: ['no change in conversion after 14 days'],
          risks: [],
        },
        {
          title: `Subtitle keywords ${words()}`,
          hypothesis: `A keyword-led subtitle brings more impressions ${words()}`,
          mechanism: 'Better keyword relevance',
          audience: 'App Store searchers',
          targetMetric: 'installs',
          evidenceIds: [ids[2] ?? ids[0]],
          cheapFirstTest: 'smoke_test',
          killCriteria: ['impressions flat after 14 days'],
          risks: ['ranking may not change'],
        },
      ],
    };
  });
  provider.responders.set('brainCritic', () => ({ verdict: 'proceed', unsupportedAssumptions: [], concerns: [] }));
  provider.responders.set('creativeBrief', (c) => {
    const claimId = c.match(new RegExp(`claim (${UUID})`))?.[1];
    return {
      abstain: false,
      abstainReason: '',
      title: 'Demo video',
      angle: 'See it work in 15 seconds',
      hooks: ['Build a habit in 15 seconds'],
      proofPoints: claimId ? [{ text: 'Works offline', claimId }] : [],
      cta: 'Download',
      format: 'short video',
      aspectRatio: '9:16',
      durationSeconds: 15,
      formatNotes: '',
      prohibitedClaims: [],
      experimentMatrix: [],
    };
  });
}, 180_000);

afterAll(async () => {
  await h?.close();
  await server.stop();
});

describe('Autopilot: one goal runs the growth loop unattended', () => {
  it('turns a $0 organic-downloads goal into a plan, runs M08→M06→M07→M23→M24 in the background and verifies a pre-authorized internal action', async () => {
    const strong = await idea('app.downloads.first_time', 'Test a demo-video store listing');
    const exp = await tx((t) =>
      experimentsModule.createExperiment(t, h.tenantId, h.users.operator, {
        name: 'Demo video listing',
        hypothesis: 'A demo video raises the install rate of store visitors',
        ideaId: strong.id,
        design: 'ab_fixed',
        unit: 'anonymous_id',
        targetMetric: 'install',
        metricType: 'binary',
        riskTier: 'low',
        variants: [
          { key: 'control', description: 'Current listing', isControl: true },
          { key: 'video', description: 'Listing with demo video' },
        ],
      }),
    );
    strategistReturns((c) => {
      const expId = c.match(new RegExp(`- (${UUID}) "Demo video listing"`))?.[1];
      return expId ? { actionType: 'experiment.start', params: { experimentId: expId } } : { actionType: 'none' };
    });

    const g = await goal();
    expect(g.adBudgetMicros).toBe(0);
    await runWorker(1);

    // The plan was persisted with reasons, and paid media is explicitly left out of a $0 goal.
    const [cycle] = await tx((t) => t.select().from(goalCycles).where(eq(goalCycles.goalId, g.id)));
    const plan = cycle!.plan as unknown as autopilot.CyclePlan;
    expect(plan.steps.map((s) => s.kind)).toEqual(['observe', 'forecast', 'research', 'ideas', 'decide', 'content', 'submit', 'track', 'measure', 'learn']);
    expect(plan.notUsed.some((n) => n.modules.includes('M17'))).toBe(true);

    // Observe bridged App Store reports into the KPI series; the forecast waits for the analytics job.
    let k = await byKind(g.id);
    expect(k.observe!.status).toBe('completed');
    expect(k.observe!.output.points).toBe(40);
    expect(k.forecast!.status).toBe('waiting');
    expect(k.forecast!.refs.analyticsRequestId).toBeTruthy();

    // The analytics job runs on its own schedule (Northflank cron); the worker continues by itself.
    if (py) runPythonAnalytics();
    else await recordForecast(k.forecast!.refs.analyticsRequestId!);
    await runWorker(8, 2 * 60_000);

    k = await byKind(g.id);
    expect(k.forecast!.status, k.forecast!.detail ?? '').toBe('completed');
    expect(k.research!.status).toBe('completed');
    expect(k.ideas!.status).toBe('completed');
    expect(k.decide!.status).toBe('completed');
    expect(k.decide!.output.ideaId).toBe(strong.id);
    expect(k.content!.status).toBe('blocked'); // no approved claims yet: explicit, not fabricated
    expect(k.content!.needs).toBe('claims');
    expect(k.submit!.status).toBe('completed');
    const actionId = k.submit!.refs.actionId!;
    expect(k.submit!.output.status).toBe('APPROVED'); // tenant policy pre-authorizes low-risk experiments

    // The worker executed and independently verified it; the cycle then measured and learned.
    const [a] = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.id, actionId)));
    expect(a!.status).toBe('VERIFIED');
    expect(a!.proposedByType).toBe('agent');
    const [e] = await tx((t) => t.select().from(growthDecisions).where(eq(growthDecisions.id, k.decide!.refs.decisionId!)));
    expect(e).toMatchObject({ status: 'ACCEPTED', decidedBy: 'system:autopilot', goalId: g.id, actionId });
    expect((await tx((t) => experimentsModule.experimentDetail(t, exp.id))).experiment.status).toBe('running');
    expect(k.track!.status).toBe('completed');
    expect(k.measure!.status).toBe('completed');
    expect(k.learn!.status).toBe('completed');
    const after = await goalRow(g.id);
    const [done] = await tx((t) => t.select().from(goalCycles).where(eq(goalCycles.goalId, g.id)));
    expect(done!.status).toBe('blocked'); // the content step needs claims; everything else ran
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(h.clock.now().getTime());
    expect((after.memory as { triedIdeas: Record<string, unknown> }).triedIdeas[strong.id]).toBeTruthy();
    // Every model call went through the registry-gated gateway (ideas 1, brain 2).
    expect(provider.calls.filter((x) => x.prompt === 'brainStrategist')).toHaveLength(1);
    // The strategist only saw action types of the authorized channels: nothing that spends money.
    const shown = provider.calls.find((x) => x.prompt === 'brainStrategist')!.content;
    expect(shown).not.toMatch(/ads\.google|ads\.meta|commerce\.shopify/);
    expect(shown).toContain('experiment.start');

    // Measure is computed from recorded values only; with no values after the start there is no progress figure.
    expect(k.measure!.output.status).toBe('insufficient_data');
    expect(k.measure!.output.actual).toBeNull();
  }, 420_000);
});

describe('Autopilot: restricted actions stop for approval, then execute once and verify', () => {
  it('publishing waits for a hash-bound human approval; the approved post executes exactly once and is verified by read-back', async () => {
    await series('kpi.signups');
    const ideaRow = await idea('kpi.signups', 'Announce the new onboarding');
    strategistReturns((c) =>
      c.includes(ideaRow.title)
        ? { actionType: 'social.facebook.publish_post', connectionId: metaConnId, params: { pageId: '123', message: 'Our new onboarding is live. Try it today.', postId: randomUUID(), claimIds: [], disclosure: { isAiGenerated: true, paidPartnership: false, syntheticPersonaId: null, disclosureText: null } } }
        : { actionType: 'none' },
    );
    let published: string | null = null;
    server.on('POST', '/v26.0/123/feed', (req) => {
      published = req.form!.get('message')!;
      return { json: { id: '123_42' } };
    });
    server.on('GET', '/v26.0/123_42', () => ({ json: { id: '123_42', message: published, is_published: true, permalink_url: 'https://fb.example/123_42' } }));

    const g = await goal({ title: 'More sign-ups', kpi: { metricKey: 'kpi.signups', label: 'Sign-ups', unit: 'count' }, channels: ['organic_social'] });
    await runWorker(1);
    await recordQueuedForecasts();
    await runWorker(6, 2 * 60_000);

    const k = await byKind(g.id);
    expect(k.submit!.output.status).toBe('APPROVAL_REQUIRED');
    expect(k.track!.status).toBe('waiting');
    const actionId = k.submit!.refs.actionId!;
    const [post] = await tx((t) => t.select().from(socialPosts).where(eq(socialPosts.createdBy, 'system:autopilot')));
    expect(post).toMatchObject({ status: 'submitted', platform: 'facebook' });
    // Nothing reached Meta while waiting, however long the worker runs.
    await runWorker(3, 5 * 60_000);
    expect(server.find('POST', '/v26.0/123/feed')).toHaveLength(0);
    const inbox = await tx((t) => autopilot.inbox(t));
    expect(inbox.approvals.map((x) => x.id)).toContain(actionId);

    const view = await tx(async (t) => (await execution.getActionDetail(t, actionId)).action);
    expect(view.policyDecision!.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['CATEGORY_REQUIRES_APPROVAL', 'DECISION_REQUIRES_APPROVAL']));
    expect(view.policyDecision!.approvalGroups).toHaveLength(1); // one approval covers both reasons
    await expect(execution.decideApproval(h.deps, h.tenantId, { ...h.users.approver, mfaVerified: false }, actionId, { decision: 'approved', expectedActionHash: view.actionHash })).rejects.toThrow(/multi-factor/);
    await execution.decideApproval(h.deps, h.tenantId, h.users.approver, actionId, { decision: 'approved', expectedActionHash: view.actionHash });
    await runWorker(4, 60_000);

    expect(server.find('POST', '/v26.0/123/feed')).toHaveLength(1);
    const [a] = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.id, actionId)));
    expect(a!.status).toBe('VERIFIED');
    const [p2] = await tx((t) => t.select().from(socialPosts).where(eq(socialPosts.id, post!.id)));
    expect(p2!.status).toBe('published_verified');
    // Exactly once: re-running execution is a no-op and Meta saw one publish.
    expect(await execution.executeAction(h.deps, h.tenantId, actionId)).toEqual({ kind: 'noop', status: 'VERIFIED' });
    await runWorker(2);
    expect(server.find('POST', '/v26.0/123/feed')).toHaveLength(1);
    const k2 = await byKind(g.id);
    expect(k2.track!.status).toBe('completed');
    expect(k2.track!.detail).toMatch(/independently verified/);
  }, 300_000);
});

describe('Autopilot: abstention, missing data and replanning', () => {
  it('records explicit blockers instead of progress when a tenant has no data or evidence, and replans when evidence arrives', async () => {
    const other = `org_${randomUUID().slice(0, 8)}`;
    await h.t.handle.db.insert(organization).values({ id: other, name: 'Empty Co', slug: other });
    await tx((t) => autopilot.setAutopilotEnabled(t, other, { ...h.users.owner }, true), other);
    const g = await tx(
      (t) =>
        autopilot.createGoal(t, h.deps, other, h.users.owner, {
          title: 'Grow downloads',
          statement: 'Grow downloads',
          kpi: { metricKey: 'app.downloads.first_time', label: 'Downloads', unit: 'downloads' },
          market: 'US',
          targetDate: new Date(h.clock.now().getTime() + 30 * DAY).toISOString(),
          channels: ['app_store', 'experiments'],
        }),
      other,
    );
    const before = provider.calls.length;
    for (let i = 0; i < 4; i++) {
      await autopilot.advanceGoal(h.deps, other, g.id, { maxSteps: 20 });
    }
    const k = Object.fromEntries((await tx((t) => t.select().from(goalTasks).where(eq(goalTasks.goalId, g.id)), other)).map((x) => [x.kind, x]));
    expect(k.forecast).toMatchObject({ status: 'blocked', needs: 'data' });
    expect(k.forecast!.detail).toMatch(/App Store Connect/);
    expect(k.ideas).toMatchObject({ status: 'blocked', needs: 'evidence' });
    expect(k.decide!.status).toBe('skipped');
    expect(k.submit!.status).toBe('skipped');
    expect(k.measure!.output.status).toBe('insufficient_data');
    expect(provider.calls.length).toBe(before); // no model call without evidence
    const row = await goalRow(g.id, other);
    expect((row.memory as { blockedOn: string[] }).blockedOn).toEqual(expect.arrayContaining(['data', 'evidence']));
    expect(await tx((t) => t.select().from(growthDecisions), other)).toHaveLength(0);

    // Tenant isolation: the first tenant cannot see this goal, and this tenant cannot see the first's.
    expect(await tx((t) => t.select().from(growthGoals).where(eq(growthGoals.id, g.id)))).toHaveLength(0);
    expect((await tx((t) => t.select().from(growthGoals), other)).map((x) => x.id)).toEqual([g.id]);
    await expect(tx((t) => autopilot.goalDetail(t, g.id))).rejects.toThrow(/not found/);

    // New evidence for the blocked goal brings the next cycle forward (never sooner than 1 h after the last).
    const planned = row.nextRunAt!;
    await withTenant(h.t.handle.db, { tenantId: other, actor: 'user:test' }, (t) =>
      evidence.admitEvidence(
        t,
        other,
        h.users.owner,
        {
          sourceType: 'primary',
          sourceOwner: 'empty',
          sourceUriOrObjectId: 'crm://x',
          retrievedAt: h.clock.now().toISOString(),
          licenseOrUsageRights: 'first-party',
          schemaVersion: '1',
          piiClassification: 'none',
          confidence: 0.9,
          freshnessSlaHours: 720,
          permittedUses: ['analytics'],
          kind: 'observation',
          summary: 'first customer interviews',
          content: { a: 1 },
        } as never,
        { now: h.clock.now() },
      ),
    );
    await dispatchOutbox();
    const nudged = await goalRow(g.id, other);
    expect(nudged.nextRunAt!.getTime()).toBeLessThan(planned.getTime());
    expect(nudged.nextRunAt!.getTime()).toBeGreaterThanOrEqual(nudged.lastCycleAt!.getTime() + autopilot.MIN_CYCLE_GAP_MS);
    expect(nudged.pendingTrigger).toMatch(/evidence/);
  }, 120_000);

  it('an abstaining Growth Brain blocks with its reason, the idea is marked tried and the next cycle comes sooner with another idea', async () => {
    await series('kpi.trials');
    const first = await idea('kpi.trials', 'Free trial banner on pricing page');
    provider.responders.set('brainStrategist', (c) =>
      c.includes(first.title)
        ? { abstain: true, abstainReason: 'evidence does not cover the pricing page', objective: '', actionType: 'none', connectionId: '', paramsJson: '{}', rationale: '', assumptions: [], counterfactual: '', downside: '' }
        : { abstain: false, abstainReason: '', objective: 'x', actionType: 'none', connectionId: '', paramsJson: '{}', rationale: 'wait for data', assumptions: [], counterfactual: 'baseline', downside: 'none' },
    );
    const g = await goal({ title: 'More trials', kpi: { metricKey: 'kpi.trials', label: 'Trials', unit: 'count' }, channels: ['experiments'], limits: { cadenceHours: 24, maxCyclesPerDay: 4, maxAiCallsPerDay: 12, maxOpenActions: 3 } });
    await runWorker(1);
    await recordQueuedForecasts();
    await runWorker(6, 2 * 60_000);
    const k = await byKind(g.id);
    expect(k.decide).toMatchObject({ status: 'blocked', needs: 'evidence' });
    expect(k.decide!.detail).toMatch(/abstained/);
    expect(k.learn!.output.replanHours).toBe(12);
    const row = await goalRow(g.id);
    expect(Object.keys((row.memory as { triedIdeas: Record<string, unknown> }).triedIdeas)).toContain(first.id);
    expect(row.nextRunAt!.getTime() - row.lastCycleAt!.getTime()).toBeLessThan(24 * 3_600_000);

    // Next cycle: a different idea is chosen (the generated ones), not the abstained one.
    h.clock.advance(13 * 3_600_000);
    await runWorker(1);
    await recordQueuedForecasts();
    await runWorker(6, 2 * 60_000);
    const cycles = await tx((t) => t.select().from(goalCycles).where(eq(goalCycles.goalId, g.id)).orderBy(asc(goalCycles.seq)));
    expect(cycles).toHaveLength(2);
    const second = (await tasksOf(g.id)).find((x) => x.cycleId === cycles[1]!.id && x.kind === 'decide')!;
    expect(second.output.ideaId).toBeTruthy();
    expect(second.output.ideaId).not.toBe(first.id);
  }, 180_000);
});

describe('Autopilot: budgets, controls and loop prevention', () => {
  it('a $0 goal can never submit spend, even if the model proposes it; budget overruns are refused', async () => {
    await tx((t) =>
      expect(autopilot.createGoal(t, h.deps, h.tenantId, h.users.owner, { title: 'Paid push', statement: 'Buy ads for sign-ups', kpi: { metricKey: 'kpi.signups', label: 'Sign-ups' }, market: 'US', targetDate: new Date(h.clock.now().getTime() + 10 * DAY).toISOString(), channels: ['paid_ads'] })).rejects.toThrow(
        /budget above zero/,
      ),
    );
    const googleConn = (await connectionsModule.createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'google_ads', externalAccountId: '1234567890', displayName: 'Ads', grantedScopes: ['https://www.googleapis.com/auth/adwords'], credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r' } })).id;
    const spend = { customerId: '1234567890', campaignBudgetId: '77', campaignRef: 'brand', newDailyBudget: { amountMicros: 60_000_000, currency: 'USD' }, previousDailyBudget: { amountMicros: 50_000_000, currency: 'USD' } };
    await series('kpi.leads');
    await idea('kpi.leads', 'Scale the branded campaign');
    strategistReturns(() => ({ actionType: 'ads.google.update_campaign_budget', connectionId: googleConn, params: spend }));
    const zero = await goal({ title: 'Leads, no budget', kpi: { metricKey: 'kpi.leads', label: 'Leads', unit: 'count' }, channels: ['experiments'] });
    await runWorker(1);
    await recordQueuedForecasts();
    await runWorker(6, 2 * 60_000);
    const k = await byKind(zero.id);
    expect(k.decide!.status).toBe('completed');
    expect(k.decide!.output.actionType).toBeNull(); // M07 drops actions outside the goal's channels
    expect(k.submit!.status).toBe('skipped');
    const spendActions = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.actionType, 'ads.google.update_campaign_budget')));
    expect(spendActions).toHaveLength(0);

    // A goal with paid ads and a $5 budget cannot add $10/day.
    await series('kpi.leads2');
    await idea('kpi.leads2', 'Raise branded budget');
    const small = await goal({ title: 'Leads, small budget', kpi: { metricKey: 'kpi.leads2', label: 'Leads', unit: 'count' }, channels: ['paid_ads'], adBudget: { amountMicros: 5_000_000, currency: 'USD' } });
    await runWorker(1);
    await recordQueuedForecasts();
    await runWorker(6, 2 * 60_000);
    const s = await byKind(small.id);
    expect(s.submit).toMatchObject({ status: 'blocked', needs: 'budget' });
    expect(await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.actionType, 'ads.google.update_campaign_budget')))).toHaveLength(0);
  }, 240_000);

  it('enforces the daily AI allowance, pause/resume, kill switches, one running cycle and the daily cycle cap', async () => {
    await series('kpi.activations');
    strategistReturns(() => ({ actionType: 'none' }));
    const g = await goal({ title: 'Activations', kpi: { metricKey: 'kpi.activations', label: 'Activations', unit: 'count' }, channels: ['experiments'], limits: { cadenceHours: 1, maxCyclesPerDay: 2, maxAiCallsPerDay: 1, maxOpenActions: 3 } });
    await runWorker(1);
    await recordQueuedForecasts();
    await runWorker(6, 2 * 60_000);
    const k = await byKind(g.id);
    expect(k.ideas!.status).toBe('completed'); // 1 call: within the allowance
    expect(k.decide!.status).toBe('skipped'); // 2 more calls would exceed it
    expect(k.decide!.detail).toMatch(/AI allowance/);

    // Pause: nothing runs; resume continues.
    await tx((t) => autopilot.commandGoal(t, h.deps, h.tenantId, h.users.owner, g.id, 'pause'));
    h.clock.advance(2 * 3_600_000);
    expect(await autopilot.advanceGoal(h.deps, h.tenantId, g.id)).toMatchObject({ idle: 'goal is paused', ran: [] });
    await tx((t) => autopilot.commandGoal(t, h.deps, h.tenantId, h.users.owner, g.id, 'resume'));

    // Tenant kill switch stops the Autopilot before any step.
    const ks = await tx((t) => governance.engageKillSwitch(t, h.tenantId, h.users.owner, { scope: 'agent', targetRef: 'autopilot', reason: 'review' }));
    const stopped = await autopilot.advanceGoal(h.deps, h.tenantId, g.id);
    expect(stopped.idle).toMatch(/emergency stop/);
    expect(stopped.ran).toEqual([]);
    await tx((t) => governance.releaseKillSwitch(t, h.tenantId, h.users.owner, ks.killSwitch.id));

    // Cycle 2 runs (cap is 2 per 24 h); a third start is refused until the window frees up.
    await autopilot.advanceGoal(h.deps, h.tenantId, g.id, { maxSteps: 30 });
    h.clock.advance(2 * 3_600_000);
    const third = await autopilot.advanceGoal(h.deps, h.tenantId, g.id, { maxSteps: 30 });
    const cycles = await tx((t) => t.select().from(goalCycles).where(eq(goalCycles.goalId, g.id)));
    expect(cycles.length).toBe(2);
    expect(third.idle).toMatch(/daily cycle limit/);
    // The database itself refuses a second running cycle for a goal (the transaction rolls back).
    const err = await tx(async (t) => {
      await t.update(goalCycles).set({ status: 'running' }).where(eq(goalCycles.id, cycles[0]!.id));
      await t.update(goalCycles).set({ status: 'running' }).where(eq(goalCycles.id, cycles[1]!.id));
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/goal_cycles_one_running_uq/);
    expect(await tx((t) => t.select().from(killSwitches).where(eq(killSwitches.engaged, true)))).toHaveLength(0);
  }, 240_000);

  it('recovers a step interrupted by a worker crash and never duplicates the decision or action', async () => {
    await series('kpi.retained');
    await idea('kpi.retained', 'Weekly progress email');
    strategistReturns(() => ({ actionType: 'none' }));
    const g = await goal({ title: 'Retention', kpi: { metricKey: 'kpi.retained', label: 'Retained users', unit: 'count' }, channels: ['experiments'] });
    await runWorker(1);
    await recordQueuedForecasts();
    // Simulate a worker that claimed the next step and died before reporting back.
    const pending = (await tasksOf(g.id)).find((x) => x.status === 'pending' || x.status === 'waiting')!;
    await tx((t) =>
      t
        .update(goalTasks)
        .set({ status: 'running', attempts: 1, leaseUntil: new Date(h.clock.now().getTime() + 10 * 60_000) })
        .where(eq(goalTasks.id, pending.id)),
    );
    expect((await autopilot.advanceGoal(h.deps, h.tenantId, g.id)).idle).toMatch(/in progress/);
    h.clock.advance(11 * 60_000); // lease expires
    await runWorker(8, 2 * 60_000);
    const t = (await tasksOf(g.id)).find((x) => x.id === pending.id)!;
    expect(['completed', 'skipped', 'blocked']).toContain(t.status);
    expect(t.attempts).toBeGreaterThanOrEqual(2);
    const all = await tasksOf(g.id);
    expect(all.every((x) => ['completed', 'skipped', 'blocked'].includes(x.status))).toBe(true);
    const decisions = await tx((tt) => tt.select().from(growthDecisions).where(eq(growthDecisions.goalId, g.id)));
    expect(decisions.length).toBeLessThanOrEqual(1);
    // Replaying the Autopilot acceptance returns the same action (idempotency key decision:<id>).
    const withAction = (
      await tx((tt) =>
        tt
          .select()
          .from(growthDecisions)
          .where(and(eq(growthDecisions.decidedBy, 'system:autopilot'))),
      )
    ).find((d) => d.actionId)!;
    const replay = await brain.autoAcceptDecision(h.deps, h.tenantId, withAction.id, { goalId: withAction.goalId! });
    expect(replay.id).toBe(withAction.actionId);
  }, 180_000);

  it('completes the goal at its target date with a final measurement from recorded values', async () => {
    const key = 'kpi.final';
    const sid = await series(key, 20, 50);
    const g = await goal({ title: 'Short goal', kpi: { metricKey: key, label: 'Final', unit: 'count', targetChangePct: 10 }, channels: ['experiments'], targetDate: new Date(h.clock.now().getTime() + 2 * DAY).toISOString() });
    await tx((t) => t.update(growthGoals).set({ nextRunAt: null }).where(eq(growthGoals.id, g.id)));
    const start = Math.floor(h.clock.now().getTime() / DAY) * DAY;
    // One value inside the goal window and one after the target date (must be ignored).
    await tx((t) =>
      analytics.appendPoints(
        t,
        h.tenantId,
        sid,
        [1, 3].map((d) => ({ ts: new Date(start + d * DAY).toISOString(), value: 60 })),
      ),
    );
    h.clock.advance(3 * DAY);
    await runWorker(1);
    const row = await goalRow(g.id);
    expect(row.status).toBe('completed');
    const m = (row.memory as { finalMeasurement: autopilot.Measurement }).finalMeasurement;
    expect(m.status).toBe('measured');
    expect(m.actual).toBe(60); // only the day inside the window that has a value (no invented numbers)
    expect(m.target).not.toBeNull();
    expect(m.baselinePerDay).not.toBeNull();
  }, 60_000);
});
