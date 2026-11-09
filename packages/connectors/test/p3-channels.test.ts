import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPABILITY_SEEDS, clearGoogleTokenCache, createCampaignOperations, EXECUTORS, fetchInstagramAnalytics, fetchLinkedinAnalytics, fetchTiktokAnalytics, fetchYoutubeAnalytics, googleFgName } from '../src/index.js';
import { FixtureServer, makeCtx, meta } from './helpers.js';

const server = new FixtureServer();
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
  server.reset();
  clearGoogleTokenCache();
});

const exec = (t: string) =>
  EXECUTORS[t] as unknown as {
    execute: (c: unknown, p: unknown, m: unknown) => Promise<any>;
    verify: (c: unknown, p: unknown, r: unknown) => Promise<any>;
    rollback: (c: unknown, p: unknown, r: unknown, b: unknown) => Promise<any>;
    verifyRollback: (c: unknown, p: unknown, r: unknown, b: unknown) => Promise<any>;
  };
const metric = (rs: { key: string; value: number | null; status: string }[], key: string) => rs.find((m) => m.key === key);

describe('P3-05 analytics fetchers: provider names, missing = not_returned (never zero)', () => {
  it('Instagram: account fields and per-media insights; a media that errors is recorded as not returned', async () => {
    server.on('GET', '/v26.0/1784', { json: { id: '1784', username: 'acme', followers_count: 1520, media_count: 33 } });
    server.on('GET', '/v26.0/m1/insights', {
      json: {
        data: [
          { name: 'reach', values: [{ value: 410 }] },
          { name: 'views', total_value: { value: 900 } },
          { name: 'likes', values: [{ value: 37 }] },
        ],
      },
    });
    server.on('GET', '/v26.0/m2/insights', { status: 400, json: { error: { code: 100, message: 'media posted before business conversion' } } });
    const ctx = makeCtx(server, { provider: 'meta', accessToken: 'PAGE' }, { metadata: { igUserId: '1784' } });
    const r = await fetchInstagramAnalytics(ctx, ['m1', 'm2']);
    expect(metric(r.account!.metrics, 'followers_count')).toEqual({ key: 'followers_count', value: 1520, status: 'reported' });
    expect(metric(r.posts[0]!.metrics, 'views')).toMatchObject({ value: 900, status: 'reported' });
    expect(metric(r.posts[0]!.metrics, 'shares')).toMatchObject({ value: null, status: 'not_returned' });
    expect(r.posts[1]!.metrics.every((m) => m.status === 'not_returned')).toBe(true);
    expect(r.notes[0]).toMatch(/m2/);
    expect(server.find('GET', '/v26.0/m1/insights')[0]!.query.get('metric')).toBe('reach,views,likes,comments,shares,saved,total_interactions');
    await expect(fetchInstagramAnalytics(makeCtx(server, { provider: 'meta', accessToken: 'PAGE' }), [])).rejects.toThrow(/igUserId/);
  });

  it('TikTok: user stats and batched video query; a video TikTok omits is not returned', async () => {
    server.on('GET', '/v2/user/info/', { json: { data: { user: { open_id: 'oid', follower_count: 210, following_count: 3, likes_count: 1900, video_count: 12 } }, error: { code: 'ok' } } });
    server.on('POST', '/v2/video/query/', (req) => ({ json: { data: { videos: (req.json as { filters: { video_ids: string[] } }).filters.video_ids.filter((id) => id !== 'gone').map((id) => ({ id, view_count: 1000, like_count: 50, comment_count: 4 })) }, error: { code: 'ok' } } }));
    const r = await fetchTiktokAnalytics(makeCtx(server, { provider: 'tiktok', accessToken: 'act.1' }), ['v1', 'gone']);
    expect(metric(r.account!.metrics, 'follower_count')!.value).toBe(210);
    expect(metric(r.posts[0]!.metrics, 'view_count')!.value).toBe(1000);
    expect(metric(r.posts[0]!.metrics, 'share_count')!.status).toBe('not_returned');
    expect(r.posts[1]!.metrics.every((m) => m.value === null)).toBe(true);
    expect(server.find('POST', '/v2/video/query/')[0]!.query.get('fields')).toBe('id,view_count,like_count,comment_count,share_count');
  });

  it('YouTube: hidden subscribers stay unknown; watch time without the analytics scope is not returned', async () => {
    server.on('POST', '/oauth/token', { json: { access_token: 'ya29.yt', expires_in: 3600 } });
    server.on('GET', '/youtube/v3/channels', { json: { items: [{ id: 'UC1', statistics: { viewCount: '50000', subscriberCount: '0', hiddenSubscriberCount: true, videoCount: '40' } }] } });
    server.on('GET', '/youtube/v3/videos', { json: { items: [{ id: 'yt1', statistics: { viewCount: '1200', likeCount: '80', commentCount: '9' } }] } });
    server.on('GET', '/youtubeanalytics/v2/reports', { status: 403, json: { error: { message: 'insufficient scope' } } });
    const r = await fetchYoutubeAnalytics(makeCtx(server, { provider: 'youtube', clientId: 'c', clientSecret: 's', refreshToken: 'r-yt' }, { externalAccountId: 'UC1' }), ['yt1'], { startDate: '2026-08-10', endDate: '2026-11-08' });
    expect(metric(r.account!.metrics, 'subscriberCount')).toMatchObject({ value: null, status: 'not_returned' });
    expect(metric(r.account!.metrics, 'viewCount')!.value).toBe(50000);
    expect(metric(r.posts[0]!.metrics, 'viewCount')!.value).toBe(1200);
    expect(metric(r.posts[0]!.metrics, 'estimatedMinutesWatched')!.status).toBe('not_returned');
    expect(r.notes.join(' ')).toMatch(/hides its subscriber count.*yt-analytics\.readonly/);
  });

  it('YouTube: watch time from the Analytics API when the scope is granted', async () => {
    server.on('POST', '/oauth/token', { json: { access_token: 'ya29.yt2', expires_in: 3600 } });
    server.on('GET', '/youtube/v3/channels', { json: { items: [{ id: 'UC1', statistics: { viewCount: '1', subscriberCount: '7', videoCount: '1' } }] } });
    server.on('GET', '/youtube/v3/videos', { json: { items: [{ id: 'yt1', statistics: { viewCount: '10' } }] } });
    server.on('GET', '/youtubeanalytics/v2/reports', { json: { columnHeaders: [{ name: 'video' }, { name: 'estimatedMinutesWatched' }, { name: 'averageViewDuration' }], rows: [['yt1', 42, 31]] } });
    const r = await fetchYoutubeAnalytics(makeCtx(server, { provider: 'youtube', clientId: 'c', clientSecret: 's', refreshToken: 'r-yt2' }, { externalAccountId: 'UC1' }), ['yt1'], { startDate: '2026-08-10', endDate: '2026-11-08' });
    expect(metric(r.posts[0]!.metrics, 'estimatedMinutesWatched')!.value).toBe(42);
    expect(server.find('GET', '/youtubeanalytics/v2/reports')[0]!.query.get('filters')).toBe('video==yt1');
  });

  it('LinkedIn: follower count and share statistics for shares and ugcPosts with the versioned headers', async () => {
    server.on('GET', /^\/rest\/networkSizes\//, { json: { firstDegreeSize: 880 } });
    server.on('GET', '/rest/organizationalEntityShareStatistics', (req) => {
      const shares = req.query.get('shares');
      return { json: { elements: shares ? [{ share: 'urn:li:share:1', totalShareStatistics: { impressionCount: 500, clickCount: 12, likeCount: 9, commentCount: 1, shareCount: 2, engagement: 0.048 } }] : [] } };
    });
    const r = await fetchLinkedinAnalytics(makeCtx(server, { provider: 'linkedin', accessToken: 'LI' }, { externalAccountId: '5515715' }), ['urn:li:share:1', 'urn:li:ugcPost:2']);
    expect(metric(r.account!.metrics, 'followers')!.value).toBe(880);
    expect(metric(r.posts[0]!.metrics, 'engagement')!.value).toBe(0.048);
    expect(metric(r.posts[0]!.metrics, 'uniqueImpressionsCount')!.status).toBe('not_returned');
    expect(r.posts[1]!.metrics.every((m) => m.status === 'not_returned')).toBe(true);
    const req = server.find('GET', '/rest/organizationalEntityShareStatistics')[0]!;
    expect(req.headers['linkedin-version']).toBe('202610');
    expect(req.query.get('shares')).toBe('List(urn:li:share:1)');
  });
});

describe('P3-06 paid campaign creation executors (PAUSED, verified by read-back)', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('ad')]);
  const sha = createHash('sha256').update(png).digest('hex');
  const assetId = '00000000-0000-4000-8000-0000000000a9';
  const draftId = '11111111-2222-4333-8444-555555555555';
  const metaParams = {
    adAccountId: 'act_626',
    draftId,
    name: 'Spring roast',
    objective: 'OUTCOME_TRAFFIC',
    dailyBudget: { amountMicros: 5_000_000, currency: 'USD' },
    startTime: '2026-11-10T00:00:00Z',
    endTime: '2026-11-17T00:00:00Z',
    targeting: { countries: ['US'], ageMin: 21, ageMax: 55, publisherPlatforms: ['facebook', 'instagram'] },
    optimizationGoal: 'LINK_CLICKS',
    billingEvent: 'IMPRESSIONS',
    creative: { pageId: '501', message: 'Fresh roast every Monday.', link: 'https://acme.example/shop', headline: 'This week’s roast', callToAction: 'SHOP_NOW', image: { assetId, sha256: sha } },
    urlTags: 'utm_source=meta&utm_medium=paid&utm_campaign=acme_spring',
    lifetimeCap: { amountMicros: 35_000_000, currency: 'USD' },
  };

  it('ships disabled in the capability registry (B-026)', () => {
    for (const cap of ['meta_ads_campaign_create', 'google_ads_campaign_create']) expect(CAPABILITY_SEEDS.find((c) => c.capability === cap)).toMatchObject({ supported: false, notes: expect.stringMatching(/B-026/) });
  });

  it('Meta: checks currency and image bytes, creates campaign → ad set → creative → ad PAUSED, reuses on retry, verifies and deletes on rollback', async () => {
    const created: Record<string, { id: string; name: string; status: string }[]> = { campaigns: [], adsets: [], adcreatives: [], ads: [] };
    const objects = new Map<string, Record<string, unknown>>();
    server.on('GET', '/v26.0/act_626', { json: { id: 'act_626', currency: 'USD', account_status: 1, amount_spent: '0' } });
    for (const edge of Object.keys(created)) {
      server.on('GET', `/v26.0/act_626/${edge}`, (req) => {
        const name = JSON.parse(req.query.get('filtering')!)[0].value;
        return { json: { data: created[edge]!.filter((x) => x.name === name) } };
      });
      server.on('POST', `/v26.0/act_626/${edge}`, (req) => {
        const id = `${edge}-${created[edge]!.length + 1}`;
        const f = Object.fromEntries(req.form!.entries());
        created[edge]!.push({ id, name: f.name!, status: f.status ?? 'ACTIVE' });
        objects.set(id, f);
        return { json: { id } };
      });
    }
    server.on('POST', '/v26.0/act_626/adimages', { json: { images: { 'fg.png': { hash: 'imghash1' } } } });
    server.on('GET', /^\/v26\.0\/campaigns-1$/, (req) => ({ json: req.query.get('fields') === 'status' ? { status: objects.get('campaigns-1')!.status } : { id: 'campaigns-1', name: objects.get('campaigns-1')!.name, status: objects.get('campaigns-1')!.status, objective: objects.get('campaigns-1')!.objective } }));
    server.on('GET', /^\/v26\.0\/adsets-1$/, () => ({ json: { daily_budget: objects.get('adsets-1')!.daily_budget, status: 'PAUSED', end_time: '2026-11-17T00:00:00+0000', campaign_id: 'campaigns-1' } }));
    server.on('GET', /^\/v26\.0\/ads-1$/, () => ({ json: { status: 'PAUSED', adset_id: 'adsets-1', creative: { id: 'adcreatives-1' } } }));
    server.on('POST', /^\/v26\.0\/campaigns-1$/, (req) => {
      objects.get('campaigns-1')!.status = req.form!.get('status')!;
      return { json: { success: true } };
    });
    const ctx = { ...makeCtx(server, { provider: 'meta', accessToken: 'PAGE', adsAccessToken: 'ADS' }, { metadata: { adAccountId: 'act_626' } }), loadAsset: async () => ({ bytes: png, mime: 'image/png', sha256: sha, publicUrl: null }) };
    const e = exec('ads.meta.create_campaign');
    const r = await e.execute(ctx, metaParams, meta);
    expect(r.receipt).toMatchObject({ providerObjectId: 'campaigns-1', details: { adSetId: 'adsets-1', creativeId: 'adcreatives-1', adId: 'ads-1', imageHash: 'imghash1', reused: 0 } });
    expect(objects.get('campaigns-1')).toMatchObject({ status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', special_ad_categories: '[]', name: `Spring roast [fg:${draftId.slice(0, 8)}]` });
    expect(objects.get('adsets-1')).toMatchObject({ daily_budget: '500', status: 'PAUSED', campaign_id: 'campaigns-1', end_time: '2026-11-17T00:00:00Z' });
    expect(JSON.parse(String(objects.get('adsets-1')!.targeting))).toEqual({ geo_locations: { countries: ['US'] }, age_min: 21, age_max: 55, publisher_platforms: ['facebook', 'instagram'] });
    expect(JSON.parse(String(objects.get('adcreatives-1')!.object_story_spec))).toMatchObject({ page_id: '501', link_data: { image_hash: 'imghash1', call_to_action: { type: 'SHOP_NOW' } } });
    expect(objects.get('ads-1')).toMatchObject({ status: 'PAUSED', adset_id: 'adsets-1' });
    expect(server.find('POST', '/v26.0/act_626/campaigns')[0]!.query.get('access_token') ?? server.find('POST', '/v26.0/act_626/campaigns')[0]!.headers.authorization).toMatch(/ADS/);
    // A retry after an ambiguous failure finds every tagged object instead of creating duplicates.
    const again = await e.execute(ctx, metaParams, meta);
    expect(again.receipt.details.reused).toBe(4);
    expect(created.campaigns).toHaveLength(1);
    expect((await e.verify(ctx, metaParams, r.receipt)).verdict).toBe('VERIFIED');
    await e.rollback(ctx, metaParams, r.receipt, null);
    expect((await e.verifyRollback(ctx, metaParams, r.receipt, null)).verdict).toBe('VERIFIED');
  });

  it('Meta: refuses a currency mismatch or changed image bytes before sending anything', async () => {
    server.on('GET', '/v26.0/act_626', { json: { id: 'act_626', currency: 'BDT', account_status: 1 } });
    const ctx = { ...makeCtx(server, { provider: 'meta', accessToken: 'PAGE', adsAccessToken: 'ADS' }, { metadata: { adAccountId: 'act_626' } }), loadAsset: async () => ({ bytes: png, mime: 'image/png', sha256: sha, publicUrl: null }) };
    await expect(exec('ads.meta.create_campaign').execute(ctx, metaParams, meta)).rejects.toThrow(/currency is BDT/);
    expect(server.requests.filter((x) => x.method === 'POST')).toHaveLength(0);
  });

  const googleParams = {
    customerId: '1234567890',
    draftId,
    name: 'Spring roast search',
    dailyBudget: { amountMicros: 10_000_000, currency: 'USD' },
    startDate: '2026-11-10',
    endDate: '2026-11-16',
    geoTargetConstants: [2840],
    languageConstants: [1000],
    bidding: { strategy: 'MAXIMIZE_CLICKS', cpcBidCeiling: { amountMicros: 1_500_000, currency: 'USD' } },
    adGroup: { name: 'Coffee beans', cpcBid: null },
    ad: { finalUrl: 'https://acme.example/shop', finalUrlSuffix: 'utm_source=google&utm_medium=cpc&utm_campaign=acme_spring', headlines: ['Fresh coffee beans', 'Roasted every Monday', 'Order online'], descriptions: ['Roasted every Monday and shipped fresh.', 'Pick your roast online.'], path1: 'beans', path2: null },
    keywords: [
      { text: 'fresh coffee beans', matchType: 'PHRASE' },
      { text: 'coffee roaster', matchType: 'BROAD' },
    ],
  };

  it('Google: one atomic mutate after validate-only, PAUSED Search campaign with v23+ date-time fields, verified, removed on rollback', async () => {
    let removed = false;
    let created = false;
    server.on('POST', '/oauth/token', { json: { access_token: 'ya29.ads', expires_in: 3600 } });
    server.on('POST', '/v26/customers/1234567890/googleAds:search', (req) => {
      const q = (req.json as { query: string }).query;
      if (q.includes('customer.currency_code')) return { json: { results: [{ customer: { currencyCode: 'USD' } }] } };
      if (q.includes('FROM campaign WHERE campaign.name')) return { json: { results: created ? [{ campaign: { resourceName: 'customers/1234567890/campaigns/77', status: 'PAUSED' } }] : [] } };
      if (q.includes('FROM ad_group_ad')) return { json: { results: [{ adGroupAd: { status: 'ENABLED' } }] } };
      if (q.includes('campaign_budget.amount_micros')) return { json: { results: [{ campaign: { name: googleFgName(googleParams), status: 'PAUSED', advertisingChannelType: 'SEARCH' }, campaignBudget: { amountMicros: '10000000' } }] } };
      return { json: { results: [{ campaign: { status: removed ? 'REMOVED' : 'PAUSED' } }] } };
    });
    server.on('POST', '/v26/customers/1234567890/googleAds:mutate', (req) => {
      const body = req.json as { validateOnly: boolean };
      if (body.validateOnly) return { json: {} };
      created = true;
      return {
        json: {
          mutateOperationResponses: [
            { campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/9' } },
            { campaignResult: { resourceName: 'customers/1234567890/campaigns/77' } },
            { adGroupResult: { resourceName: 'customers/1234567890/adGroups/5' } },
            { adGroupAdResult: { resourceName: 'customers/1234567890/adGroupAds/5~1' } },
          ],
        },
      };
    });
    server.on('POST', '/v26/customers/1234567890/campaigns:mutate', () => {
      removed = true;
      return { json: { results: [{ resourceName: 'customers/1234567890/campaigns/77' }] } };
    });
    const ctx = makeCtx(server, { provider: 'google_ads', clientId: 'c', clientSecret: 's', refreshToken: 'r-ads' });
    const e = exec('ads.google.create_campaign');
    const r = await e.execute(ctx, googleParams, meta);
    expect(r.receipt).toMatchObject({ providerObjectId: 'customers/1234567890/campaigns/77', details: { adGroup: 'customers/1234567890/adGroups/5' } });
    const calls = server.find('POST', '/v26/customers/1234567890/googleAds:mutate');
    expect(calls.map((c) => (c.json as { validateOnly: boolean }).validateOnly)).toEqual([true, false]);
    const ops = (calls[1]!.json as { mutateOperations: Record<string, any>[]; partialFailure: boolean }).mutateOperations;
    expect((calls[1]!.json as { partialFailure: boolean }).partialFailure).toBe(false);
    const campaign = ops.find((o) => o.campaignOperation)!.campaignOperation.create;
    expect(campaign).toMatchObject({ status: 'PAUSED', advertisingChannelType: 'SEARCH', startDateTime: '2026-11-10 00:00:00', endDateTime: '2026-11-16 23:59:59', containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', targetSpend: { cpcBidCeilingMicros: '1500000' } });
    expect(ops.filter((o) => o.adGroupCriterionOperation)).toHaveLength(2);
    expect(ops.find((o) => o.campaignCriterionOperation?.create.location)!.campaignCriterionOperation.create.location.geoTargetConstant).toBe('geoTargetConstants/2840');
    // Idempotent replay: the tagged campaign exists now, so a second execute creates nothing.
    const replay = await e.execute(ctx, googleParams, meta);
    expect(replay.receipt.details).toEqual({ replayed: true });
    expect(server.find('POST', '/v26/customers/1234567890/googleAds:mutate')).toHaveLength(2);
    expect((await e.verify(ctx, googleParams, r.receipt)).verdict).toBe('VERIFIED');
    await e.rollback(ctx, googleParams, r.receipt, null);
    expect((await e.verifyRollback(ctx, googleParams, r.receipt, null)).verdict).toBe('VERIFIED');
  });

  it('Google: manual CPC bidding and the operation order are deterministic', () => {
    const ops = createCampaignOperations({ ...googleParams, bidding: { strategy: 'MANUAL_CPC', cpcBidCeiling: null } } as never);
    expect(Object.keys(ops[0]!)).toEqual(['campaignBudgetOperation']);
    expect((ops[1] as any).campaignOperation.create.manualCpc).toEqual({});
    expect(Object.keys(ops.at(-1)!)).toEqual(['adGroupAdOperation']);
  });
});
