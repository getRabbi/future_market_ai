import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ModelProvider, ProviderOutcome, StructuredRequest } from '@futuregrow/agent-kernel';
import { PROMPTS } from '@futuregrow/agent-kernel';
import { publicFetch } from '@futuregrow/connectors';
import { agentRuns, competitorObservations, competitorSources, costLedger, forecastPoints, forecastRuns, growthDecisions, killSwitches, withTenant } from '@futuregrow/db';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { clearModelCache, createModelGateway } from '../src/agents.js';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import * as comp from '../src/modules/m05-competitors/index.js';
import * as ideas from '../src/modules/m06-ideas/index.js';
import * as brain from '../src/modules/m07-brain/index.js';
import * as analytics from '../src/modules/m08-analytics/index.js';
import { approveModel, seedModelRegistry } from '../src/modules/m24-governance/index.js';

type Responder = (req: StructuredRequest<unknown>) => unknown;

class ScriptedProvider implements ModelProvider {
  readonly name = 'anthropic';
  responders = new Map<string, Responder>();
  calls: string[] = [];
  async generateStructured<T>(req: StructuredRequest<T>): Promise<ProviderOutcome<T>> {
    const entry = [...this.responders.entries()].find(([sys]) => req.system === sys);
    this.calls.push(entry ? Object.entries(PROMPTS).find(([, p]) => p.system === entry[0])![0] : 'unknown');
    if (!entry) throw new Error('no scripted response for this prompt');
    return { kind: 'ok', output: entry[1](req as StructuredRequest<unknown>) as T, servedBy: 'claude-opus-5-5', usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', requestId: 'req_x' };
  }
}

const server = new FixtureServer();
let h: CoreHarness;
let provider: ScriptedProvider;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

async function evidence(over: Record<string, unknown> = {}) {
  return tx((t) =>
    admitEvidence(
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
        confidence: 0.9,
        freshnessSlaHours: 24 * 90,
        permittedUses: ['analytics', 'autonomous_execution'],
        kind: 'observation',
        summary: 'Trial users who connect an integration in week one retain 2x better',
        content: { n: randomUUID() },
        ...over,
      } as never,
      { now: h.clock.now() },
    ),
  );
}

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness();
  await seedModelRegistry(h.t.handle.db);
  await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'anthropic', modelId: 'claude-opus-5-5', trainingOnCustomerData: 'no', dataRetentionTerms: 'vendor commercial terms reviewed 2026-10', inputUsdPerMtok: 4, outputUsdPerMtok: 20 });
  clearModelCache();
  provider = new ScriptedProvider();
  h.deps.models = createModelGateway(h.deps, { anthropic: provider });
  (h.deps as unknown as { fetchPublic: comp.PublicFetcher }).fetchPublic = (u, o) => publicFetch(u.replace('https://competitor.example', server.baseUrl), { ...o, allowPrivateForTests: true });
});
afterAll(async () => {
  await h?.close();
  await server.stop();
});
beforeEach(() => {
  server.reset();
  provider.responders.clear();
});

