import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { ModelProvider, ProviderOutcome, StructuredRequest } from '@futuregrow/agent-kernel';
import { PROMPTS } from '@futuregrow/agent-kernel';
import { clearGoogleTokenCache, publicFetch } from '@futuregrow/connectors';
import { actionRequests, adBudgetHistory, adCampaigns, adDailyMetrics, alerts, appInstalls, customerEvents, seoPages, socialInteractions, socialPosts, spendLedger, storeListings, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { clearModelCache, createModelGateway } from '../src/agents.js';
import { createConnection } from '../src/modules/connections.js';
import { ingestEvents } from '../src/modules/m02-customers/index.js';
import type { PublicFetcher } from '../src/modules/m05-competitors/index.js';
import * as social from '../src/modules/m16-social/index.js';
import * as paid from '../src/modules/m17-paid/index.js';
import * as disc from '../src/modules/m18-discovery/index.js';
import * as app from '../src/modules/m19-app-growth/index.js';
import { decideApproval, executeAction, verifyAction } from '../src/modules/m23-execution/gateway.js';
import { approveModel, seedModelRegistry, setTenantPolicy, upsertJurisdictionRules } from '../src/modules/m24-governance/index.js';
import { ingestWebhook, processWebhook } from '../src/modules/webhooks.js';

class ScriptedProvider implements ModelProvider {
  readonly name = 'anthropic';
  responders = new Map<string, (req: StructuredRequest<unknown>) => unknown>();
  requests: StructuredRequest<unknown>[] = [];
  async generateStructured<T>(req: StructuredRequest<T>): Promise<ProviderOutcome<T>> {
    this.requests.push(req as StructuredRequest<unknown>);
    const r = this.responders.get(req.system);
    if (!r) throw new Error('no scripted response');
    return { kind: 'ok', output: r(req as StructuredRequest<unknown>) as T, servedBy: 'claude-opus-5-5', usage: { inputTokens: 300, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', requestId: 'req_s' };
  }
}

const server = new FixtureServer();
let h: CoreHarness;
let provider: ScriptedProvider;
let metaConn: string;
let googleConn: string;
let ascConn: string;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
  await seedModelRegistry(h.t.handle.db);
  await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'anthropic', modelId: 'claude-opus-5-5', trainingOnCustomerData: 'no', dataRetentionTerms: 'reviewed', inputUsdPerMtok: 4, outputUsdPerMtok: 20 });
  clearModelCache();
  provider = new ScriptedProvider();
  h.deps.models = createModelGateway(h.deps, { anthropic: provider });
  (h.deps as unknown as { fetchPublic: PublicFetcher }).fetchPublic = (u, o) => publicFetch(u, { ...o, allowPrivateForTests: true });
  await upsertJurisdictionRules(h.t.handle.db, { userId: h.users.owner.id }, { jurisdiction: 'US', domain: 'advertising', rules: { ftc: true }, sourceRefs: ['https://www.ftc.gov'], approve: true });
  await tx((t) =>
    setTenantPolicy(t, h.tenantId, h.users.owner, {
      configured: true,
      currency: 'USD',
      approvedJurisdictions: ['US'],
      categories: { PUBLIC_PUBLISHING: { autonomy: 'approval_required', approverRoles: ['approver'], requiresDistinctApprover: true, maxAudienceSize: null } },
    }),
  );
  metaConn = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: '123', displayName: 'Acme Page', grantedScopes: ['pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement', 'ads_management', 'ads_read'], credentials: { accessToken: 'PAGE' } })).id;
  googleConn = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'google_ads', externalAccountId: '1234567890', displayName: 'Ads', grantedScopes: ['https://www.googleapis.com/auth/adwords'], credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r' } })).id;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  ascConn = (
    await createConnection(h.deps, h.tenantId, h.users.owner, {
      provider: 'app_store_connect',
      externalAccountId: 'app-1',
      displayName: 'ASC',
      grantedScopes: [],
      credentials: { issuerId: 'iss', keyId: 'KEY123', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), vendorNumber: '8000' },
    })
  ).id;
});

afterAll(async () => {
  await h?.close();
  await server.stop();
});

