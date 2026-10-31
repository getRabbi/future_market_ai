import { hmacSha256Hex } from '@futuregrow/observability';
import { type HttpResponse, ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type CampaignSnapshot, type ConnectorContext, compareProof, type ExecuteResult, type HealthResult, proof, type ReadConnector, type SpendRow } from '../types.js';
import { majorToMicros, metaMinorUnitOffset, microsToMinor, minorToMicros } from './money.js';

type MetaCreds = Extract<ConnectorContext['credentials'], { provider: 'meta' }>;

function creds(ctx: ConnectorContext): MetaCreds {
  if (ctx.credentials.provider !== 'meta') throw new Error('meta credentials required');
  return ctx.credentials;
}

/**
 * Page calls (posts, comments, Instagram) need a Page token; ad account calls need a user or
 * system-user token, which a Page token cannot replace. `adsAccessToken` carries the latter.
 */
type TokenUse = 'page' | 'ads';

function tokenFor(ctx: ConnectorContext, as: TokenUse): string {
  const c = creds(ctx);
  return as === 'ads' ? (c.adsAccessToken ?? c.accessToken) : c.accessToken;
}

/** The form suggests `act_123…`; older connections hold the bare number. */
function adAccountPath(ctx: ConnectorContext): string {
  return `act_${String(ctx.connection.metadata.adAccountId ?? ctx.connection.externalAccountId).replace(/^act_/, '')}`;
}