describe('M05 competitor war room', () => {
  let competitorId: string;
  let sourceId: string;

  it('only allows sources on competitor domains, approved by legal with MFA', async () => {
    const c = await tx((t) => comp.addCompetitor(t, h.tenantId, h.users.operator, { name: 'Rival', domains: ['competitor.example'] }));
    competitorId = c.id;
    await expect(tx((t) => comp.proposeSource(t, h.tenantId, h.users.operator, { competitorId, url: 'https://evil.example/pricing', kind: 'pricing', lawfulBasisNote: 'public pricing page' }))).rejects.toThrow(/not one of the competitor/);
    const s = await tx((t) => comp.proposeSource(t, h.tenantId, h.users.operator, { competitorId, url: 'https://competitor.example/pricing', kind: 'pricing', lawfulBasisNote: 'public pricing page, no login required' }));
    sourceId = s.id;
    expect((await comp.crawlSource(h.deps, h.tenantId, sourceId)).status).toBe('not_approved');
    await expect(tx((t) => comp.reviewSource(t, h.tenantId, h.users.operator, sourceId, 'approved'))).rejects.toThrow(/roles/);
    await tx((t) => comp.reviewSource(t, h.tenantId, h.users.legal, sourceId, 'approved'));
  });

  it('captures snapshots as evidence and records literal price changes as [P]', async () => {
    let price = '$29/mo';
    server.on('GET', '/robots.txt', { text: 'User-agent: *\nDisallow: /private\n', headers: { 'content-type': 'text/plain' } });
    server.on('GET', '/pricing', () => ({ text: `<html><head><title>Pricing</title></head><body><h1>Plans</h1><h2>Starter</h2><p>Starter costs ${price}.</p></body></html>`, headers: { 'content-type': 'text/html' } }));
    const first = await comp.crawlSource(h.deps, h.tenantId, sourceId);
    expect(first.status).toBe('captured');
    h.clock.advance(25 * 3_600_000);
    expect((await comp.crawlSource(h.deps, h.tenantId, sourceId)).status).toBe('unchanged');
    h.clock.advance(25 * 3_600_000);
    price = '$35/mo';
    server.on('GET', '/pricing', () => ({ text: `<html><body><h1>Plans</h1><h2>Starter</h2><h2>Teams</h2><p>Starter costs ${price}.</p></body></html>`, headers: { 'content-type': 'text/html' } }));
    const third = await comp.crawlSource(h.deps, h.tenantId, sourceId);
    expect(third).toMatchObject({ status: 'captured', observations: 2 });
    const obs = await tx((t) => t.select().from(competitorObservations));
    const pc = obs.find((o) => o.kind === 'price_change')!;
    expect(pc.evidenceFlag).toBe('P');
    expect(pc.details).toMatchObject({ added: ['$35/mo'], removed: ['$29/mo'] });
    expect(pc.evidenceIds).toHaveLength(2);
  });

  it('honours robots.txt', async () => {
    const s = await tx((t) => comp.proposeSource(t, h.tenantId, h.users.operator, { competitorId, url: 'https://competitor.example/private/roadmap', kind: 'other', lawfulBasisNote: 'public page linked from homepage' }));
    await tx((t) => comp.reviewSource(t, h.tenantId, h.users.legal, s.id, 'approved'));
    server.on('GET', '/robots.txt', { text: 'User-agent: *\nDisallow: /private\n', headers: { 'content-type': 'text/plain' } });
    expect((await comp.crawlSource(h.deps, h.tenantId, s.id)).status).toBe('robots_disallowed');
    expect(server.find('GET', '/private/roadmap')).toHaveLength(0);
    const [row] = await tx((t) => t.select().from(competitorSources).where(eq(competitorSources.id, s.id)));
    expect(row!.lastRobotsAllowed).toBe(false);
  });

  it('keeps model observations only when their snippet is literally in the diff, flagged [I]', async () => {
    const [snap] = await tx((t) => t.query.competitorSnapshots.findMany({ orderBy: (s, { desc }) => [desc(s.fetchedAt)], limit: 1 }));
    provider.responders.set(PROMPTS.competitorExtraction.system, () => ({
      abstain: false,
      observations: [
        { kind: 'feature_added', summary: 'Added a Teams plan', snippet: 'Teams' },
        { kind: 'positioning', summary: 'Now targets enterprises', snippet: 'Enterprise-grade security for everyone' },
      ],
    }));
    const r = await comp.extractObservationsWithModel(h.deps, h.tenantId, snap!.id);
    expect(r).toMatchObject({ status: 'completed', result: { created: 1 } });
    const inferred = (await tx((t) => t.select().from(competitorObservations))).filter((o) => o.evidenceFlag === 'I');
    expect(inferred.map((o) => o.summary)).toEqual(['Added a Teams plan']);
  });

  it('REA jobs require legal authorization and remain blocked without a sandbox', async () => {
    const ev = await evidence({ kind: 'contract', summary: 'licence grants analysis rights' });
    await expect(tx((t) => comp.registerReaJob(t, h.tenantId, h.users.operator, { targetDescription: 'our own legacy SDK binary', artifactRef: 'r2://legacy-sdk.bin', ownershipOrLicence: 'owned_by_tenant', authorizationEvidenceId: ev.evidenceId, legalApproved: true }))).rejects.toThrow(/roles/);
    await expect(tx((t) => comp.registerReaJob(t, h.tenantId, h.users.legal, { targetDescription: 'x', artifactRef: 'y', ownershipOrLicence: 'owned_by_tenant', authorizationEvidenceId: ev.evidenceId, legalApproved: false }))).rejects.toThrow();
    const job = await tx((t) => comp.registerReaJob(t, h.tenantId, h.users.legal, { targetDescription: 'our own legacy SDK binary', artifactRef: 'r2://legacy-sdk.bin', ownershipOrLicence: 'owned_by_tenant', authorizationEvidenceId: ev.evidenceId, legalApproved: true }));
    expect(job.status).toBe('blocked_no_sandbox');
  });
});