beforeEach(() => {
  server.reset();
  provider.responders.clear();
  clearGoogleTokenCache();
});

/* ------------------------------------------------------------------ */

describe('M16 organic social', () => {
  it('validates, de-duplicates and spaces scheduled posts', async () => {
    const at = new Date(h.clock.now().getTime() + 3_600_000).toISOString();
    await expect(tx((t) => social.schedulePost(t, h.deps, h.tenantId, h.users.operator, { connectionId: googleConn, platform: 'facebook', caption: 'Hello', scheduledAt: at }))).rejects.toThrow(/needs meta/);
    await expect(tx((t) => social.schedulePost(t, h.deps, h.tenantId, h.users.operator, { connectionId: metaConn, platform: 'instagram', caption: 'Hello', scheduledAt: at }))).rejects.toThrow(/need media/);
    await expect(tx((t) => social.schedulePost(t, h.deps, h.tenantId, h.users.analyst, { connectionId: metaConn, platform: 'facebook', caption: 'Hello', scheduledAt: at }))).rejects.toThrow(/requires one of roles/);
    await expect(tx((t) => social.schedulePost(t, h.deps, h.tenantId, h.users.operator, { connectionId: metaConn, platform: 'facebook', caption: 'The best tool ever', scheduledAt: at }))).rejects.toThrow(/lint/);
    await expect(tx((t) => social.schedulePost(t, h.deps, h.tenantId, h.users.operator, { connectionId: metaConn, platform: 'facebook', caption: 'Partner post', scheduledAt: at, disclosure: { isAiGenerated: false, paidPartnership: true, disclosureText: null } }))).rejects.toThrow(/disclosure/);

    const first = await tx((t) => social.schedulePost(t, h.deps, h.tenantId, h.users.operator, { connectionId: metaConn, platform: 'facebook', caption: 'Our spring update is live.', scheduledAt: at, geographies: ['US'] }));
    expect(first.status).toBe('scheduled');
    await expect(tx((t) => social.schedulePost(t, h.deps, h.tenantId, h.users.operator, { connectionId: metaConn, platform: 'facebook', caption: 'our spring update is LIVE', scheduledAt: new Date(Date.parse(at) + 86_400_000).toISOString() }))).rejects.toThrow(/same caption/);
    await expect(tx((t) => social.schedulePost(t, h.deps, h.tenantId, h.users.operator, { connectionId: metaConn, platform: 'facebook', caption: 'A different note', scheduledAt: new Date(Date.parse(at) + 5 * 60_000).toISOString() }))).rejects.toThrow(/15 minutes/);
    const sponsored = await tx((t) =>
      social.schedulePost(t, h.deps, h.tenantId, h.users.operator, { connectionId: metaConn, platform: 'facebook', caption: 'Thanks to our partner Rivet', scheduledAt: new Date(Date.parse(at) + 3_600_000).toISOString(), disclosure: { isAiGenerated: false, paidPartnership: true, disclosureText: '#ad' } }),
    );
    expect(sponsored.caption).toMatch(/#ad$/);
  });

  it('publishes a due post through M23 and marks it published_verified only after readback', async () => {
    h.clock.advance(90 * 60_000);
    let message = '';
    server.on('POST', '/v26.0/123/feed', (req) => {
      message = req.form!.get('message')!;
      return { json: { id: '123_42' } };
    });
    server.on('GET', /^\/v26\.0\/123_42$/, () => ({ json: { id: '123_42', message, is_published: true, permalink_url: 'https://fb.example/123_42' } }));
    const dispatched = await social.dispatchDuePosts(h.deps, h.tenantId);
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.status).toBe('APPROVAL_REQUIRED');
    const [a] = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.id, dispatched[0]!.actionId)));
    expect(a!.proposedById).toBe(h.users.operator.id);
    await expect(decideApproval(h.deps, h.tenantId, h.users.operator, a!.id, { decision: 'approved', expectedActionHash: a!.actionHash })).rejects.toThrow();
    const ok = await decideApproval(h.deps, h.tenantId, h.users.approver, a!.id, { decision: 'approved', expectedActionHash: a!.actionHash });
    expect(ok.status).toBe('APPROVED');
    expect(await executeAction(h.deps, h.tenantId, a!.id)).toMatchObject({ status: 'EXECUTED_UNVERIFIED' });
    let [post] = await tx((t) => t.select().from(socialPosts).where(eq(socialPosts.id, dispatched[0]!.postId)));
    expect(post!.status).toBe('submitted');
    expect(await verifyAction(h.deps, h.tenantId, a!.id)).toMatchObject({ status: 'VERIFIED' });
    [post] = await tx((t) => t.select().from(socialPosts).where(eq(socialPosts.id, dispatched[0]!.postId)));
    expect(post).toMatchObject({ status: 'published_verified', externalPostId: '123_42', externalUrl: 'https://fb.example/123_42' });
    // A second scheduler pass does not re-dispatch.
    expect((await social.dispatchDuePosts(h.deps, h.tenantId)).map((d) => d.postId)).not.toContain(post!.id);
  });

  it('ingests page comments once, hashes authors, escalates abuse, and drafts grounded replies', async () => {
    const payload = (id: string, message: string, from = 'fan-7') => ({ object: 'page', entry: [{ id: '123', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: id, post_id: '123_42', message, from: { id: from }, created_time: 1_790_000_000 } }] }] });
    const deliver = async (p: unknown) => {
      const raw = JSON.stringify(p);
      const r = await ingestWebhook(h.t.handle.db, { provider: 'meta', providerEventId: null, topic: 'page', signatureValid: true, headers: {}, rawBody: raw, payload: p, accountRef: '123' });
      return r.duplicate ? 'duplicate' : processWebhook(h.deps, r.id);
    };
    expect(await deliver(payload('c1', 'Does it import CSV files?'))).toBe('processed');
    expect(await deliver(payload('c1', 'Does it import CSV files?'))).toBe('duplicate');
    expect(await deliver(payload('c2', 'This is a scam, I will call my lawyer'))).toBe('processed');
    expect(await deliver(payload('c9', 'Thanks for asking!', '123'))).toBe('ignored'); // the Page's own reply
    const rows = await tx((t) => t.select().from(socialInteractions));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.authorHash.length === 64 && !r.authorHash.includes('fan-7'))).toBe(true);
    const abusive = rows.find((r) => r.externalId === 'c2')!;
    expect(abusive.moderation).toMatchObject({ needsEscalation: true });

    const esc = await social.draftReply(h.deps, h.tenantId, h.users.operator, abusive.id);
    expect(esc).toMatchObject({ status: 'completed', result: { draft: null, escalate: true } });
    expect(provider.requests).toHaveLength(0); // escalations never reach the model

    provider.responders.set(PROMPTS.socialReply.system, () => ({ recommendPublicReply: true, escalate: false, reason: 'product question', reply: 'Yes. You can import a CSV from Settings, then Import.', citedChunkIds: [] }));
    const q = rows.find((r) => r.externalId === 'c1')!;
    const drafted = await social.draftReply(h.deps, h.tenantId, h.users.operator, q.id);
    expect(drafted).toMatchObject({ status: 'completed', result: { escalate: false } });
    expect(provider.requests[0]!.messages[0]!.content).toContain('<untrusted_data source="social_comment"');
    const view = await social.proposeReply(h.deps, h.tenantId, h.users.operator, q.id, { geographies: ['US'] });
    expect(view.actionType).toBe('social.facebook.reply_comment');
    const [after] = await tx((t) => t.select().from(socialInteractions).where(eq(socialInteractions.id, q.id)));
    expect(after).toMatchObject({ replyStatus: 'submitted', replyActionId: view.id });
  });
});

