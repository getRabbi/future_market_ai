import { createPublicKey, verify as cryptoVerify, generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { hmacSha256Hex } from '@futuregrow/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appStoreConnectJwt, EXECUTORS, fetchPageInsights, fetchSalesReport, PAGE_INSIGHT_METRICS, READ_CONNECTORS } from '../src/index.js';
import { clearGoogleTokenCache } from '../src/providers/google.js';
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
    rollback?: (c: unknown, p: unknown, r: unknown, b: unknown) => Promise<any>;
    verifyRollback?: (c: unknown, p: unknown, r: unknown, b: unknown) => Promise<any>;
  };

describe('Meta Graph API', () => {
  const ctx = () => makeCtx(server, { provider: 'meta', accessToken: 'PAGE_TOKEN', appSecret: 'APP_SECRET' });

  it('publishes a page post, verifies by readback, and rolls back with delete', async () => {
    server.on('POST', '/v26.0/123/feed', { json: { id: '123_456' }, headers: { 'x-fb-trace-id': 'trace-1' } });
    let deleted = false;
    server.on('GET', '/v26.0/123_456', () => (deleted ? { status: 400, json: { error: { code: 100, message: 'Unsupported get request' } } } : { json: { id: '123_456', message: 'Hello', is_published: true, permalink_url: 'https://facebook.com/123_456' } }));
    server.on('DELETE', '/v26.0/123_456', () => {
      deleted = true;
      return { json: { success: true } };
    });
    const e = exec('social.facebook.publish_post');
    const p = { pageId: '123', message: 'Hello' };
    const r = await e.execute(ctx(), p, meta);
    expect(r.receipt.providerObjectId).toBe('123_456');
    expect(r.receipt.providerRequestId).toBe('trace-1');
    const post = server.find('POST', '/v26.0/123/feed')[0]!;
    expect(post.headers.authorization).toBe('Bearer PAGE_TOKEN');
    expect(post.query.get('appsecret_proof')).toMatch(/^[a-f0-9]{64}$/);
    expect(post.form?.get('message')).toBe('Hello');

    const v = await e.verify(ctx(), p, r.receipt);
    expect(v.verdict).toBe('VERIFIED');
    const wrong = await e.verify(ctx(), { ...p, message: 'Different' }, r.receipt);
    expect(wrong.verdict).toBe('MISMATCH');
    expect(wrong.diff[0].path).toBe('message');

    await e.rollback!(ctx(), p, r.receipt, null);
    expect((await e.verifyRollback!(ctx(), p, r.receipt, null)).verdict).toBe('VERIFIED');
  });

  it('refuses a budget change when the live budget differs from the proposal (no write sent)', async () => {
    server.on('GET', '/v26.0/987', { json: { id: '987', daily_budget: '5000', status: 'ACTIVE' } });
    const e = exec('ads.meta.update_campaign_budget');
    const p = { campaignId: '987', newDailyBudget: { amountMicros: 60_000_000, currency: 'USD' }, previousDailyBudget: { amountMicros: 40_000_000, currency: 'USD' } };
    const err = await e.execute(ctx(), p, meta).catch((x) => x);
    expect(err.phase).toBe('rejected');
    expect(server.find('POST', '/v26.0/987')).toHaveLength(0);
  });

  it('updates a budget in minor units and verifies the readback', async () => {
    let budget = '4000';
    server.on('GET', '/v26.0/987', () => ({ json: { id: '987', daily_budget: budget, status: 'ACTIVE' } }));
    server.on('POST', '/v26.0/987', (req) => {
      budget = req.form!.get('daily_budget')!;
      return { json: { success: true } };
    });
    const e = exec('ads.meta.update_campaign_budget');
    const p = { campaignId: '987', newDailyBudget: { amountMicros: 60_000_000, currency: 'USD' }, previousDailyBudget: { amountMicros: 40_000_000, currency: 'USD' } };
    const r = await e.execute(ctx(), p, meta);
    expect(budget).toBe('6000');
    expect(r.beforeState.daily_budget).toBe('4000');
    expect((await e.verify(ctx(), p, r.receipt)).verdict).toBe('VERIFIED');
    await e.rollback!(ctx(), p, r.receipt, r.beforeState);
    expect(budget).toBe('4000');
    expect((await e.verifyRollback!(ctx(), p, r.receipt, r.beforeState)).verdict).toBe('VERIFIED');
  });

  it('instagram: waits for the container to finish before publishing', async () => {
    let polls = 0;
    server.on('POST', '/v26.0/ig1/media', { json: { id: 'c1' } });
    server.on('GET', '/v26.0/c1', () => ({ json: { status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' } }));
    server.on('POST', '/v26.0/ig1/media_publish', { json: { id: 'media9' } });
    server.on('GET', '/v26.0/media9', { json: { id: 'media9', caption: 'Hi', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://instagram.com/p/x' } });
    const e = exec('social.instagram.publish_media');
    const p = { igUserId: 'ig1', mediaType: 'REELS', mediaUrl: 'https://cdn.example/v.mp4', caption: 'Hi' };
    const r = await e.execute(ctx(), p, meta);
    expect(polls).toBe(3);
    expect(server.find('POST', '/v26.0/ig1/media')[0]!.form?.get('media_type')).toBe('REELS');
    expect(r.receipt.providerObjectId).toBe('media9');
    expect((await e.verify(ctx(), p, r.receipt)).verdict).toBe('VERIFIED');
  });

  it('instagram: an errored container is rejected and nothing is published', async () => {
    server.on('POST', '/v26.0/ig1/media', { json: { id: 'c2' } });
    server.on('GET', '/v26.0/c2', { json: { status_code: 'ERROR' } });
    const err = await exec('social.instagram.publish_media')
      .execute(ctx(), { igUserId: 'ig1', mediaType: 'IMAGE', mediaUrl: 'https://cdn.example/i.jpg', caption: 'x' }, meta)
      .catch((x) => x);
    expect(err.phase).toBe('rejected');
    expect(server.find('POST', '/v26.0/ig1/media_publish')).toHaveLength(0);
  });

  it('maps invalid tokens (code 190) to auth errors', async () => {
    server.on('POST', '/v26.0/123/feed', { status: 400, json: { error: { code: 190, message: 'Error validating access token' } } });
    const err = await exec('social.facebook.publish_post')
      .execute(ctx(), { pageId: '123', message: 'x' }, meta)
      .catch((x) => x);
    expect(err.isAuthError).toBe(true);
  });

  it('reads campaigns and daily spend from insights', async () => {
    server.on('GET', '/v26.0/act_555', { json: { currency: 'USD' } });
    server.on('GET', '/v26.0/act_555/campaigns', { json: { data: [{ id: '1', name: 'Prospecting', status: 'ACTIVE', daily_budget: '2500' }] } });
    server.on('GET', '/v26.0/act_555/insights', {
      json: { data: [{ campaign_id: '1', date_start: '2026-10-18', spend: '24.17', impressions: '1000', clicks: '40', actions: [{ action_type: 'purchase', value: '2' }], action_values: [{ action_type: 'purchase', value: '80.00' }] }] },
    });
    const c = makeCtx(server, { provider: 'meta', accessToken: 'T' }, { externalAccountId: '555' });
    const camps = await READ_CONNECTORS.meta!.listCampaigns!(c);
    expect(camps[0]).toMatchObject({ externalCampaignId: '1', dailyBudgetMicros: 25_000_000, currency: 'USD' });
    const spend = await READ_CONNECTORS.meta!.fetchSpend!(c, '2026-10-18', '2026-10-18');
    expect(spend[0]).toMatchObject({ costMicros: 24_170_000, conversions: 2, conversionValueMicros: 80_000_000 });
  });

  describe('organic Page insights', () => {
    const pageCtx = () => makeCtx(server, { provider: 'meta', accessToken: 'PAGE_TOKEN', appSecret: 'APP_SECRET' }, { externalAccountId: '123' });
    // A daily value is stamped with the end of its Page-local day (07:00 UTC in Pacific daylight time).
    const day = (endTime: string, value: unknown) => ({ value, end_time: endTime });

    it('reads each metric on its own, assigns values to the day that ended, and keeps only completed days in range', async () => {
      server.on('GET', '/v26.0/123/insights', (req) => {
        const metric = req.query.get('metric');
        if (metric === 'page_views_total') return { status: 400, json: { error: { code: 100, message: '(#100) The value must be a valid insights metric' } } };
        if (metric === 'page_media_view') return { json: { data: [] } };
        const values = [day('2026-10-16T07:00:00+0000', 1), day('2026-10-17T07:00:00+0000', 4), day('2026-10-18T07:00:00+0000', { like: 2 }), day('2026-10-19T07:00:00+0000', 0), day('2026-10-20T07:00:00+0000', 9)];
        return { json: { data: [{ name: metric, period: 'day', values }] } };
      });
      const r = await fetchPageInsights(pageCtx(), '2026-10-16', '2026-10-19');
      // 10-15 is before the range, the object value is not a count, and 10-19 has not ended yet at 12:00 UTC.
      expect(r.page_post_engagements).toEqual({
        status: 'ok',
        values: [
          { date: '2026-10-16', value: 4 },
          { date: '2026-10-18', value: 0 },
        ],
      });
      expect(r.page_daily_follows_unique!.status).toBe('ok');
      expect(r.page_media_view).toEqual({ status: 'no_data', values: [] });
      expect(r.page_views_total).toMatchObject({ status: 'unsupported', values: [] });
      const reqs = server.find('GET', '/v26.0/123/insights');
      expect(reqs.map((q) => q.query.get('metric'))).toEqual([...PAGE_INSIGHT_METRICS]);
      expect(reqs[0]!.query.get('period')).toBe('day');
      expect(reqs[0]!.headers.authorization).toBe('Bearer PAGE_TOKEN');
      expect(reqs[0]!.query.get('appsecret_proof')).toBe(hmacSha256Hex('APP_SECRET', 'PAGE_TOKEN'));
    });

    it('throws on an invalid token instead of reporting empty metrics, and refuses ranges Meta would reject', async () => {
      server.on('GET', '/v26.0/123/insights', { status: 400, json: { error: { code: 190, message: 'Error validating access token' } } });
      await expect(fetchPageInsights(pageCtx(), '2026-10-01', '2026-10-18')).rejects.toMatchObject({ status: 401 });
      await expect(fetchPageInsights(pageCtx(), '2026-07-01', '2026-10-18')).rejects.toThrow(/1–88 days/);
      await expect(fetchPageInsights(pageCtx(), '2026-10-18', '2026-10-01')).rejects.toThrow(/1–88 days/);
    });
  });

  describe('separate Page and ads tokens', () => {
    const both = { provider: 'meta' as const, accessToken: 'PAGE_TOKEN', adsAccessToken: 'ADS_TOKEN', appSecret: 'APP_SECRET' };
    const pageMe = () => {
      server.on('GET', '/v26.0/me', { json: { id: '123', name: 'Shop' } });
      server.on('GET', '/v26.0/me/permissions', { status: 400, json: { error: { code: 100, message: 'Tried accessing nonexisting field (permissions) on node type (Page)' } } });
    };

    it('sends ad account calls with the ads token and Page calls with the Page token, each with its own proof', async () => {
      let status = 'PAUSED';
      server.on('GET', '/v26.0/987', () => ({ json: { id: '987', status } }));
      server.on('POST', '/v26.0/987', (req) => {
        status = req.form!.get('status')!;
        return { json: { success: true } };
      });
      server.on('POST', '/v26.0/123/feed', { json: { id: '123_1' } });
      const c = makeCtx(server, both);
      await exec('ads.meta.set_campaign_status').execute(c, { campaignId: '987', status: 'ACTIVE', previousStatus: 'PAUSED' }, meta);
      await exec('social.facebook.publish_post').execute(c, { pageId: '123', message: 'Hi' }, meta);

      for (const r of [...server.find('GET', '/v26.0/987'), ...server.find('POST', '/v26.0/987')]) {
        expect(r.headers.authorization).toBe('Bearer ADS_TOKEN');
        expect(r.query.get('appsecret_proof')).toBe(hmacSha256Hex('APP_SECRET', 'ADS_TOKEN'));
      }
      const post = server.find('POST', '/v26.0/123/feed')[0]!;
      expect(post.headers.authorization).toBe('Bearer PAGE_TOKEN');
      expect(post.query.get('appsecret_proof')).toBe(hmacSha256Hex('APP_SECRET', 'PAGE_TOKEN'));
    });

    it('accepts an ad account ID written with the act_ prefix', async () => {
      server.on('GET', '/v26.0/act_555', { json: { currency: 'USD' } });
      server.on('GET', '/v26.0/act_555/campaigns', { json: { data: [] } });
      const c = makeCtx(server, both, { externalAccountId: '123', metadata: { adAccountId: 'act_555' } });
      expect(await READ_CONNECTORS.meta!.listCampaigns!(c)).toEqual([]);
      expect(server.find('GET', '/v26.0/act_555')[0]!.headers.authorization).toBe('Bearer ADS_TOKEN');
    });

    it('health check reads the ad account with the ads token', async () => {
      pageMe();
      server.on('GET', '/v26.0/act_555', { json: { id: 'act_555', currency: 'EUR' } });
      const h = await READ_CONNECTORS.meta!.healthCheck(makeCtx(server, both, { externalAccountId: '123', metadata: { adAccountId: 'act_555' } }));
      expect(h).toMatchObject({ healthy: true, status: 'healthy', grantedScopes: null, details: { id: '123', adAccount: 'act_555 (EUR)' } });
    });

    it('health check reports a Page token used for ads as degraded, with the reason', async () => {
      pageMe();
      server.on('GET', '/v26.0/act_555', { status: 400, json: { error: { code: 200, message: '(#200) Missing permission ads_read' } } });
      const h = await READ_CONNECTORS.meta!.healthCheck(makeCtx(server, { provider: 'meta', accessToken: 'PAGE_TOKEN' }, { externalAccountId: '123', metadata: { adAccountId: '555' } }));
      expect(h.healthy).toBe(false);
      expect(h.status).toBe('degraded');
      expect(String(h.details.error)).toContain('ads: (#200) Missing permission ads_read');
      expect(String(h.details.error)).toContain('add an ads access token');
    });

    it('health check of a Page-only connection never touches an ad account', async () => {
      pageMe();
      const h = await READ_CONNECTORS.meta!.healthCheck(makeCtx(server, { provider: 'meta', accessToken: 'PAGE_TOKEN' }, { externalAccountId: '123' }));
      expect(h).toMatchObject({ healthy: true, details: { id: '123' } });
      expect(server.find('GET', /act_/)).toHaveLength(0);
    });
  });

  describe('token inspection (debug_token)', () => {
    const PAGE_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement', 'pages_read_user_content', 'pages_manage_metadata'];
    const tokens = (infos: Record<string, Record<string, unknown>>) => server.on('GET', '/v26.0/debug_token', (req) => ({ json: { data: infos[req.query.get('input_token')!] ?? { is_valid: false } } }));
    const at = (iso: string) => Date.parse(iso) / 1000;

    it('reports token types, expiry, scopes and the Page feed webhook; a long-lived Page and system-user token is healthy', async () => {
      server.on('GET', '/v26.0/me', { json: { id: '123', name: 'Shop' } });
      tokens({ PAGE_TOKEN: { type: 'PAGE', app_id: '777', is_valid: true, expires_at: 0, scopes: PAGE_SCOPES }, ADS_TOKEN: { type: 'SYSTEM_USER', app_id: '777', is_valid: true, expires_at: 0, scopes: ['ads_read', 'ads_management'] } });
      server.on('GET', '/v26.0/123/subscribed_apps', { json: { data: [{ id: '777', name: 'App', subscribed_fields: ['feed'] }] } });
      server.on('GET', '/v26.0/act_555', { json: { id: 'act_555', currency: 'BDT' } });
      const both = { provider: 'meta' as const, accessToken: 'PAGE_TOKEN', adsAccessToken: 'ADS_TOKEN', appSecret: 'APP_SECRET' };
      const h = await READ_CONNECTORS.meta!.healthCheck(makeCtx(server, both, { externalAccountId: '123', metadata: { adAccountId: 'act_555' } }));
      expect(h).toMatchObject({ healthy: true, status: 'healthy', grantedScopes: PAGE_SCOPES, details: { id: '123', tokenType: 'PAGE', tokenExpiresAt: 'never', feedWebhook: true, adAccount: 'act_555 (BDT)', adsTokenType: 'SYSTEM_USER', adsTokenExpiresAt: 'never' } });
      const adsDebug = server.find('GET', '/v26.0/debug_token').find((r) => r.query.get('input_token') === 'ADS_TOKEN')!;
      expect(adsDebug.headers.authorization).toBe('Bearer ADS_TOKEN');
      expect(adsDebug.query.get('appsecret_proof')).toBe(hmacSha256Hex('APP_SECRET', 'ADS_TOKEN'));
      expect(server.find('GET', '/v26.0/me/permissions')).toHaveLength(0);
    });

    it('degrades a short-lived user token used as the Page token, and a Page token without reply scope or webhook', async () => {
      server.on('GET', '/v26.0/me', { json: { id: '999', name: 'A person' } });
      server.on('GET', '/v26.0/me/permissions', { json: { data: [{ permission: 'pages_manage_posts', status: 'granted' }] } });
      tokens({ USER_TOKEN: { type: 'USER', app_id: '777', is_valid: true, expires_at: at('2026-10-19T13:00:00Z'), scopes: ['pages_manage_posts'] } });
      const user = await READ_CONNECTORS.meta!.healthCheck(makeCtx(server, { provider: 'meta', accessToken: 'USER_TOKEN' }, { externalAccountId: '123' }));
      expect(user).toMatchObject({ healthy: false, status: 'degraded', details: { tokenType: 'USER', tokenExpiresAt: '2026-10-19T13:00:00.000Z' } });
      expect(user.details.warnings).toEqual(['the Page access token is a USER token; posts and replies need a Page token (GET /{page-id}?fields=access_token)', 'Page token expires 2026-10-19T13:00:00.000Z; replace it with a long-lived token']);

      server.reset();
      server.on('GET', '/v26.0/me', { json: { id: '123', name: 'Shop' } });
      tokens({ PAGE_TOKEN: { type: 'PAGE', app_id: '777', is_valid: true, expires_at: at('2027-01-01T00:00:00Z'), scopes: PAGE_SCOPES.filter((s) => s !== 'pages_manage_engagement') } });
      server.on('GET', '/v26.0/123/subscribed_apps', { json: { data: [] } });
      const page = await READ_CONNECTORS.meta!.healthCheck(makeCtx(server, { provider: 'meta', accessToken: 'PAGE_TOKEN' }, { externalAccountId: '123' }));
      expect(page).toMatchObject({ status: 'degraded', details: { tokenType: 'PAGE', tokenExpiresAt: '2027-01-01T00:00:00.000Z', feedWebhook: false, warnings: ['Page token lacks pages_manage_engagement (comment replies)'] } });

      server.reset();
      server.on('GET', '/v26.0/me', { json: { id: '123', name: 'Shop' } });
      tokens({ PAGE_TOKEN: { type: 'PAGE', app_id: '777', is_valid: true, expires_at: 0, data_access_expires_at: at('2026-10-22T00:00:00Z'), scopes: PAGE_SCOPES } });
      server.on('GET', '/v26.0/123/subscribed_apps', { json: { data: [{ id: '777', subscribed_fields: ['feed'] }] } });
      const lapsing = await READ_CONNECTORS.meta!.healthCheck(makeCtx(server, { provider: 'meta', accessToken: 'PAGE_TOKEN' }, { externalAccountId: '123' }));
      expect(lapsing).toMatchObject({ status: 'degraded', details: { tokenExpiresAt: 'never', tokenDataAccessUntil: '2026-10-22T00:00:00.000Z', warnings: ['Page token loses data access 2026-10-22T00:00:00.000Z; the user must authorize the app again (system-user tokens do not lapse)'] } });
    });

    it('fails a Page token that belongs to a different Page than the connection', async () => {
      server.on('GET', '/v26.0/me', { json: { id: '456', name: 'Other page' } });
      tokens({ PAGE_TOKEN: { type: 'PAGE', app_id: '777', is_valid: true, expires_at: 0, scopes: PAGE_SCOPES } });
      const h = await READ_CONNECTORS.meta!.healthCheck(makeCtx(server, { provider: 'meta', accessToken: 'PAGE_TOKEN' }, { externalAccountId: '123' }));
      expect(h).toMatchObject({ healthy: false, status: 'failing' });
      expect(String(h.details.error)).toBe('the Page token belongs to Page 456 (Other page), not 123');
    });
  });
});

describe('Google Ads API', () => {
  const creds = { provider: 'google_ads' as const, clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt' };
  const ctx = () => makeCtx(server, creds, { externalAccountId: '1234567890' });

  function mountGoogle(state: { micros: number; currency?: string }) {
    server.on('POST', '/oauth/token', (req) => {
      expect(req.form?.get('grant_type')).toBe('refresh_token');
      return { json: { access_token: 'AT', expires_in: 3600 } };
    });
    server.on('POST', '/v26/customers/1234567890/googleAds:search', (req) => {
      const q = (req.json as { query: string }).query;
      if (q.includes('FROM customer')) return { json: { results: [{ customer: { currencyCode: state.currency ?? 'USD' } }] } };
      if (q.includes('FROM campaign_budget')) return { json: { results: [{ campaignBudget: { amountMicros: String(state.micros) } }] } };
      return { json: { results: [] } };
    });
    server.on('POST', '/v26/customers/1234567890/campaignBudgets:mutate', (req) => {
      const body = req.json as { validateOnly: boolean; operations: { update: { amountMicros: string } }[] };
      if (!body.validateOnly) state.micros = Number(body.operations[0]!.update.amountMicros);
      return { json: { results: [{ resourceName: 'customers/1234567890/campaignBudgets/77' }] } };
    });
  }

  const params = {
    customerId: '1234567890',
    campaignBudgetId: '77',
    campaignRef: 'c-1',
    newDailyBudget: { amountMicros: 50_000_000, currency: 'USD' },
    previousDailyBudget: { amountMicros: 30_000_000, currency: 'USD' },
  };

  it('dry-runs with validateOnly, then mutates, then verifies; no developer token by default (D-003)', async () => {
    const state = { micros: 30_000_000 };
    mountGoogle(state);
    const e = exec('ads.google.update_campaign_budget');
    const r = await e.execute(ctx(), params, meta);
    const mutates = server.find('POST', '/v26/customers/1234567890/campaignBudgets:mutate');
    expect(mutates.map((m) => (m.json as { validateOnly: boolean }).validateOnly)).toEqual([true, false]);
    expect((mutates[1]!.json as any).operations[0]).toEqual({
      updateMask: 'amountMicros',
      update: { resourceName: 'customers/1234567890/campaignBudgets/77', amountMicros: '50000000' },
    });
    expect(mutates[1]!.headers.authorization).toBe('Bearer AT');
    expect(mutates[1]!.headers['developer-token']).toBeUndefined();
    expect(state.micros).toBe(50_000_000);
    expect((await e.verify(ctx(), params, r.receipt)).verdict).toBe('VERIFIED');
    state.micros = 45_000_000; // someone else changed it
    expect((await e.verify(ctx(), params, r.receipt)).verdict).toBe('MISMATCH');
  });

  it('refuses when the account currency differs (nothing mutated)', async () => {
    const state = { micros: 30_000_000, currency: 'EUR' };
    mountGoogle(state);
    const err = await exec('ads.google.update_campaign_budget')
      .execute(ctx(), params, meta)
      .catch((x) => x);
    expect(err.phase).toBe('rejected');
    expect(server.find('POST', '/v26/customers/1234567890/campaignBudgets:mutate')).toHaveLength(0);
  });

  it('a revoked refresh token is an auth failure before anything is sent', async () => {
    server.on('POST', '/oauth/token', { status: 400, json: { error: 'invalid_grant' } });
    const err = await exec('ads.google.update_campaign_budget')
      .execute(ctx(), params, meta)
      .catch((x) => x);
    expect(err.isAuthError).toBe(true);
    expect(err.phase).toBe('before_send');
  });
});

describe('TikTok Content Posting API', () => {
  const ctx = () => makeCtx(server, { provider: 'tiktok', accessToken: 'TT' });
  const p = {
    title: 'Launch day',
    videoUrl: 'https://media.example.com/v.mp4',
    privacyLevel: 'SELF_ONLY',
    disableComment: false,
    disableDuet: false,
    disableStitch: false,
    brandContentToggle: false,
    brandOrganicToggle: true,
    disclosure: { isAiGenerated: true },
  };

  it('queries creator info, honours creator settings, sets is_aigc, and polls status', async () => {
    server.on('POST', '/v2/post/publish/creator_info/query/', {
      json: { data: { privacy_level_options: ['SELF_ONLY'], comment_disabled: true, duet_disabled: false, stitch_disabled: false }, error: { code: 'ok' } },
    });
    server.on('POST', '/v2/post/publish/video/init/', { json: { data: { publish_id: 'p_1' }, error: { code: 'ok', log_id: 'log1' } } });
    let n = 0;
    server.on('POST', '/v2/post/publish/status/fetch/', () => ({
      json: { data: { status: ++n < 2 ? 'PROCESSING_DOWNLOAD' : 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }, error: { code: 'ok' } },
    }));
    const e = exec('social.tiktok.publish_video');
    const r = await e.execute(ctx(), p, meta);
    const init = server.find('POST', '/v2/post/publish/video/init/')[0]!.json as any;
    expect(init.post_info).toMatchObject({ privacy_level: 'SELF_ONLY', disable_comment: true, is_aigc: true, brand_organic_toggle: true });
    expect(init.source_info).toEqual({ source: 'PULL_FROM_URL', video_url: p.videoUrl });
    expect(r.receipt.providerRequestId).toBe('log1');
    expect((await e.verify(ctx(), p, r.receipt)).verdict).toBe('PENDING');
    expect((await e.verify(ctx(), p, r.receipt)).verdict).toBe('VERIFIED');
  });

  it('refuses a privacy level the creator does not offer, before init', async () => {
    server.on('POST', '/v2/post/publish/creator_info/query/', {
      json: { data: { privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false }, error: { code: 'ok' } },
    });
    const err = await exec('social.tiktok.publish_video')
      .execute(ctx(), { ...p, privacyLevel: 'PUBLIC_TO_EVERYONE' }, meta)
      .catch((x) => x);
    expect(err.phase).toBe('rejected');
    expect(server.find('POST', '/v2/post/publish/video/init/')).toHaveLength(0);
  });
});

describe('YouTube Data API', () => {
  it('uploads via a resumable session and verifies processing + synthetic-media flag', async () => {
    const ctx = makeCtx(server, { provider: 'youtube', clientId: 'c', clientSecret: 's', refreshToken: 'r' });
    server.on('POST', '/oauth/token', { json: { access_token: 'YT', expires_in: 3600 } });
    server.on('POST', '/upload/youtube/v3/videos', { headers: { location: `${server.baseUrl}/upload/session/abc` }, json: {} });
    server.on('PUT', '/upload/session/abc', { json: { id: 'vid1', status: { uploadStatus: 'uploaded' } } });
    let processed = false;
    server.on('GET', '/youtube/v3/videos', () => ({
      json: { items: [{ id: 'vid1', snippet: { title: 'Demo' }, status: { uploadStatus: processed ? 'processed' : 'uploaded', privacyStatus: 'private', containsSyntheticMedia: true } }] },
    }));
    const e = exec('social.youtube.upload_video');
    const p = { title: 'Demo', description: 'd', privacyStatus: 'private', categoryId: '22', containsSyntheticMedia: true, madeForKids: false, assetIds: ['00000000-0000-4000-8000-000000000001'] };
    const r = await e.execute(ctx, p, meta);
    const init = server.find('POST', '/upload/youtube/v3/videos')[0]!;
    expect(init.query.get('uploadType')).toBe('resumable');
    expect((init.json as any).status).toMatchObject({ containsSyntheticMedia: true, selfDeclaredMadeForKids: false });
    expect((await e.verify(ctx, p, r.receipt)).verdict).toBe('PENDING');
    processed = true;
    expect((await e.verify(ctx, p, r.receipt)).verdict).toBe('VERIFIED');
  });
});

describe('Shopify Admin GraphQL', () => {
  it('looks before create, creates with context, verifies by code, and deactivates on rollback', async () => {
    const ctx = makeCtx(server, { provider: 'shopify', shopDomain: 'demo.myshopify.com', accessToken: 'shpat' });
    let created = false;
    let status = 'ACTIVE';
    server.on('POST', '/admin/api/2026-10/graphql.json', (req) => {
      const q = (req.json as { query: string; variables: any }).query;
      if (q.includes('codeDiscountNodeByCode')) {
        return {
          json: {
            data: {
              codeDiscountNodeByCode: created ? { id: 'gid://shopify/DiscountCodeNode/1', codeDiscount: { title: 'Fall 10', status, usageLimit: 100, codes: { nodes: [{ code: 'FALL10' }] }, customerGets: { value: { percentage: 0.1 } } } } : null,
            },
          },
        };
      }
      if (q.includes('discountCodeBasicCreate')) {
        expect((req.json as any).variables.input.context).toEqual({ all: 'ALL' });
        created = true;
        return { json: { data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } } } };
      }
      if (q.includes('discountCodeDeactivate')) {
        status = 'EXPIRED';
        return { json: { data: { discountCodeDeactivate: { codeDiscountNode: { id: 'x' }, userErrors: [] } } } };
      }
      return { status: 400, json: { errors: [{ message: 'unexpected' }] } };
    });
    const e = exec('commerce.shopify.create_discount');
    const p = { title: 'Fall 10', code: 'FALL10', percentage: 0.1, startsAt: '2026-10-20T00:00:00Z', endsAt: null, usageLimit: 100 };
    const r = await e.execute(ctx, p, meta);
    expect(server.requests[0]!.headers['x-shopify-access-token']).toBe('shpat');
    expect((await e.verify(ctx, p, r.receipt)).verdict).toBe('VERIFIED');
    // A second execution with the same code must not create a duplicate.
    const dup = await e.execute(ctx, p, meta).catch((x) => x);
    expect(dup.phase).toBe('rejected');
    await e.rollback!(ctx, p, r.receipt, null);
    expect((await e.verifyRollback!(ctx, p, r.receipt, null)).verdict).toBe('VERIFIED');
  });

  it('userErrors are rejections', async () => {
    const ctx = makeCtx(server, { provider: 'shopify', shopDomain: 'demo.myshopify.com', accessToken: 'shpat' });
    server.on('POST', '/admin/api/2026-10/graphql.json', (req) =>
      (req.json as { query: string }).query.includes('codeDiscountNodeByCode') ? { json: { data: { codeDiscountNodeByCode: null } } } : { json: { data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: 'Code must be unique' }] } } } },
    );
    const err = await exec('commerce.shopify.create_discount')
      .execute(ctx, { title: 't', code: 'ABCD', percentage: 0.1, startsAt: '2026-10-20T00:00:00Z', endsAt: null, usageLimit: null }, meta)
      .catch((x) => x);
    expect(err.phase).toBe('rejected');
  });
});

describe('App Store Connect', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const creds = { provider: 'app_store_connect' as const, issuerId: 'iss-1', keyId: 'KEY123', privateKeyPem: pem, vendorNumber: '8888' };

  it('mints a valid ES256 JWT with the documented claims', () => {
    const jwt = appStoreConnectJwt(creds, new Date('2026-10-19T12:00:00Z'));
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payload).toMatchObject({ iss: 'iss-1', aud: 'appstoreconnect-v1' });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(20 * 60);
    const ok = cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })), dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
    expect(ok).toBe(true);
  });

  it('updates a localization with optimistic concurrency and verifies', async () => {
    const ctx = makeCtx(server, creds);
    const attrs: Record<string, string> = { promotionalText: 'Old promo', keywords: 'a,b' };
    server.on('GET', '/v1/appStoreVersionLocalizations/loc1', () => ({ json: { data: { id: 'loc1', attributes: { ...attrs, locale: 'en-US' } } } }));
    server.on('PATCH', '/v1/appStoreVersionLocalizations/loc1', (req) => {
      Object.assign(attrs, (req.json as any).data.attributes);
      return { json: { data: { id: 'loc1', attributes: attrs } } };
    });
    const e = exec('store.app_store.update_localization');
    const p = { localizationId: 'loc1', fields: { promotionalText: 'New promo' }, previousFields: { promotionalText: 'Old promo' } };
    const r = await e.execute(ctx, p, meta);
    expect((server.find('PATCH', '/v1/appStoreVersionLocalizations/loc1')[0]!.json as any).data.type).toBe('appStoreVersionLocalizations');
    expect((await e.verify(ctx, p, r.receipt)).verdict).toBe('VERIFIED');
    await e.rollback!(ctx, p, r.receipt, r.beforeState);
    expect(attrs.promotionalText).toBe('Old promo');
    const stale = await e.execute(ctx, { ...p, previousFields: { promotionalText: 'something else' } }, meta).catch((x) => x);
    expect(stale.phase).toBe('rejected');
  });

  it('downloads and parses a gzip sales report', async () => {
    const ctx = makeCtx(server, creds);
    server.on('GET', '/v1/salesReports', (req) => {
      expect(req.query.get('filter[vendorNumber]')).toBe('8888');
      return { headers: { 'content-type': 'application/a-gzip' }, body: gzipSync('Provider\tUnits\nAPPLE\t12\n') };
    });
    const rep = await fetchSalesReport(ctx, '2026-10-18');
    expect(rep.header).toEqual(['Provider', 'Units']);
    expect(rep.rows).toEqual([['APPLE', '12']]);
  });
});

