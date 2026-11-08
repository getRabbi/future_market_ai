import { randomUUID } from 'node:crypto';
import { JURISDICTION_DOMAIN_KEYS } from '@futuregrow/contracts';
import { actionRequests, platformCapabilities, socialPosts, withSystem, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approveJurisdictionPacks, type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { makePng } from '../../../test/helpers/png.js';
import { bindChannel, createBrand } from '../src/modules/brands/index.js';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import * as assetsM from '../src/modules/m14-assets/index.js';
import { socialAnalyticsReport, syncSocialAnalytics } from '../src/modules/m16-social/analytics.js';
import * as C from '../src/modules/m17-paid/create.js';
import { decideApproval, executeAction, verifyAction } from '../src/modules/m23-execution/gateway.js';
import { setTenantPolicy } from '../src/modules/m24-governance/index.js';

const server = new FixtureServer();
let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

async function evidenceId() {
  const e = await tx((t) =>
    admitEvidence(
      t,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'internal',
        sourceOwner: 'acme',
        sourceUriOrObjectId: `doc://${randomUUID()}`,
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'first-party',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: 1,
        freshnessSlaHours: 24 * 90,
        permittedUses: ['analytics', 'creative_generation', 'publishing', 'autonomous_execution'],
        kind: 'document',
        summary: 'Spring campaign plan',
        content: { n: randomUUID() },
      } as never,
      { now: h.clock.now() },
    ),
  );
  return e.evidenceId;
}

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
}, 180_000);
afterAll(async () => {
  await h?.close();
  await server.stop();
});
beforeEach(() => server.reset());