/* ------------------------------------------------------------------ */

describe('M17 paid media', () => {
  let budget = 50_000_000;
  const spendRows: { id: string; date: string; cost: number }[] = [];
  function mount() {
    server.on('POST', '/oauth/token', { json: { access_token: 'AT', expires_in: 3600 } });
    server.on('POST', '/v26/customers/1234567890/googleAds:search', (req) => {
      const q = (req.json as { query: string }).query;
      if (q.includes('FROM customer')) return { json: { results: [{ customer: { currencyCode: 'USD' } }] } };
      if (q.includes('segments.date')) {
        return { json: { results: spendRows.map((r) => ({ campaign: { id: r.id }, segments: { date: r.date }, metrics: { costMicros: String(r.cost), impressions: '1000', clicks: '50', conversions: 2, conversionsValue: 120.5 } })) } };
      }
      return { json: { results: [{ campaign: { id: '555', name: 'Brand', status: 'ENABLED', advertisingChannelType: 'SEARCH' }, campaignBudget: { id: '77', amountMicros: String(budget) } }] } };
    });
  }

  it('syncs campaigns, records budget history and flags budget changes made outside FUTUREGROW', async () => {
    mount();
    const first = await paid.syncCampaigns(h.deps, h.tenantId, googleConn);
    expect(first).toMatchObject({ campaigns: 1, externalBudgetChanges: 0 });
    budget = 70_000_000;
    const second = await paid.syncCampaigns(h.deps, h.tenantId, googleConn);
    expect(second.externalBudgetChanges).toBe(1);
    const [c] = await tx((t) => t.select().from(adCampaigns));
    const hist = await tx((t) => t.select().from(adBudgetHistory).where(eq(adBudgetHistory.campaignId, c!.id)));
    expect(hist.map((x) => [x.source, x.dailyBudgetMicros])).toEqual([
      ['sync', 50_000_000],
      ['external_change', 70_000_000],
    ]);
    const drift = await tx((t) => t.select().from(alerts).where(eq(alerts.kind, 'ads.budget.external_change')));
    expect(drift).toHaveLength(1);
    // History is append-only.
    await expect(tx((t) => t.update(adBudgetHistory).set({ dailyBudgetMicros: 1 }).where(eq(adBudgetHistory.id, hist[0]!.id)))).rejects.toThrow();
  });

  it('ledgers only settled days and alerts when the provider restates a settled day', async () => {
    mount();
    // clock: 2026-10-19T16:30Z. Settled through 2026-10-16.
    spendRows.splice(0, spendRows.length, { id: '555', date: '2026-10-15', cost: 60_000_000 }, { id: '555', date: '2026-10-16', cost: 65_000_000 }, { id: '555', date: '2026-10-18', cost: 40_000_000 });
    const r1 = await paid.syncSpend(h.deps, h.tenantId, googleConn, { from: '2026-10-15', to: '2026-10-18' });
    expect(r1).toMatchObject({ rows: 3, ledgered: 2, restated: 0 });
    const ledger = await tx((t) => t.select().from(spendLedger));
    expect(ledger.map((l) => l.spendDate).sort()).toEqual(['2026-10-15', '2026-10-16']);
    expect(await tx((t) => t.select().from(adDailyMetrics))).toHaveLength(3);
    spendRows[0]!.cost = 61_000_000; // late invalid-click adjustment on a settled day
    const r2 = await paid.syncSpend(h.deps, h.tenantId, googleConn, { from: '2026-10-15', to: '2026-10-18' });
    expect(r2).toMatchObject({ ledgered: 0, restated: 1 });
    expect((await tx((t) => t.select().from(spendLedger))).find((l) => l.spendDate === '2026-10-15')!.amountMicros).toBe(60_000_000);
  });

  it('reconciles reported spend against the authorized envelope', () => {
    const b = new Map([['c1', [{ effectiveFrom: new Date('2026-10-01T00:00:00Z'), dailyBudgetMicros: 10_000_000, currency: 'USD' }]]]);
    const ok = paid.reconcile(
      [
        { campaignRef: 'c1', date: '2026-10-02', currency: 'USD', amountMicros: 9_000_000 },
        { campaignRef: 'c1', date: '2026-10-03', currency: 'USD', amountMicros: 10_500_000 },
      ],
      b,
      0.02,
    );
    expect(ok.status).toBe('ok');
    const spike = paid.reconcile([{ campaignRef: 'c1', date: '2026-10-02', currency: 'USD', amountMicros: 21_000_000 }], b, 0.02);
    expect(spike.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['DAILY_OVERDELIVERY', 'PERIOD_OVERSPEND']));
    expect(spike.status).toBe('discrepancy');
    const unknown = paid.reconcile([{ campaignRef: 'zz', date: '2026-10-02', currency: 'USD', amountMicros: 1 }], b, 0.02);
    expect(unknown.status).toBe('insufficient_data');
    expect(paid.reconcile([], b, 0.02).status).toBe('insufficient_data');
    const fx = paid.reconcile([{ campaignRef: 'c1', date: '2026-10-02', currency: 'EUR', amountMicros: 1 }], b, 0.02);
    expect(fx.status).toBe('discrepancy');
    // Budget set after the day ended does not authorize that day.
    const late = new Map([['c1', [{ effectiveFrom: new Date('2026-10-05T00:00:00Z'), dailyBudgetMicros: 10_000_000, currency: 'USD' }]]]);
    expect(paid.reconcile([{ campaignRef: 'c1', date: '2026-10-02', currency: 'USD', amountMicros: 5 }], late, 0).status).toBe('insufficient_data');
  });

  it('persists reconciliations, alerts on discrepancy and proposes budget changes through M23', async () => {
    // Budget history starts today, so the settled days in the ledger have no known envelope.
    const r = await paid.reconcileSpend(h.deps, h.tenantId, googleConn, { start: '2026-10-15', end: '2026-10-16' });
    expect(r.status).toBe('insufficient_data');
    const [c] = await tx((t) => t.select().from(adCampaigns));
    await expect(paid.proposeBudgetChange(h.deps, h.tenantId, h.users.operator, c!.id, { newDailyBudgetMicros: 80_000_000, rationale: 'short' })).rejects.toThrow();
    const view = await paid.proposeBudgetChange(h.deps, h.tenantId, h.users.operator, c!.id, { newDailyBudgetMicros: 80_000_000, geographies: ['US'], rationale: 'Brand search is impression-share limited' });
    expect(view.actionType).toBe('ads.google.update_campaign_budget');
    expect(view.params).toMatchObject({ customerId: '1234567890', campaignBudgetId: '77', newDailyBudget: { amountMicros: 80_000_000, currency: 'USD' }, previousDailyBudget: { amountMicros: 70_000_000 } });
    expect(view.risk).toMatchObject({ spendDeltaMicros: 10_000_000, currency: 'USD' });
    expect(view.status).toBe('APPROVAL_REQUIRED'); // SPEND category unconfigured => human approval
  });
});

