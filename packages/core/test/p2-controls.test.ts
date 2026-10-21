import { randomUUID } from 'node:crypto';
import { AbstainError, type ModelProvider, PROMPTS, type ProviderOutcome, ProviderUnavailableError } from '@futuregrow/agent-kernel';
import { HttpClient } from '@futuregrow/connectors';
import { alerts, apiDeprecationSignals, authUser, costLedger, modelRegistry, opsNotifications, withSystem, withTenant } from '@futuregrow/db';
import type { OpsAlert } from '@futuregrow/observability';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentActor, type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { clearModelCache, createModelGateway, runAgent } from '../src/agents.js';
import { getAiBudget } from '../src/ai-budget.js';
import { apiLifecycle, checkApiLifecycle, DeprecationRecorder, effectiveSunset, recordApiSunset } from '../src/api-lifecycle.js';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import { proposeAction } from '../src/modules/m23-execution/gateway.js';
import { approveModel, seedModelRegistry, setTenantPolicy, upsertJurisdictionRules } from '../src/modules/m24-governance/index.js';
import type { Notifier } from '../src/ops.js';

const server = new FixtureServer();
let h: CoreHarness;
const db = () => h.t.handle.db;
const Out = z.object({ title: z.string() });
// Realistic for the short prompt below: the gateway's upper bound (chars/3 input + max_tokens output) covers it.
const usage = { inputTokens: 500, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

class Scripted implements ModelProvider {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly outcome: () => ProviderOutcome<unknown> | Error,
  ) {}
  async generateStructured<T>(): Promise<ProviderOutcome<T>> {
    this.calls++;
    const r = this.outcome();
    if (r instanceof Error) throw r;
    return r as ProviderOutcome<T>;
  }
}
const answer = (servedBy: string) => () => ({ kind: 'ok' as const, output: { title: 'plan' }, servedBy, usage, stopReason: 'end_turn', requestId: null });

class Recording implements Notifier {
  readonly configured = true;
  sent: OpsAlert[] = [];
  async send(a: OpsAlert) {
    this.sent.push(a);
  }
}

const think = (tenantId: string) => runAgent(h.deps, tenantId, { kind: 'test', agentId: 'planner', triggeredBy: 'test', input: {} }, (ctx) => ctx.think('plan', PROMPTS.brainStrategist, { purpose: 'planning', messages: [{ role: 'user', content: 'plan the launch' }], outputSchema: Out, maxTokens: 10_000 }));

async function setAiLimit(monthlyLimitUsd: number | null) {
  await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => setTenantPolicy(tx, h.tenantId, h.users.owner, { configured: false, categories: {}, aiSpend: monthlyLimitUsd === null ? null : { monthlyLimitUsd, warnAtFraction: 0.5 } }));
}

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
  await seedModelRegistry(db());
  await approveModel(db(), { userId: h.users.owner.id }, { provider: 'anthropic', modelId: 'claude-opus-5-5', trainingOnCustomerData: 'no', dataRetentionTerms: 'reviewed', inputUsdPerMtok: 4, outputUsdPerMtok: 20 });
  // A second approved provider for failover.
  await withSystem(db(), 'test', (tx) =>
    tx.insert(modelRegistry).values({ provider: 'openai_compatible', modelId: 'backup-model-1', displayName: 'Backup', purposes: ['planning'], licenseOrTerms: 'reviewed', commercialUse: 'unknown', trainingOnCustomerData: 'unknown', approvedForProduction: false, inputUsdPerMtok: 1, outputUsdPerMtok: 2 }),
  );
  await approveModel(db(), { userId: h.users.owner.id }, { provider: 'openai_compatible', modelId: 'backup-model-1', trainingOnCustomerData: 'no', dataRetentionTerms: 'reviewed', inputUsdPerMtok: 1, outputUsdPerMtok: 2 });
  clearModelCache();
});
afterAll(async () => {
  await h?.close();
  await server.stop();
});
beforeEach(async () => {
  server.reset();
  clearModelCache();
  await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, async (tx) => {
    await tx.delete(costLedger);
    await tx.delete(alerts);
  });
  await setAiLimit(null);
});