describe('Resend', () => {
  it('sends with an idempotency key and one-click unsubscribe headers; verification maps delivery events', async () => {
    const ctx = makeCtx(server, { provider: 'resend', apiKey: 're_test' });
    server.on('POST', '/emails', { json: { id: 'em_1' } });
    let ev = 'sent';
    server.on('GET', '/emails/em_1', () => ({ json: { id: 'em_1', last_event: ev } }));
    const e = exec('email.send');
    const p = { from: 'News <news@brand.example>', to: 'a@example.com', subject: 'Hi', html: null, text: 'Hello', unsubscribeUrl: 'https://app.example/u/tok', messageId: '00000000-0000-4000-8000-000000000123' };
    const r = await e.execute(ctx, p, meta);
    const sent = server.find('POST', '/emails')[0]!;
    expect(sent.headers['idempotency-key']).toBe(meta.idempotencyKey);
    expect((sent.json as any).headers).toEqual({ 'List-Unsubscribe': '<https://app.example/u/tok>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect((await e.verify(ctx, p, r.receipt)).verdict).toBe('PENDING');
    ev = 'delivered';
    expect((await e.verify(ctx, p, r.receipt)).verdict).toBe('VERIFIED');
    ev = 'bounced';
    expect((await e.verify(ctx, p, r.receipt)).verdict).toBe('MISMATCH');
  });
});