describe('M06 idea lab', () => {
  it('screens out deceptive tactics and sensitive audiences', () => {
    expect(ideas.screenIdea({ title: 'Buy followers to look popular', hypothesis: 'x', mechanism: 'y', audience: 'everyone' }).passed).toBe(false);
    expect(ideas.screenIdea({ title: 'Retarget users', hypothesis: 'x', mechanism: 'y', audience: 'pregnant women aged 25-34' }).sensitiveAudience).toBe(true);
    expect(ideas.screenIdea({ title: 'Integration onboarding', hypothesis: 'x', mechanism: 'y', audience: 'new trial teams' }).passed).toBe(true);
  });

  it('computes sample size and IdeaValue only from supplied quantities', () => {
    expect(ideas.sampleSizeTwoProportions(0.1, 0.2)).toBe(3841);
    const unscored = ideas.scoreIdea({ prior: { successes: 0, failures: 0 }, impact: null, valuePerUnit: 50, expectedCost: 100, riskScore: 0.1, lambdas: null });
    expect(unscored).toMatchObject({ status: 'unscored', reason: 'impact range unknown [U]' });
    const scored = ideas.scoreIdea({ prior: { successes: 3, failures: 1 }, impact: { p10: 8, p90: 12, periods: 4 }, valuePerUnit: 50, expectedCost: 200, riskScore: 0.1, lambdas: null });
    // E = P(success) * mean impact * periods * value - cost = (4/6) * 10 * 4 * 50 - 200
    expect(scored.status).toBe('scored_without_risk_penalty');
    if ('value' in scored && scored.value) expect(scored.value.mean).toBeCloseTo((4 / 6) * 10 * 4 * 50 - 200, -1);
  });

  it('creates ideas with routes, rejects unsupported evidence and detects duplicates', async () => {
    const ev = await evidence();
    const base = { title: 'Integration-first onboarding checklist', hypothesis: 'If trial teams connect an integration in week one, 30-day retention improves', mechanism: 'Earlier time-to-value through integrations', audience: 'new trial teams', targetMetric: 'kpi.retention_30d', evidenceIds: [ev.evidenceId], killCriteria: ['retention does not improve after 2 cohorts'] };
    const a = await tx((t) => ideas.createIdea(t, h.deps, h.tenantId, h.users.operator, base, 'human'));
    expect(a).toMatchObject({ route: 'discovery_test', status: 'candidate' });
    const dup = await tx((t) => ideas.createIdea(t, h.deps, h.tenantId, h.users.operator, { ...base, title: 'Integration-first onboarding checklist v2' }, 'human'));
    expect(dup.status).toBe('duplicate');
    const quarantined = await evidence({ licenseOrUsageRights: null });
    await expect(tx((t) => ideas.createIdea(t, h.deps, h.tenantId, h.users.operator, { ...base, title: 'Different', evidenceIds: [quarantined.evidenceId] }, 'human'))).rejects.toThrow(/admitted/);
  });

  it('generates ideas through the gateway and drops ones citing unseen evidence', async () => {
    const ev = await evidence({ summary: 'Support tickets about CSV import doubled this month' });
    provider.responders.set(PROMPTS.ideaGeneration.system, () => ({
      abstain: false,
      abstainReason: '',
      ideas: [
        { title: 'Guided CSV import wizard', hypothesis: 'A guided import reduces failed imports and support load for new accounts', mechanism: 'Removes the main activation blocker seen in tickets', audience: 'accounts in their first week', targetMetric: 'kpi.activation', evidenceIds: [ev.evidenceId], cheapFirstTest: 'smoke_test', killCriteria: ['import failure rate unchanged'], risks: [] },
        { title: 'Made-up opportunity', hypothesis: 'This cites evidence the model never saw at all', mechanism: 'none', audience: 'everyone', targetMetric: 'kpi.x', evidenceIds: [randomUUID()], cheapFirstTest: 'ab_test', killCriteria: ['n/a'], risks: [] },
      ],
    }));
    const r = await ideas.generateIdeas(h.deps, h.tenantId, h.users.operator, { maxIdeas: 3 });
    expect(r.status).toBe('completed');
    if (r.status === 'completed') {
      expect(r.result.created).toHaveLength(1);
      expect(r.result.rejected?.[0]?.reason).toMatch(/not provided/);
    }
    const [run] = await tx((t) => t.select().from(agentRuns).where(eq(agentRuns.id, r.runId)));
    const stages = run!.stages as { name: string; prompt: { version: string; hash: string } | null; model: string | null }[];
    expect(stages.find((s) => s.name === 'strategize')).toMatchObject({ model: 'claude-opus-5-5', prompt: { version: '1.0.0' } });
    const costs = await tx((t) => t.select().from(costLedger).where(eq(costLedger.refId, r.runId)));
    expect(costs[0]).toMatchObject({ category: 'llm', amountUsd: expect.closeTo((500 * 4 + 100 * 20) / 1e6, 8) });
  });

  it('abstains (never fabricates) when no approved model is available', async () => {
    const saved = h.deps.models;
    h.deps.models = undefined;
    const r = await ideas.generateIdeas(h.deps, h.tenantId, h.users.operator);
    h.deps.models = saved;
    expect(r).toMatchObject({ status: 'abstained', reason: 'MODEL_UNAVAILABLE' });
  });
});