describe('per-tenant AI spending limits', () => {
  it('lets calls through under the limit, warns at the threshold, then abstains with a critical alert', async () => {
    const p = new Scripted('anthropic', answer('claude-opus-5-5'));
    h.deps.models = createModelGateway(h.deps, { anthropic: p });
    // One call: 500 input + 10k output tokens at $4/$20 per Mtok = $0.202 recorded; bound ~$0.20.
    await setAiLimit(0.5);
    expect((await think(h.tenantId)).status).toBe('completed');
    let budget = await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => getAiBudget(tx, h.tenantId, h.deps.config));
    expect(budget).toMatchObject({ limitUsd: 0.5, source: 'tenant', reservedUsd: 0 });
    expect(budget.spentUsd).toBeCloseTo(0.202, 6);
    expect((await think(h.tenantId)).status).toBe('completed'); // projected ~$0.40 >= 50% of $0.50 => warning
    const warn = await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => tx.select().from(alerts).where(eq(alerts.kind, 'ai_budget_warning')));
    expect(warn).toHaveLength(1);

    // Next call's upper bound no longer fits under $0.50.
    const before = p.calls;
    const stopped = await think(h.tenantId);
    expect(stopped).toMatchObject({ status: 'abstained', reason: 'BUDGET_EXCEEDED' });
    expect(p.calls).toBe(before); // the provider was never called
    const crit = await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => tx.select().from(alerts).where(eq(alerts.kind, 'ai_budget_exceeded')));
    expect(crit).toHaveLength(1);
    expect(crit[0]!.severity).toBe('critical');
    budget = await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => getAiBudget(tx, h.tenantId, h.deps.config));
    expect(budget.spentUsd).toBeCloseTo(0.404, 6);
    expect(budget.spentUsd).toBeLessThanOrEqual(0.5);

    // Raising the limit resumes model calls.
    await setAiLimit(50);
    expect((await think(h.tenantId)).status).toBe('completed');
  });

  it('applies the platform default when the tenant has none, and refuses unpriced models under a limit', async () => {
    const p = new Scripted('anthropic', answer('claude-opus-5-5'));
    h.deps.models = createModelGateway({ ...h.deps, config: { ...h.deps.config, aiSpendDefaultMonthlyUsd: 0.1 } }, { anthropic: p });
    expect(await think(h.tenantId)).toMatchObject({ status: 'abstained', reason: 'BUDGET_EXCEEDED' });
    // No limit anywhere: an unpriced model is allowed (its usage is counted, never estimated).
    await withSystem(db(), 'test', (tx) => tx.update(modelRegistry).set({ outputUsdPerMtok: null }).where(eq(modelRegistry.modelId, 'claude-opus-5-5')));
    clearModelCache();
    h.deps.models = createModelGateway(h.deps, { anthropic: p });
    expect((await think(h.tenantId)).status).toBe('completed');
    // With a limit, spend can no longer be bounded: refused.
    await setAiLimit(100);
    expect(await think(h.tenantId)).toMatchObject({ status: 'abstained', reason: 'BUDGET_UNMEASURABLE' });
    await withSystem(db(), 'test', (tx) => tx.update(modelRegistry).set({ outputUsdPerMtok: 20 }).where(eq(modelRegistry.modelId, 'claude-opus-5-5')));
  });
});

describe('provider failover through the core gateway', () => {
  it('serves from the next approved provider when the preferred one is down, and records it on the run', async () => {
    const a = new Scripted('anthropic', () => new ProviderUnavailableError('anthropic 529 overloaded', true, 529));
    const b = new Scripted('openai_compatible', answer('backup-model-1'));
    h.deps.models = createModelGateway(h.deps, { anthropic: a, openai_compatible: b });
    const r = await think(h.tenantId);
    expect(r.status).toBe('completed');
    expect([a.calls, b.calls]).toEqual([1, 1]);
    const [row] = await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => tx.execute<{ stages: { model: string; summary: { failedOver?: string[] } }[] }>(sql`select stages from agent_runs where id = ${r.runId}`)).then((x) => x.rows);
    expect(row!.stages[0]).toMatchObject({ model: 'backup-model-1', summary: { failedOver: ['anthropic/claude-opus-5-5: anthropic 529 overloaded'] } });
    const cost = await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => tx.select().from(costLedger));
    expect(cost.map((c) => c.provider)).toEqual(['openai_compatible']);
  });

  it('never calls a model past its end of life', async () => {
    await withSystem(db(), 'test', (tx) =>
      tx
        .update(modelRegistry)
        .set({ eolAt: new Date(Date.now() - 86_400_000) })
        .where(eq(modelRegistry.modelId, 'claude-opus-5-5')),
    );
    clearModelCache();
    const a = new Scripted('anthropic', answer('claude-opus-5-5'));
    const b = new Scripted('openai_compatible', answer('backup-model-1'));
    h.deps.models = createModelGateway(h.deps, { anthropic: a, openai_compatible: b });
    expect((await think(h.tenantId)).status).toBe('completed');
    expect([a.calls, b.calls]).toEqual([0, 1]);
    await withSystem(db(), 'test', (tx) => tx.update(modelRegistry).set({ eolAt: null }).where(eq(modelRegistry.modelId, 'claude-opus-5-5')));
  });

  it('abstains (never guesses) when no approved provider can answer', async () => {
    const down = () => new ProviderUnavailableError('down', true, 503);
    h.deps.models = createModelGateway(h.deps, { anthropic: new Scripted('anthropic', down), openai_compatible: new Scripted('openai_compatible', down) });
    expect(await think(h.tenantId)).toMatchObject({ status: 'abstained', reason: 'MODEL_UNAVAILABLE' });
    expect(new AbstainError('BUDGET_EXCEEDED', 'x').reason).toBe('BUDGET_EXCEEDED');
  });
});