describe('multi-platform analytics (P3-05)', () => {
  let tiktok: string;
  let youtube: string;
  it('imports TikTok and YouTube metrics per post and reports them per platform, never summed across platforms', async () => {
    tiktok = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'tiktok', externalAccountId: 'oid-1', displayName: 'Acme TikTok', credentials: { accessToken: 'act.1' } })).id;
    youtube = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'youtube', externalAccountId: 'UCacme', displayName: 'Acme YouTube', credentials: { clientId: 'c', clientSecret: 's', refreshToken: 'r-yt' } })).id;
    const verifiedAt = new Date(h.clock.now().getTime() - 3 * 86_400_000);
    await tx((t) =>
      t.insert(socialPosts).values([
        { tenantId: h.tenantId, connectionId: tiktok, platform: 'tiktok', caption: 'Brewing in 30s', scheduledAt: verifiedAt, status: 'published_verified', externalPostId: 'v1', verifiedAt, disclosure: {}, createdBy: 'test' },
        { tenantId: h.tenantId, connectionId: tiktok, platform: 'tiktok', caption: 'Grind sizes', scheduledAt: verifiedAt, status: 'published_verified', externalPostId: 'v2', verifiedAt, disclosure: {}, createdBy: 'test' },
        { tenantId: h.tenantId, connectionId: youtube, platform: 'youtube', caption: 'Pour-over guide', scheduledAt: verifiedAt, status: 'published_verified', externalPostId: 'yt1', verifiedAt, disclosure: {}, createdBy: 'test' },
      ]),
    );
    server.on('GET', '/v2/user/info/', { json: { data: { user: { open_id: 'oid-1', follower_count: 120, following_count: 2, likes_count: 300, video_count: 2 } }, error: { code: 'ok' } } });
    server.on('POST', '/v2/video/query/', {
      json: {
        data: {
          videos: [
            { id: 'v1', view_count: 900, like_count: 40, comment_count: 3, share_count: 2 },
            { id: 'v2', view_count: 300, like_count: 10, comment_count: 1 },
          ],
        },
        error: { code: 'ok' },
      },
    });
    const t1 = await syncSocialAnalytics(h.deps, h.tenantId, tiktok, { actor: h.users.analyst });
    expect(t1).toMatchObject({ platform: 'tiktok', status: 'partial', posts: 2, notReturned: 1 });

    server.on('POST', '/oauth/token', { json: { access_token: 'ya29.yt', expires_in: 3600 } });
    server.on('GET', '/youtube/v3/channels', { json: { items: [{ id: 'UCacme', statistics: { viewCount: '5000', subscriberCount: '75', videoCount: '1' } }] } });
    server.on('GET', '/youtube/v3/videos', { json: { items: [{ id: 'yt1', statistics: { viewCount: '1500', likeCount: '60', commentCount: '5' } }] } });
    server.on('GET', '/youtubeanalytics/v2/reports', { status: 403, json: { error: { message: 'insufficient scope' } } });
    expect(await syncSocialAnalytics(h.deps, h.tenantId, youtube)).toMatchObject({ platform: 'youtube', status: 'partial', notes: [expect.stringMatching(/yt-analytics/)] });

    const report = await tx((t) => socialAnalyticsReport(t, h.clock.now()));
    expect(report.map((r) => r.platform).sort()).toEqual(['tiktok', 'youtube']);
    const tt = report.find((r) => r.platform === 'tiktok')!;
    expect(tt.totals.view_count).toEqual({ value: 1200, posts: 2, of: 2, complete: true });
    // v2 did not report shares: the total is partial and only covers the post that did, never 0 for the other.
    expect(tt.totals.share_count).toEqual({ value: 2, posts: 1, of: 2, complete: false });
    expect(tt.posts.find((p) => p.ref === 'v2')!.metrics.share_count).toMatchObject({ value: null, status: 'not_returned' });
    expect(tt.account[0]!.metrics.follower_count!.value).toBe(120);
    expect(tt.definitions.view_count!.definition).toMatch(/TikTok/);
    const yt = report.find((r) => r.platform === 'youtube')!;
    expect(yt.totals.viewCount).toEqual({ value: 1500, posts: 1, of: 1, complete: true });
    expect(yt.totals.estimatedMinutesWatched).toMatchObject({ value: null, complete: false });
    expect(yt.freshness).toMatchObject({ lastStatus: 'partial', stale: false });
    // No report row adds TikTok views to YouTube views.
    expect(JSON.stringify(report)).not.toContain('"2700"');
    expect(report.every((r) => !('allPlatforms' in r))).toBe(true);
  });

  it('a same-day re-read revises a changed value; a revoked token records a failed run, not zeros', async () => {
    server.on('GET', '/v2/user/info/', { json: { data: { user: { open_id: 'oid-1', follower_count: 125 } }, error: { code: 'ok' } } });
    server.on('POST', '/v2/video/query/', {
      json: {
        data: {
          videos: [
            { id: 'v1', view_count: 950 },
            { id: 'v2', view_count: 300 },
          ],
        },
        error: { code: 'ok' },
      },
    });
    await syncSocialAnalytics(h.deps, h.tenantId, tiktok);
    const tt = (await tx((t) => socialAnalyticsReport(t, h.clock.now()))).find((r) => r.platform === 'tiktok')!;
    expect(tt.posts.find((p) => p.ref === 'v1')!.metrics.view_count).toMatchObject({ value: 950, revision: 2 });
    expect(tt.posts.find((p) => p.ref === 'v2')!.metrics.view_count).toMatchObject({ value: 300, revision: 1 });
    server.on('GET', '/v2/user/info/', { json: { error: { code: 'access_token_invalid', message: 'revoked' } } });
    server.on('POST', '/v2/video/query/', { json: { error: { code: 'access_token_invalid', message: 'revoked' } } });
    const failed = await syncSocialAnalytics(h.deps, h.tenantId, tiktok);
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/access_token_invalid/) });
    const after = (await tx((t) => socialAnalyticsReport(t, h.clock.now()))).find((r) => r.platform === 'tiktok')!;
    expect(after.freshness).toMatchObject({ lastStatus: 'failed', lastError: expect.stringMatching(/revoked/) });
    expect(after.posts.find((p) => p.ref === 'v1')!.metrics.view_count!.value).toBe(950);
  });
});