/* ------------------------------------------------------------------ */

describe('M18 SEO, ASO and AI discovery', () => {
  it('audits a site under robots.txt and reports technical issues without ranking promises', async () => {
    const html = (title: string | null, body: string, extra = '') => `<!doctype html><html lang="en"><head>${title ? `<title>${title}</title>` : ''}<meta name="description" content="Acme helps teams sync data.">${extra}</head><body>${body}</body></html>`;
    server.on('GET', '/robots.txt', { headers: { 'content-type': 'text/plain' }, text: `User-agent: *\nDisallow: /private\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${server.baseUrl}/sitemap.xml` });
    server.on('GET', '/sitemap.xml', { headers: { 'content-type': 'application/xml' }, text: `<urlset><url><loc>${server.baseUrl}/pricing</loc></url></urlset>` });
    server.on('GET', '/llms.txt', { status: 404, text: 'nope' });
    server.on('GET', '/', { headers: { 'content-type': 'text/html' }, text: html('Acme — data sync', '<h1>Acme</h1><a href="/pricing">Pricing</a><a href="/missing">Old</a><a href="/private/x">x</a><img src="a.png">', '<link rel="canonical" href="/">') });
    server.on('GET', '/pricing', { headers: { 'content-type': 'text/html' }, text: html('Acme — data sync', '<p>Plans</p><script type="application/ld+json">{bad json</script>') });
    server.on('GET', '/missing', { status: 404, headers: { 'content-type': 'text/html' }, text: 'not found' });

    const a = await tx((t) => disc.requestSeoAudit(t, h.deps, h.tenantId, h.users.analyst, { siteUrl: server.baseUrl, maxPages: 10 }));
    expect(h.jobs.take('seo_audit').some((j) => j.payload.auditId === a.id)).toBe(true);
    const res = await disc.runSeoAudit(h.deps, h.tenantId, a.id);
    expect(res.status).toBe('completed');
    if (res.status !== 'completed') return;
    const s = res.audit.summary as Record<string, any>;
    expect(s.pagesCrawled).toBe(3);
    expect(s.disallowedByRobots).toBe(1);
    expect(server.find('GET', '/private/x')).toHaveLength(0);
    expect(s.issueCounts).toMatchObject({ HTTP_ERROR: 1, H1_MISSING: 1, STRUCTURED_DATA_INVALID: 1, IMG_ALT_MISSING: 1 });
    expect(s.duplicateTitles[0].urls).toHaveLength(2);
    expect(s.brokenInternalLinks).toEqual([{ from: `${server.baseUrl}/`, to: `${server.baseUrl}/missing` }]);
    expect(s.aiDiscovery.crawlerAccess).toMatchObject({ GPTBot: false, ClaudeBot: true });
    expect(s.aiDiscovery.llmsTxt).toBe(false);
    expect(s.note).toMatch(/rankings are not promised/);
    expect(await tx((t) => t.select().from(seoPages).where(eq(seoPages.auditId, a.id)))).toHaveLength(3);
    expect(await disc.runSeoAudit(h.deps, h.tenantId, a.id)).toEqual({ status: 'skipped' });
  });

  it('refuses to crawl when robots.txt errors (RFC 9309 complete disallow)', async () => {
    server.on('GET', '/robots.txt', { status: 503, text: 'down' });
    const a = await tx((t) => disc.requestSeoAudit(t, h.deps, h.tenantId, h.users.analyst, { siteUrl: server.baseUrl }));
    const res = await disc.runSeoAudit(h.deps, h.tenantId, a.id);
    expect(res).toMatchObject({ status: 'failed' });
    expect(server.find('GET', '/')).toHaveLength(0);
  });

  it('validates store metadata against store limits and policy', () => {
    const asc = disc.validateListingFields('app_store', { name: 'Acme Sync', subtitle: 'Data in one place', keywords: 'sync, csv,crm,crm,acme', promotionalText: 'x'.repeat(171) });
    expect(asc.map((c) => c.code)).toEqual(expect.arrayContaining(['TOO_LONG', 'DUPLICATE_KEYWORDS', 'REPEATS_NAME', 'SPACES_AFTER_COMMAS']));
    const bytes = disc.validateListingFields('app_store', { keywords: 'é'.repeat(51) }); // 102 bytes, 51 chars
    expect(bytes.find((c) => c.code === 'TOO_LONG')?.detail).toMatch(/bytes/);
    const play = disc.validateListingFields('google_play', { title: 'Best Free Sync 🚀', shortDescription: 'Sync your data' });
    expect(play.map((c) => c.code)).toEqual(expect.arrayContaining(['PLAY_PROMOTIONAL_TITLE', 'PLAY_EMOJI_TITLE']));
    expect(disc.validateListingFields('google_play', { subtitle: 'x' })[0]!.code).toBe('UNKNOWN_FIELD');
  });

  it('drafts, approves (four eyes) and proposes an App Store localization update with a read baseline', async () => {
    const bad = await tx((t) => disc.createListingDraft(t, h.deps, h.tenantId, h.users.operator, { store: 'app_store', appRef: 'app-1', locale: 'en-US', fields: { keywords: 'x'.repeat(101) } }));
    expect(bad.status).toBe('invalid');
    const l = await tx((t) => disc.createListingDraft(t, h.deps, h.tenantId, h.users.operator, { store: 'app_store', appRef: 'app-1', locale: 'en-US', fields: { keywords: 'sync,csv,crm', promotionalText: 'Import contacts in one step.' } }));
    expect(l.status).toBe('draft');
    await expect(tx((t) => disc.approveListing(t, h.tenantId, { ...h.users.operator, roles: ['admin'] }, l.id))).rejects.toThrow(/author/);
    await tx((t) => disc.approveListing(t, h.tenantId, h.users.approver, l.id));
    server.on('GET', '/v1/appStoreVersionLocalizations/loc-1', (req) => {
      expect(req.headers.authorization).toMatch(/^Bearer ey/);
      return { json: { data: { attributes: { locale: 'en-US', keywords: 'old,words', promotionalText: null } } } };
    });
    const view = await disc.proposeAppStoreUpdate(h.deps, h.tenantId, h.users.operator, l.id, { connectionId: ascConn, localizationId: 'loc-1', geographies: ['US'] });
    expect(view.params).toMatchObject({ fields: { keywords: 'sync,csv,crm', promotionalText: 'Import contacts in one step.' }, previousFields: { keywords: 'old,words', promotionalText: null } });
    const [after] = await tx((t) => t.select().from(storeListings).where(eq(storeListings.id, l.id)));
    expect(after!.status).toBe('submitted');
  });
});