describe('API deprecation monitoring', () => {
  beforeEach(async () => {
    await withSystem(db(), 'test', async (tx) => {
      await tx.delete(apiDeprecationSignals);
      await tx.delete(opsNotifications);
    });
  });

  it('derives Shopify sunsets from policy, marks dated APIs without a date unverified, and records operator dates', async () => {
    const now = new Date('2026-10-21T00:00:00Z');
    const { apis } = await withSystem(db(), 'test', (tx) => apiLifecycle(tx, h.deps.config.versions, now));
    const by = Object.fromEntries(apis.map((a) => [a.provider, a]));
    expect(by.shopify).toMatchObject({ apiVersion: '2026-10', sunsetAt: '2027-10-01T00:00:00.000Z', sunsetSource: 'provider_policy', status: 'ok', daysLeft: 345 });
    expect(by.meta).toMatchObject({ apiVersion: 'v26.0', status: 'unverified', sunsetAt: null });
    expect(by.youtube).toMatchObject({ kind: 'evergreen', status: 'ok' });

    // Only an MFA-enabled platform admin may record dates (the harness owner is one).
    await expect(recordApiSunset(db(), { userId: h.users.approver.id }, { provider: 'meta', apiVersion: 'v26.0', sunsetAt: '2026-12-01T00:00:00Z', sourceUrl: 'https://developers.facebook.com/docs/graph-api/changelog' })).rejects.toThrow(/platform administrator/);
    const [owner] = await withSystem(db(), 'test', (tx) => tx.select().from(authUser).where(eq(authUser.id, h.users.owner.id)));
    expect(owner).toMatchObject({ isPlatformAdmin: true, twoFactorEnabled: true });
    await recordApiSunset(db(), { userId: h.users.owner.id }, { provider: 'meta', apiVersion: 'v26.0', sunsetAt: '2026-12-01T00:00:00Z', sourceUrl: 'https://developers.facebook.com/docs/graph-api/changelog' });
    const after = (await withSystem(db(), 'test', (tx) => apiLifecycle(tx, h.deps.config.versions, now))).apis.find((a) => a.provider === 'meta')!;
    expect(after).toMatchObject({ sunsetSource: 'operator', daysLeft: 41, status: 'warning' });

    // Milestone alerts: once each.
    const n = new Recording();
    await checkApiLifecycle(db(), n, h.deps.config.versions, 'test', now);
    await checkApiLifecycle(db(), n, h.deps.config.versions, 'test', new Date(now.getTime() + 3_600_000));
    expect(n.sent.map((a) => a.dedupKey).sort()).toEqual(['lifecycle:googleAds:v26:unverified', 'lifecycle:meta:v26.0:90d']);
    await checkApiLifecycle(db(), n, h.deps.config.versions, 'test', new Date('2026-11-28T00:00:00Z'));
    expect(n.sent.at(-1)).toMatchObject({ dedupKey: 'lifecycle:meta:v26.0:7d', severity: 'critical' });
  });

  it('detects Deprecation/Sunset headers and version upgrades on live responses', async () => {
    server.on('GET', '/v26.0/123/feed', () => ({ json: { data: [] }, headers: { deprecation: '@1795000000', sunset: 'Tue, 01 Dec 2026 00:00:00 GMT', link: '<https://developers.facebook.com/docs/graph-api/changelog>; rel="deprecation"', 'facebook-api-version': 'v27.0' } }));
    server.on('POST', '/admin/api/2026-10/graphql.json', () => ({ json: { data: {} }, headers: { 'x-shopify-api-deprecated-reason': 'https://shopify.dev/changelog/old-field', 'x-shopify-api-version': '2026-10' } }));
    const recorder = new DeprecationRecorder(db(), h.deps.config.endpoints, h.deps.config.versions);
    const http = new HttpClient({ onResponse: (r) => recorder.observe(r) });
    await http.request({ method: 'GET', url: `${server.baseUrl}/v26.0/123/feed?access_token=secret`, idempotent: true });
    await http.request({ method: 'GET', url: `${server.baseUrl}/v26.0/123/feed?access_token=secret`, idempotent: true });
    await http.request({ method: 'POST', url: `${server.baseUrl}/admin/api/2026-10/graphql.json`, json: { query: '{ shop { name } }' } });
    await recorder.flush();
    const rows = await withSystem(db(), 'test', (tx) => tx.select().from(apiDeprecationSignals).orderBy(apiDeprecationSignals.provider, apiDeprecationSignals.signal));
    expect(rows.map((r) => [r.provider, r.signal, r.endpoint, r.occurrences])).toEqual([
      ['meta', 'deprecation_header', '/:version/:id/feed', 1],
      ['meta', 'sunset_header', '/:version/:id/feed', 1],
      ['meta', 'version_upgraded', '/:version/:id/feed', 1],
      ['shopify', 'provider_warning', '/admin/api/:version/graphql.json', 1],
    ]);
    expect(JSON.stringify(rows)).not.toContain('secret');
    expect(rows.find((r) => r.signal === 'sunset_header')!.sunsetAt!.toISOString()).toBe('2026-12-01T00:00:00.000Z');

    // Meta already serves v27.0 for v26.0 requests: the version counts as sunset now.
    const meta = (await withSystem(db(), 'test', (tx) => apiLifecycle(tx, h.deps.config.versions))).apis.find((a) => a.provider === 'meta')!;
    expect(meta).toMatchObject({ status: 'sunset', sunsetSource: 'version_upgraded' });
    const n = new Recording();
    await checkApiLifecycle(db(), n, h.deps.config.versions, 'test');
    expect(n.sent.filter((a) => a.dedupKey.startsWith('deprecation-signal:'))).toHaveLength(4);
    expect(n.sent.find((a) => a.dedupKey === 'lifecycle:meta:v26.0:past')).toMatchObject({ severity: 'critical' });
  });

  it('blocks actions on a provider API version past its sunset (policy API_VERSION_SUNSET)', async () => {
    await upsertJurisdictionRules(db(), { userId: h.users.owner.id }, { jurisdiction: 'US', domain: 'advertising', rules: { ftc: true }, sourceRefs: ['https://www.ftc.gov'], approve: true });
    const conn = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: `page-${randomUUID().slice(0, 6)}`, displayName: 'Page', grantedScopes: ['pages_manage_posts', 'pages_read_engagement'], credentials: { accessToken: 'T' } });
    const ev = await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) =>
      admitEvidence(
        tx,
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
          permittedUses: ['autonomous_execution', 'publishing'],
          freshnessSlaHours: 24 * 90,
          kind: 'document',
          content: { plan: 'post' },
        },
        { now: h.clock.now() },
      ),
    );
    const propose = () =>
      proposeAction(h.deps, h.tenantId, agentActor(), {
        actionType: 'social.facebook.publish_post',
        connectionId: conn.id,
        params: { pageId: '123', message: 'hello', postId: randomUUID(), claimIds: [], disclosure: { isAiGenerated: false, paidPartnership: false, syntheticPersonaId: null, disclosureText: null } },
        evidenceIds: [ev.evidenceId],
        risk: { geographies: ['US'] },
        idempotencyKey: `fb-${randomUUID()}`,
      });
    const before = await propose();
    expect(JSON.stringify(before)).not.toContain('API_VERSION_SUNSET');
    await withSystem(db(), 'test', (tx) => tx.insert(apiDeprecationSignals).values({ provider: 'meta', apiVersion: 'v26.0', signal: 'registry_eol', endpoint: '*', sunsetAt: new Date(h.clock.now().getTime() - 86_400_000), detail: 'test' }));
    expect(await withTenant(db(), { tenantId: h.tenantId, actor: 'test' }, (tx) => effectiveSunset(tx, 'meta', h.deps.config.versions, h.clock.now()))).toMatchObject({ basis: 'date recorded by an operator' });
    const blocked = await propose();
    expect(blocked.status).toBe('DENIED');
    expect(JSON.stringify(blocked)).toContain('API_VERSION_SUNSET');
    await withSystem(db(), 'test', (tx) => tx.delete(apiDeprecationSignals).where(and(eq(apiDeprecationSignals.provider, 'meta'), eq(apiDeprecationSignals.signal, 'registry_eol'))));
  });
});