describe('paid campaign creation (P3-06)', () => {
  let meta: string;
  let brandId: string;
  let image: { id: string; sha256: string };
  let ev: string;
  const spec = () => ({
    objective: 'OUTCOME_TRAFFIC',
    dailyBudget: { amountMicros: 5_000_000, currency: 'USD' },
    startTime: '2026-11-10T00:00:00Z',
    endTime: '2026-11-17T00:00:00Z',
    targeting: { countries: ['US'], ageMin: 21, ageMax: 55, publisherPlatforms: null },
    optimizationGoal: 'LINK_CLICKS',
    billingEvent: 'IMPRESSIONS',
    creative: { pageId: '501', message: 'Try this season’s roast.', link: 'https://acme.example/shop', headline: 'This week’s roast', callToAction: 'SHOP_NOW', image: { assetId: image.id, sha256: image.sha256 } },
    urlTags: 'utm_source=meta&utm_medium=paid&utm_campaign=acme_spring',
    lifetimeCap: { amountMicros: 35_000_000, currency: 'USD' },
  });

  it('prepares a draft with stated problems, then a clean one', async () => {
    await approveJurisdictionPacks(h.t.handle.db, h.tenantId, h.users.owner, 'US', JURISDICTION_DOMAIN_KEYS);
    await tx((t) =>
      setTenantPolicy(t, h.tenantId, h.users.owner, {
        configured: true,
        currency: 'USD',
        approvedJurisdictions: ['US'],
        categories: { SPEND: { autonomy: 'pre_authorized_within_limits', approverRoles: ['finance_approver'], requiresDistinctApprover: true, maxAudienceSize: null, maxSpendDeltaMicrosPerAction: 100_000_000, maxSpendDeltaMicrosPerDay: 100_000_000 } },
      }),
    );
    meta = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: '501', displayName: 'Acme Page + ads', grantedScopes: ['ads_management', 'ads_read', 'pages_manage_posts'], metadata: { adAccountId: 'act_626' }, credentials: { accessToken: 'PAGE', adsAccessToken: 'ADS' } }))
      .id;
    const brand = await tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'acme', name: 'Acme Coffee', profile: { destinations: [{ kind: 'website', url: 'https://acme.example/shop' }], limits: { monthlyAdBudgetUsd: 20 } } }));
    brandId = brand.id;
    await tx((t) => bindChannel(t, h.tenantId, h.users.owner, brandId, meta));
    ev = await evidenceId();
    const up = await tx((t) => assetsM.uploadAsset(t, h.deps, h.tenantId, h.users.operator, { kind: 'image', title: 'roast photo' }, makePng(1200, 628)));
    await tx((t) => assetsM.addRights(t, h.deps, h.tenantId, h.users.operator, up.id, [{ component: 'source_media', rightsHolder: 'Acme', licenseRef: 'own photography', commercialUse: 'allowed', evidenceId: ev }]));
    image = { id: up.id, sha256: up.sha256 };

    const bad = await tx((t) =>
      C.saveCampaignDraft(t, h.deps, h.tenantId, h.users.operator, {
        platform: 'meta',
        connectionId: meta,
        brandId,
        name: 'Spring roast',
        geographies: ['US'],
        evidenceIds: [ev],
        spec: { ...spec(), creative: { ...spec().creative, link: 'https://elsewhere.example/' }, urlTags: 'utm_source=meta', lifetimeCap: { amountMicros: 10_000_000, currency: 'USD' } },
      }),
    );
    const problems = (bad.problems as string[]).join(' | ');
    expect(problems).toMatch(/lifetime cap .* is below daily budget × 7 days/);
    expect(problems).toMatch(/must include utm_campaign/);
    expect(problems).toMatch(/landing page is not one of the brand's destinations/);
    await expect(C.submitCampaignDraft(h.deps, h.tenantId, h.users.operator, bad.id)).rejects.toThrow(/fix the draft first/);
    // The brand's monthly ad budget ($20) caps the campaign's lifetime cap ($35).
    const over = await tx((t) => C.saveCampaignDraft(t, h.deps, h.tenantId, h.users.operator, { platform: 'meta', connectionId: meta, brandId, name: 'Spring roast', geographies: ['US'], evidenceIds: [ev], spec: spec(), expectedVersion: bad.version }, bad.id));
    expect(over.problems).toEqual([expect.stringMatching(/exceeds the brand's monthly ad budget of \$20/)]);
    await tx((t) => t.execute(`update brands set profile = jsonb_set(profile, '{limits,monthlyAdBudgetUsd}', '50') where id = '${brandId}'`));
    const ok = await tx((t) => C.saveCampaignDraft(t, h.deps, h.tenantId, h.users.operator, { platform: 'meta', connectionId: meta, brandId, name: 'Spring roast', geographies: ['US'], evidenceIds: [ev], spec: spec(), expectedVersion: over.version }, over.id));
    expect(ok.problems).toEqual([]);
    expect(ok.spec).toMatchObject({ adAccountId: 'act_626', draftId: ok.id });
  });

  it('is refused while creation is disabled (B-026), even with pre-authorized SPEND limits', async () => {
    const [d] = await tx((t) => C.listCampaignDrafts(t, h.tenantId));
    expect(await tx((t) => C.creationEnabled(t, 'meta'))).toMatchObject({ enabled: false, reason: expect.stringMatching(/B-026/) });
    const r = await C.submitCampaignDraft(h.deps, h.tenantId, h.users.operator, d!.id);
    expect(r.action.status).toBe('DENIED');
    expect(r.draft).toMatchObject({ status: 'failed', statusReason: expect.stringMatching(/refused by policy/) });
    expect(server.requests).toHaveLength(0);
  });

  it('once enabled: needs finance approval with two-factor, creates PAUSED through M23, verifies by read-back', async () => {
    await withSystem(h.t.handle.db, 'system:test', (t) => t.update(platformCapabilities).set({ supported: true }).where(eq(platformCapabilities.capability, 'meta_ads_campaign_create')));
    const [d] = await tx((t) => C.listCampaignDrafts(t, h.tenantId));
    const { action, draft } = await C.submitCampaignDraft(h.deps, h.tenantId, h.users.operator, d!.id);
    // The lifetime cap ($35) is the spend at risk: within the per-action ceiling, but creation still waits for a person.
    expect(action.status).toBe('APPROVAL_REQUIRED');
    expect(draft.status).toBe('submitted');
    const [a] = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.id, action.id)));
    await expect(decideApproval(h.deps, h.tenantId, h.users.operator, a!.id, { decision: 'approved', expectedActionHash: a!.actionHash })).rejects.toThrow();
    await expect(decideApproval(h.deps, h.tenantId, { ...h.users.finance, mfaVerified: false }, a!.id, { decision: 'approved', expectedActionHash: a!.actionHash })).rejects.toThrow(/approving consequential actions requires/);
    await decideApproval(h.deps, h.tenantId, h.users.finance, a!.id, { decision: 'approved', expectedActionHash: a!.actionHash });

    const objects = new Map<string, Record<string, string>>();
    let n = 0;
    server.on('GET', '/v26.0/act_626', { json: { id: 'act_626', currency: 'USD', account_status: 1, amount_spent: '0' } });
    for (const edge of ['campaigns', 'adsets', 'adcreatives', 'ads']) {
      server.on('GET', `/v26.0/act_626/${edge}`, { json: { data: [] } });
      server.on('POST', `/v26.0/act_626/${edge}`, (req) => {
        const id = `${edge}-${++n}`;
        objects.set(id, Object.fromEntries(req.form!.entries()));
        return { json: { id } };
      });
    }
    server.on('POST', '/v26.0/act_626/adimages', { json: { images: { x: { hash: 'h1' } } } });
    server.on('GET', /^\/v26\.0\/campaigns-1$/, () => ({ json: { id: 'campaigns-1', name: objects.get('campaigns-1')!.name, status: 'PAUSED', objective: 'OUTCOME_TRAFFIC' } }));
    server.on('GET', /^\/v26\.0\/adsets-2$/, () => ({ json: { daily_budget: objects.get('adsets-2')!.daily_budget, status: 'PAUSED', end_time: '2026-11-17T00:00:00+0000', campaign_id: 'campaigns-1' } }));
    server.on('GET', /^\/v26\.0\/ads-4$/, { json: { status: 'PAUSED', adset_id: 'adsets-2', creative: { id: 'adcreatives-3' } } });
    expect(await executeAction(h.deps, h.tenantId, a!.id)).toMatchObject({ status: 'EXECUTED_UNVERIFIED' });
    expect(await verifyAction(h.deps, h.tenantId, a!.id)).toMatchObject({ status: 'VERIFIED' });
    expect(objects.get('campaigns-1')).toMatchObject({ status: 'PAUSED' });
    expect(objects.get('ads-4')).toMatchObject({ status: 'PAUSED' });
    const [created] = await tx((t) => C.listCampaignDrafts(t, h.tenantId));
    expect(created).toMatchObject({ status: 'created', externalCampaignId: 'campaigns-1', statusReason: expect.stringMatching(/PAUSED/) });
  });

  it('keeps tenants apart', async () => {
    const other = await createCoreHarness({ tenantSlug: 'paid-other' });
    try {
      expect(await withTenant(other.t.handle.db, { tenantId: other.tenantId, actor: 'user:o' }, (t) => C.listCampaignDrafts(t, other.tenantId))).toEqual([]);
      expect(await withTenant(other.t.handle.db, { tenantId: other.tenantId, actor: 'user:o' }, (t) => socialAnalyticsReport(t, other.clock.now()))).toEqual([]);
    } finally {
      await other.close();
    }
  });
});