function graphUrl(ctx: ConnectorContext, path: string, query: Record<string, string>, token: string): string {
  const c = creds(ctx);
  const u = new URL(`${ctx.endpoints.metaGraph.replace(/\/$/, '')}/${ctx.versions.meta}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  if (c.appSecret) u.searchParams.set('appsecret_proof', hmacSha256Hex(c.appSecret, token));
  return u.toString();
}

async function graph<T>(ctx: ConnectorContext, method: 'GET' | 'POST' | 'DELETE', path: string, opts: { query?: Record<string, string>; form?: Record<string, string>; as?: TokenUse } = {}): Promise<HttpResponse<T>> {
  const token = tokenFor(ctx, opts.as ?? 'page');
  try {
    return await ctx.http.request<T>({
      method,
      url: graphUrl(ctx, path, opts.query ?? {}, token),
      headers: { authorization: `Bearer ${token}` },
      ...(opts.form ? { form: opts.form } : {}),
      idempotent: method === 'GET',
    });
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      const e = (err.body as { error?: { code?: number; message?: string } } | undefined)?.error;
      if (e?.code === 190) {
        throw new ProviderHttpError(`meta token invalid: ${e.message ?? ''}`, { status: 401, phase: 'rejected', body: err.body, providerRequestId: err.providerRequestId });
      }
    }
    throw err;
  }
}

async function graphOrNull<T>(ctx: ConnectorContext, path: string, query: Record<string, string>): Promise<T | null> {
  try {
    return (await graph<T>(ctx, 'GET', path, { query })).data;
  } catch (err) {
    if (err instanceof ProviderHttpError && err.status !== null && [400, 404].includes(err.status)) {
      const code = (err.body as { error?: { code?: number } } | undefined)?.error?.code;
      if (code === 100 || err.status === 404) return null; // object does not exist / not visible
    }
    throw err;
  }
}

const receiptOf = (ctx: ConnectorContext, res: HttpResponse, objectId: string | null, details: Record<string, unknown> = {}) => ({
  providerRequestId: res.requestId,
  providerObjectId: objectId,
  httpStatus: res.status,
  responseSha256: res.sha256,
  observedAt: ctx.now().toISOString(),
  details,
});

/* --------------------------- Facebook Page post --------------------------- */

interface FbPostParams {
  pageId: string;
  message: string;
  link?: string;
}

export const facebookPublishPost: ActionExecutor<FbPostParams> = {
  actionType: 'social.facebook.publish_post',
  provider: 'meta',
  async execute(ctx, p) {
    const form: Record<string, string> = { message: p.message };
    if (p.link) form.link = p.link;
    const res = await graph<{ id: string }>(ctx, 'POST', `${p.pageId}/feed`, { form });
    if (!res.data?.id) throw new ProviderHttpError('meta returned no post id', { status: res.status, phase: 'ambiguous', body: res.data });
    return { receipt: receiptOf(ctx, res, res.data.id), beforeState: null, rawResponse: res.data };
  },
  async verify(ctx, p, receipt) {
    const post = await graphOrNull<{ id: string; message?: string; is_published?: boolean; permalink_url?: string }>(ctx, receipt.providerObjectId!, {
      fields: 'id,message,is_published,permalink_url,created_time',
    });
    if (!post) return proof('PENDING', 'read_after_write', { exists: true }, { exists: false }, ctx.now(), 'post not yet readable (eventual consistency)');
    return compareProof('read_after_write', { id: receipt.providerObjectId, message: p.message, is_published: true }, { id: post.id, message: post.message, is_published: post.is_published, permalink_url: post.permalink_url }, ctx.now());
  },
  async rollback(ctx, _p, receipt) {
    const res = await graph<{ success: boolean }>(ctx, 'DELETE', receipt.providerObjectId!);
    return { receipt: receiptOf(ctx, res, receipt.providerObjectId, { deleted: res.data?.success === true }), beforeState: null, rawResponse: res.data };
  },
  async verifyRollback(ctx, _p, receipt) {
    const post = await graphOrNull<{ id: string }>(ctx, receipt.providerObjectId!, { fields: 'id' });
    return post ? proof('MISMATCH', 'read_after_write', { exists: false }, { exists: true }, ctx.now()) : proof('VERIFIED', 'read_after_write', { exists: false }, { exists: false }, ctx.now());
  },
};

/* --------------------------- Facebook comment reply --------------------------- */

export const facebookReplyComment: ActionExecutor<{ commentId: string; message: string }> = {
  actionType: 'social.facebook.reply_comment',
  provider: 'meta',
  async execute(ctx, p) {
    const res = await graph<{ id: string }>(ctx, 'POST', `${p.commentId}/comments`, { form: { message: p.message } });
    if (!res.data?.id) throw new ProviderHttpError('meta returned no comment id', { status: res.status, phase: 'ambiguous', body: res.data });
    return { receipt: receiptOf(ctx, res, res.data.id), beforeState: null, rawResponse: res.data };
  },
  async verify(ctx, p, receipt) {
    const c = await graphOrNull<{ id: string; message?: string }>(ctx, receipt.providerObjectId!, { fields: 'id,message' });
    if (!c) return proof('PENDING', 'read_after_write', { exists: true }, { exists: false }, ctx.now());
    return compareProof('read_after_write', { message: p.message }, { message: c.message }, ctx.now());
  },
  async rollback(ctx, _p, receipt) {
    const res = await graph<{ success: boolean }>(ctx, 'DELETE', receipt.providerObjectId!);
    return { receipt: receiptOf(ctx, res, receipt.providerObjectId), beforeState: null, rawResponse: res.data };
  },
  async verifyRollback(ctx, _p, receipt) {
    const c = await graphOrNull<{ id: string }>(ctx, receipt.providerObjectId!, { fields: 'id' });
    return c ? proof('MISMATCH', 'read_after_write', { exists: false }, { exists: true }, ctx.now()) : proof('VERIFIED', 'read_after_write', { exists: false }, { exists: false }, ctx.now());
  },
};

/* --------------------------- Instagram publishing --------------------------- */

interface IgParams {
  igUserId: string;
  mediaType: 'IMAGE' | 'REELS';
  mediaUrl: string;
  caption: string;
}

export const instagramPublishMedia: ActionExecutor<IgParams> = {
  actionType: 'social.instagram.publish_media',
  provider: 'meta',
  async execute(ctx, p) {
    const form: Record<string, string> = { caption: p.caption };
    if (p.mediaType === 'IMAGE') form.image_url = p.mediaUrl;
    else {
      form.media_type = 'REELS';
      form.video_url = p.mediaUrl;
    }
    const container = await graph<{ id: string }>(ctx, 'POST', `${p.igUserId}/media`, { form });
    const containerId = container.data?.id;
    if (!containerId) throw new ProviderHttpError('instagram returned no container id', { status: container.status, phase: 'rejected', body: container.data });

    // Container processing is asynchronous; nothing is public until media_publish.
    let status = 'IN_PROGRESS';
    for (let i = 0; i < 30 && status === 'IN_PROGRESS'; i++) {
      if (i > 0) await ctx.sleep(Math.min(2000 * i, 10_000));
      const s = await graph<{ status_code?: string }>(ctx, 'GET', containerId, { query: { fields: 'status_code,status' } });
      status = s.data?.status_code ?? 'IN_PROGRESS';
    }
    if (status !== 'FINISHED') {
      throw new ProviderHttpError(`instagram container ${containerId} not publishable: ${status}`, { status: null, phase: 'rejected', body: { containerId, status } });
    }
    const pub = await graph<{ id: string }>(ctx, 'POST', `${p.igUserId}/media_publish`, { form: { creation_id: containerId } });
    if (!pub.data?.id) throw new ProviderHttpError('instagram returned no media id', { status: pub.status, phase: 'ambiguous', body: pub.data });
    return { receipt: receiptOf(ctx, pub, pub.data.id, { containerId }), beforeState: null, rawResponse: { container: container.data, publish: pub.data } };
  },
  async verify(ctx, p, receipt) {
    const m = await graphOrNull<{ id: string; caption?: string; media_type?: string; media_product_type?: string; permalink?: string }>(ctx, receipt.providerObjectId!, { fields: 'id,caption,media_type,media_product_type,permalink,timestamp' });
    if (!m) return proof('PENDING', 'status_poll', { exists: true }, { exists: false }, ctx.now());
    const kind = p.mediaType === 'REELS' ? 'REELS' : 'FEED';
    return compareProof('status_poll', { caption: p.caption, product: kind }, { caption: m.caption, product: m.media_product_type ?? (m.media_type === 'IMAGE' ? 'FEED' : m.media_type), permalink: m.permalink }, ctx.now());
  },
};

/* --------------------------- Campaign budget / status --------------------------- */

interface MetaMoney {
  amountMicros: number;
  currency: string;
}

interface MetaCampaign {
  id: string;
  name?: string;
  daily_budget?: string;
  status?: string;
  effective_status?: string;
  objective?: string;
}

async function readCampaign(ctx: ConnectorContext, campaignId: string): Promise<MetaCampaign> {
  const res = await graph<MetaCampaign>(ctx, 'GET', campaignId, { as: 'ads', query: { fields: 'id,name,daily_budget,status,effective_status,objective' } });
  return res.data;
}

export const metaUpdateCampaignBudget: ActionExecutor<{ campaignId: string; newDailyBudget: MetaMoney; previousDailyBudget: MetaMoney }> = {
  actionType: 'ads.meta.update_campaign_budget',
  provider: 'meta',
  async execute(ctx, p) {
    const offset = metaMinorUnitOffset(p.newDailyBudget.currency);
    const before = await preWrite(() => readCampaign(ctx, p.campaignId));
    const expectedPrev = String(microsToMinor(p.previousDailyBudget.amountMicros, offset));
    if (before.daily_budget !== expectedPrev) {
      // Optimistic concurrency: the world changed since the decision was made. Nothing was sent.
      throw new ProviderHttpError(`precondition failed: daily_budget is ${before.daily_budget ?? 'unset'}, expected ${expectedPrev}`, {
        status: null,
        phase: 'rejected',
        body: { before },
      });
    }
    const res = await graph<{ success: boolean }>(ctx, 'POST', p.campaignId, {
      as: 'ads',
      form: { daily_budget: String(microsToMinor(p.newDailyBudget.amountMicros, offset)) },
    });
    if (res.data?.success !== true) throw new ProviderHttpError('meta did not confirm budget update', { status: res.status, phase: 'ambiguous', body: res.data });
    return { receipt: receiptOf(ctx, res, p.campaignId), beforeState: { ...before }, rawResponse: res.data };
  },
  async verify(ctx, p) {
    const offset = metaMinorUnitOffset(p.newDailyBudget.currency);
    const c = await readCampaign(ctx, p.campaignId);
    return compareProof('read_after_write', { daily_budget: String(microsToMinor(p.newDailyBudget.amountMicros, offset)) }, { daily_budget: c.daily_budget, status: c.status }, ctx.now());
  },
  async rollback(ctx, p, receipt) {
    const offset = metaMinorUnitOffset(p.previousDailyBudget.currency);
    const res = await graph<{ success: boolean }>(ctx, 'POST', p.campaignId, {
      as: 'ads',
      form: { daily_budget: String(microsToMinor(p.previousDailyBudget.amountMicros, offset)) },
    });
    return { receipt: receiptOf(ctx, res, receipt.providerObjectId), beforeState: null, rawResponse: res.data };
  },
  async verifyRollback(ctx, p) {
    const offset = metaMinorUnitOffset(p.previousDailyBudget.currency);
    const c = await readCampaign(ctx, p.campaignId);
    return compareProof('read_after_write', { daily_budget: String(microsToMinor(p.previousDailyBudget.amountMicros, offset)) }, { daily_budget: c.daily_budget }, ctx.now());
  },
};

export const metaSetCampaignStatus: ActionExecutor<{ campaignId: string; status: 'PAUSED' | 'ACTIVE'; previousStatus: 'PAUSED' | 'ACTIVE' }> = {
  actionType: 'ads.meta.set_campaign_status',
  provider: 'meta',
  async execute(ctx, p) {
    const before = await preWrite(() => readCampaign(ctx, p.campaignId));
    if (before.status !== p.previousStatus) {
      throw new ProviderHttpError(`precondition failed: status is ${before.status}, expected ${p.previousStatus}`, { status: null, phase: 'rejected', body: { before } });
    }
    const res = await graph<{ success: boolean }>(ctx, 'POST', p.campaignId, { as: 'ads', form: { status: p.status } });
    if (res.data?.success !== true) throw new ProviderHttpError('meta did not confirm status update', { status: res.status, phase: 'ambiguous', body: res.data });
    return { receipt: receiptOf(ctx, res, p.campaignId), beforeState: { ...before }, rawResponse: res.data };
  },
  async verify(ctx, p) {
    const c = await readCampaign(ctx, p.campaignId);
    return compareProof('read_after_write', { status: p.status }, { status: c.status, effective_status: c.effective_status }, ctx.now());
  },
  async rollback(ctx, p, receipt) {
    const res = await graph<{ success: boolean }>(ctx, 'POST', p.campaignId, { as: 'ads', form: { status: p.previousStatus } });
    return { receipt: receiptOf(ctx, res, receipt.providerObjectId), beforeState: null, rawResponse: res.data };
  },
  async verifyRollback(ctx, p) {
    const c = await readCampaign(ctx, p.campaignId);
    return compareProof('read_after_write', { status: p.previousStatus }, { status: c.status }, ctx.now());
  },
};

/* --------------------------- Read side --------------------------- */

interface TokenInfo {
  type?: string;
  app_id?: string;
  is_valid?: boolean;
  /** Unix seconds; 0 = never expires. */
  expires_at?: number;
  /** Unix seconds after which the token can no longer read data until the user authorizes again. */
  data_access_expires_at?: number;
  scopes?: string[];
}

/** debug_token on the token itself: type, expiry and scopes, also for Page tokens (which cannot list me/permissions). */
async function inspectToken(ctx: ConnectorContext, as: TokenUse): Promise<TokenInfo | null> {
  try {
    const res = await graph<{ data?: TokenInfo }>(ctx, 'GET', 'debug_token', { as, query: { input_token: tokenFor(ctx, as) } });
    return res.data?.data ?? null;
  } catch {
    return null; // advisory only: the reads decide health
  }
}

/** Scopes each feature needs; a missing one degrades the connection with the feature named. */
const PAGE_SCOPES: Record<string, string> = { pages_manage_posts: 'posts', pages_read_engagement: 'post verification', pages_manage_engagement: 'comment replies', pages_read_user_content: 'comment reading' };
const ADS_SCOPES: Record<string, string> = { ads_read: 'campaign and spend sync', ads_management: 'budget and status changes' };
/** Tokens closer than this to expiry are reported, so a short-lived token never silently breaks posting. */
const EXPIRY_WARNING_DAYS = 7;

function tokenWarnings(info: TokenInfo | null, label: string, needed: Record<string, string>, now: Date): string[] {
  if (!info) return [];
  const out: string[] = [];
  const missing = Object.keys(needed).filter((s) => info.scopes && !info.scopes.includes(s));
  if (missing.length) out.push(`${label} lacks ${missing.map((s) => `${s} (${needed[s]})`).join(', ')}`);
  const soon = (t: number | undefined) => Boolean(t) && t! * 1000 - now.getTime() < EXPIRY_WARNING_DAYS * 86_400_000;
  if (soon(info.expires_at)) out.push(`${label} expires ${new Date(info.expires_at! * 1000).toISOString()}; replace it with a long-lived token`);
  else if (soon(info.data_access_expires_at)) out.push(`${label} loses data access ${new Date(info.data_access_expires_at! * 1000).toISOString()}; the user must authorize the app again (system-user tokens do not lapse)`);
  return out;
}

const expiry = (info: TokenInfo | null) => (info?.expires_at === undefined ? undefined : info.expires_at === 0 ? 'never' : new Date(info.expires_at * 1000).toISOString());
const dataAccess = (info: TokenInfo | null) => (info?.data_access_expires_at ? new Date(info.data_access_expires_at * 1000).toISOString() : undefined);

export const metaRead: ReadConnector = {
  provider: 'meta',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const me = await graph<{ id: string; name?: string }>(ctx, 'GET', 'me', { query: { fields: 'id,name' } });
      const page = await inspectToken(ctx, 'page');
      let scopes: string[] | null = page?.scopes ?? null;
      if (!scopes) {
        try {
          const perms = await graph<{ data: { permission: string; status: string }[] }>(ctx, 'GET', 'me/permissions');
          scopes = perms.data.data.filter((x) => x.status === 'granted').map((x) => x.permission);
        } catch {
          scopes = null; // page tokens cannot list permissions; scope state stays as recorded
        }
      }
      const details: Record<string, unknown> = { id: me.data.id };
      if (page?.type) details.tokenType = page.type;
      if (expiry(page)) details.tokenExpiresAt = expiry(page);
      if (dataAccess(page)) details.tokenDataAccessUntil = dataAccess(page);
      const warnings: string[] = [];
      if (page?.type === 'PAGE' && me.data.id !== ctx.connection.externalAccountId) {
        // Posts would go to (or be refused for) a different Page than the one this connection names.
        return { healthy: false, status: 'failing', grantedScopes: scopes, details: { ...details, error: `the Page token belongs to Page ${me.data.id} (${me.data.name ?? 'unnamed'}), not ${ctx.connection.externalAccountId}` } };
      }
      if (page?.type && page.type !== 'PAGE') warnings.push(`the Page access token is a ${page.type} token; posts and replies need a Page token (GET /{page-id}?fields=access_token)`);
      warnings.push(...tokenWarnings(page, 'Page token', page?.type === 'PAGE' ? PAGE_SCOPES : {}, ctx.now()));
      if (page?.type === 'PAGE' && page.app_id) {
        // Comment webhooks arrive only while the Page is subscribed to this app's feed field.
        try {
          const subs = await graph<{ data: { id: string; subscribed_fields?: string[] }[] }>(ctx, 'GET', `${me.data.id}/subscribed_apps`);
          details.feedWebhook = subs.data.data.some((a) => a.id === page.app_id && (a.subscribed_fields ?? []).includes('feed'));
        } catch {
          /* needs pages_manage_metadata; informational only */
        }
      }
      if (creds(ctx).adsAccessToken || ctx.connection.metadata.adAccountId) {
        // Read the ad account now, so a token without ad access shows here and not at the first budget change.
        try {
          const acct = await graph<{ id: string; currency: string }>(ctx, 'GET', adAccountPath(ctx), { as: 'ads', query: { fields: 'id,currency' } });
          details.adAccount = `${acct.data.id} (${acct.data.currency})`;
        } catch (err) {
          const e = err as ProviderHttpError;
          const why = (e.body as { error?: { message?: string } } | undefined)?.error?.message ?? e.message;
          const hint = creds(ctx).adsAccessToken ? '' : ' (a Page token cannot read ad accounts; add an ads access token)';
          return { healthy: false, status: 'degraded', grantedScopes: scopes, details: { ...details, error: `ads: ${why}${hint}` } };
        }
        if (creds(ctx).adsAccessToken && creds(ctx).adsAccessToken !== creds(ctx).accessToken) {
          const ads = await inspectToken(ctx, 'ads');
          if (ads?.type) details.adsTokenType = ads.type;
          if (expiry(ads)) details.adsTokenExpiresAt = expiry(ads);
          if (dataAccess(ads)) details.adsTokenDataAccessUntil = dataAccess(ads);
          warnings.push(...tokenWarnings(ads, 'ads token', ADS_SCOPES, ctx.now()));
        }
      }
      if (warnings.length) return { healthy: false, status: 'degraded', grantedScopes: scopes, details: { ...details, warnings, error: warnings.join('; ') } };
      return { healthy: true, status: 'healthy', grantedScopes: scopes, details };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
  async listCampaigns(ctx): Promise<CampaignSnapshot[]> {
    const account = adAccountPath(ctx);
    const acct = await graph<{ currency: string }>(ctx, 'GET', account, { as: 'ads', query: { fields: 'currency' } });
    const offset = metaMinorUnitOffset(acct.data.currency);
    const out: CampaignSnapshot[] = [];
    let next: string | null = null;
    let path = `${account}/campaigns`;
    let query: Record<string, string> = { fields: 'id,name,status,daily_budget,objective', limit: '200' };
    for (let page = 0; page < 50; page++) {
      const res = await graph<{ data: MetaCampaign[]; paging?: { cursors?: { after?: string }; next?: string } }>(ctx, 'GET', path, { as: 'ads', query });
      for (const c of res.data.data) {
        out.push({
          externalCampaignId: c.id,
          externalBudgetId: null,
          name: c.name ?? c.id,
          status: c.status ?? 'UNKNOWN',
          dailyBudgetMicros: c.daily_budget ? minorToMicros(Number(c.daily_budget), offset) : null,
          currency: acct.data.currency,
          objective: c.objective ?? null,
          raw: c as unknown as Record<string, unknown>,
        });
      }
      next = res.data.paging?.next ? (res.data.paging.cursors?.after ?? null) : null;
      if (!next) break;
      path = `${account}/campaigns`;
      query = { ...query, after: next };
    }
    return out;
  },
  async fetchSpend(ctx, from, to): Promise<SpendRow[]> {
    const account = adAccountPath(ctx);
    const acct = await graph<{ currency: string }>(ctx, 'GET', account, { as: 'ads', query: { fields: 'currency' } });
    const res = await graph<{ data: { campaign_id: string; date_start: string; spend: string; impressions: string; clicks: string; actions?: { action_type: string; value: string }[]; action_values?: { action_type: string; value: string }[] }[] }>(ctx, 'GET', `${account}/insights`, {
      as: 'ads',
      query: {
        level: 'campaign',
        time_increment: '1',
        time_range: JSON.stringify({ since: from, until: to }),
        fields: 'campaign_id,date_start,spend,impressions,clicks,actions,action_values',
        limit: '500',
      },
    });
    return res.data.data.map((r) => ({
      campaignRef: r.campaign_id,
      date: r.date_start,
      currency: acct.data.currency,
      costMicros: majorToMicros(r.spend),
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      conversions: (r.actions ?? []).filter((a) => a.action_type === 'purchase').reduce((s, a) => s + Number(a.value), 0),
      conversionValueMicros: (r.action_values ?? []).filter((a) => a.action_type === 'purchase').reduce((s, a) => s + majorToMicros(a.value), 0),
    }));
  },
};

/* --------------------------- Organic Page insights --------------------------- */

/**
 * Daily organic Page metrics that Graph v26 still accepts (checked live 2026-10-31). The older
 * page_impressions*, page_engaged_users and page_fans* metrics are rejected as invalid.
 */
export const PAGE_INSIGHT_METRICS = ['page_post_engagements', 'page_daily_follows_unique', 'page_media_view', 'page_views_total'] as const;

export interface PageInsightMetricResult {
  /** `no_data`: Meta answered with no values (e.g. no read_insights grant, or a Page too small for insights). */
  status: 'ok' | 'no_data' | 'unsupported' | 'error';
  /** One value per completed day, oldest first. */
  values: { date: string; value: number }[];
  error?: string;
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Daily Page insights for the days `from`..`to` (inclusive, at most 88 days, so the padded query
 * stays inside Meta's 93-day since/until limit). Each metric is read
 * on its own so a metric Meta retires does not hide the others; an invalid token still throws.
 * Meta stamps a daily value with the end of that day in the Page's time zone, so a value belongs
 * to the day before its end_time. Days that have not ended yet are left out.
 */
export async function fetchPageInsights(ctx: ConnectorContext, from: string, to: string, metrics: readonly string[] = PAGE_INSIGHT_METRICS): Promise<Record<string, PageInsightMetricResult>> {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 87 * DAY_MS) throw new Error('page insights need a range of 1–88 days');
  const pageId = ctx.connection.externalAccountId;
  const now = ctx.now().getTime();
  const out: Record<string, PageInsightMetricResult> = {};
  for (const metric of metrics) {
    try {
      const res = await graph<{ data: { name: string; period: string; values: { value: unknown; end_time: string }[] }[] }>(ctx, 'GET', `${pageId}/insights`, {
        query: { metric, period: 'day', since: isoDay(start - DAY_MS), until: isoDay(end + 2 * DAY_MS) },
      });
      const byDay = new Map<string, number>();
      for (const v of res.data.data.find((d) => d.name === metric && d.period === 'day')?.values ?? []) {
        const endsAt = Date.parse(v.end_time);
        if (typeof v.value !== 'number' || !Number.isFinite(v.value) || !Number.isFinite(endsAt) || endsAt > now) continue;
        const date = isoDay(endsAt - DAY_MS);
        if (date >= from && date <= to) byDay.set(date, v.value);
      }
      const values = [...byDay].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
      out[metric] = { status: values.length ? 'ok' : 'no_data', values };
    } catch (err) {
      if (!(err instanceof ProviderHttpError) || err.status === 401) throw err;
      const e = (err.body as { error?: { code?: number; message?: string } } | undefined)?.error;
      out[metric] = { status: e?.code === 100 && /insights metric/i.test(e.message ?? '') ? 'unsupported' : 'error', values: [], error: e?.message ?? err.message };
    }
  }
  return out;
}

export type { ExecuteResult };