/* ------------------------------------------------------------------ */

describe('M19 app growth & attribution', () => {
  it('keeps only campaign parameters from the install referrer', () => {
    expect(app.parseInstallReferrer('utm_source=google&utm_medium=cpc&utm_campaign=fall&gclid=abc&adid=xyz')).toEqual({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'fall' });
  });

  it('records installs with an explicit attribution method and respects analytics consent', async () => {
    const t0 = h.clock.now().toISOString();
    const a = await app.recordInstall(h.deps, h.tenantId, 'test', { platform: 'android', installId: 'inst-0001', userId: 'u-1', installedAt: t0, installReferrer: 'utm_source=newsletter&utm_campaign=oct&gclid=zzz', consent: { analytics: true }, context: { country: 'US' } });
    expect(a).toEqual({ recorded: true, attributionMethod: 'play_install_referrer', profileLinked: true });
    const b = await app.recordInstall(h.deps, h.tenantId, 'test', { platform: 'android', installId: 'inst-0002', installedAt: t0, installReferrer: 'utm_source=newsletter', consent: { analytics: false } });
    expect(b).toEqual({ recorded: true, attributionMethod: 'unattributed', profileLinked: false });
    const c = await app.recordInstall(h.deps, h.tenantId, 'test', { platform: 'ios', installId: 'inst-0003', installedAt: t0, selfReportedSource: 'podcast', consent: { analytics: true } });
    expect(c.attributionMethod).toBe('self_reported');
    expect((await app.recordInstall(h.deps, h.tenantId, 'test', { platform: 'android', installId: 'inst-0001', installedAt: t0, consent: { analytics: true } })).recorded).toBe(false);
    const rows = await tx((t) => t.select().from(appInstalls));
    expect(rows.find((r) => r.attributionMethod === 'unattributed')!.referrer).toEqual({});
    expect(rows.every((r) => !r.installId.startsWith('inst-'))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('gclid');
    const evs = await tx((t) => t.select().from(customerEvents).where(eq(customerEvents.eventName, 'app_installed')));
    expect(evs).toHaveLength(2); // the non-consented install created no event
  });

  it('builds cohorts labelled as attribution, not causal effect', async () => {
    const base = h.clock.now();
    const at = (days: number) => new Date(base.getTime() + days * 86_400_000).toISOString();
    await ingestEvents(h.deps, h.tenantId, 'test', [
      { messageId: `m-${randomUUID()}`, event: 'project_created', timestamp: at(2), userId: 'u-1' },
      { messageId: `m-${randomUUID()}`, event: 'session', timestamp: at(9), userId: 'u-1' },
    ]);
    const r = await tx((t) => app.acquisitionCohorts(t, { from: new Date(base.getTime() - 86_400_000), to: new Date(base.getTime() + 86_400_000), activationEvent: 'project_created' }));
    const play = r.cohorts.find((c) => c.attribution_method === 'play_install_referrer')!;
    expect(play).toMatchObject({ installs: 1, linked: 1, activated_7d: 1, retained_w1: 1, source_ref: 'newsletter' });
    expect(r.note).toMatch(/not causal/);
  });

  it('summarises App Store sales reports into first-time downloads', () => {
    const header = ['Provider', 'SKU', 'Units', 'Product Type Identifier', 'Country Code'];
    const s = app.summarizeSalesReport(header, [
      ['APPLE', 'acme', '10', '1', 'US'],
      ['APPLE', 'acme', '4', '3', 'US'], // re-download: excluded
      ['APPLE', 'acme', '6', '1F', 'CA'],
      ['APPLE', 'acme', '9', '7', 'US'], // update: excluded
    ]);
    expect(s).toMatchObject({ firstTimeDownloads: 16, byCountry: { US: 10, CA: 6 } });
  });
});