describe('M07 growth brain', () => {
  let ideaId: string;
  let connId: string;

  beforeAll(async () => {
    const ev = await evidence({ summary: 'Paid search drives 40% of signups at stable CPA' });
    const seriesEv = await evidence({ kind: 'metric', summary: 'daily signups' });
    const s = await tx((t) => analytics.upsertSeries(t, h.tenantId, h.users.owner, { key: 'kpi.signups', name: 'Signups', unit: 'count', granularity: 'day', kind: 'kpi', sourceEvidenceId: seriesEv.evidenceId }));
    const req = await tx((t) => analytics.requestAnalytics(t, h.tenantId, h.users.analyst, 'forecast', { seriesId: s.id, horizon: 7 }));
    await tx(async (t) => {
      const [run] = await t
        .insert(forecastRuns)
        .values({ tenantId: h.tenantId, requestId: req.id, seriesId: s.id, horizon: 7, status: 'champion_selected', championModel: 'holt_winters_damped', baselineModel: 'seasonal_naive', candidates: [], gate: { configured: true }, selectionReason: 'test', calibration: { coverage80: 0.8, folds: 20 }, drift: {}, datasetSha256: 'a'.repeat(64), config: {}, seed: 1, codeVersion: '0.1.0' })
        .returning();
      for (let i = 0; i < 7; i++) {
        await t.insert(forecastPoints).values({ tenantId: h.tenantId, runId: run!.id, ts: new Date(Date.parse('2026-10-20T00:00:00Z') + i * 86_400_000), mean: 100, q025: 80, q10: 90, q50: 100, q90: 110, q975: 120 });
      }
    });
    const idea = await tx((t) => ideas.createIdea(t, h.deps, h.tenantId, h.users.operator, { title: 'Scale branded search budget', hypothesis: 'Raising the branded search budget captures more high-intent signups at similar cost', mechanism: 'Impression share is budget-limited', audience: 'branded search users in US', targetMetric: 'kpi.signups', evidenceIds: [ev.evidenceId], killCriteria: ['CPA rises above target'] }, 'human'));
    ideaId = idea.id;
    connId = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'google_ads', externalAccountId: '1234567890', displayName: 'Ads', grantedScopes: ['https://www.googleapis.com/auth/adwords'], credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r' } })).id;
  });

  const strategist = (actionType: string, params: unknown) => () => ({
    abstain: false,
    abstainReason: '',
    objective: 'More signups from branded search',
    actionType,
    connectionId: connId,
    paramsJson: JSON.stringify(params),
    rationale: 'Impression share lost to budget suggests headroom',
    assumptions: ['CPA stays within 10% at higher budget'],
    counterfactual: 'Signups follow the baseline forecast',
    downside: 'Higher spend without incremental signups',
  });
  const budgetParams = { customerId: '1234567890', campaignBudgetId: '77', campaignRef: 'brand', newDailyBudget: { amountMicros: 60_000_000, currency: 'USD' }, previousDailyBudget: { amountMicros: 50_000_000, currency: 'USD' } };

  it('produces a typed decision with forecast distribution, policy dry-run and unscored utility', async () => {
    provider.responders.set(PROMPTS.brainStrategist.system, strategist('ads.google.update_campaign_budget', budgetParams));
    provider.responders.set(PROMPTS.brainCritic.system, () => ({ verdict: 'proceed', unsupportedAssumptions: ['CPA stability is not evidenced'], concerns: [] }));
    const r = await brain.proposeDecision(h.deps, h.tenantId, h.users.operator, { ideaId, market: 'US', horizon: { value: 1, unit: 'week' } });
    expect(r.status).toBe('completed');
    if (r.status !== 'completed') return;
    const d = r.result.decision;
    expect(d.proposedAction?.actionType).toBe('ads.google.update_campaign_budget');
    expect(d.predictedOutcomes).toMatchObject({ metric: 'kpi.signups', pointSummary: 700, interval: { level: 0.8, low: 630, high: 770 } });
    expect(d.estimatedIncrementalEffect.method).toBe('unknown');
    expect(d.expectedCost).toMatchObject({ amount: 70, currency: 'USD' });
    expect(d.utility.status).toBe('UNSCORED_LAMBDAS_UNCONFIGURED');
    expect(d.approvalRequirement.required).toBe(true);
    expect(d.assumptions.some((a) => a.startsWith('[critic: unsupported]'))).toBe(true);
    expect(d.modelVersions.strategist).toContain('brain.strategist:1.0.0');
    const [row] = await tx((t) => t.select().from(growthDecisions).where(eq(growthDecisions.id, r.result.decisionId)));
    expect(row!.status).toBe('PROPOSED');
    expect(provider.calls).toEqual(expect.arrayContaining(['brainStrategist', 'brainCritic']));

    const action = await brain.acceptDecision(h.deps, h.tenantId, h.users.operator, r.result.decisionId);
    expect(action.proposedBy).toMatchObject({ type: 'agent', id: 'growth-brain' });
    expect(action.decisionId).toBe(r.result.decisionId);
    expect(['APPROVAL_REQUIRED', 'DENIED']).toContain(action.status);
  });

  it('drops hallucinated action types instead of executing them', async () => {
    provider.responders.set(PROMPTS.brainStrategist.system, strategist('ads.google.buy_impressions', {}));
    provider.responders.set(PROMPTS.brainCritic.system, () => ({ verdict: 'proceed', unsupportedAssumptions: [], concerns: [] }));
    const r = await brain.proposeDecision(h.deps, h.tenantId, h.users.operator, { ideaId, market: 'US', horizon: { value: 1, unit: 'week' } });
    expect(r.status).toBe('completed');
    if (r.status === 'completed') {
      expect(r.result.decision.proposedAction).toBeNull();
      expect(r.result.decision.assumptions.join(' ')).toMatch(/not on the supported allowlist/);
    }
  });

  it('abstains without a forecast and when the agent kill switch is engaged', async () => {
    const ev = await evidence();
    const idea = await tx((t) => ideas.createIdea(t, h.deps, h.tenantId, h.users.operator, { title: 'Untracked metric idea', hypothesis: 'Something about a metric that has no series registered', mechanism: 'mechanism not yet understood', audience: 'all users', targetMetric: 'kpi.unknown', evidenceIds: [ev.evidenceId], killCriteria: ['no effect'] }, 'human'));
    expect(await brain.proposeDecision(h.deps, h.tenantId, h.users.operator, { ideaId: idea.id, market: 'US', horizon: { value: 1, unit: 'week' } })).toMatchObject({ status: 'abstained', reason: 'INSUFFICIENT_EVIDENCE' });
    await tx((t) => t.insert(killSwitches).values({ tenantId: h.tenantId, scope: 'agent', targetRef: 'growth-brain', reason: 'review', engagedBy: 'user:test' }));
    expect(await brain.proposeDecision(h.deps, h.tenantId, h.users.operator, { ideaId, market: 'US', horizon: { value: 1, unit: 'week' } })).toMatchObject({ status: 'abstained', reason: 'KILL_SWITCH' });
  });
});
