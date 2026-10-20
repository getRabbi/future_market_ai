import { hmacSha256Hex } from '@futuregrow/observability';
import { type HttpResponse, ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type CampaignSnapshot, type ConnectorContext, compareProof, type ExecuteResult, type HealthResult, proof, type ReadConnector, type SpendRow } from '../types.js';
import { majorToMicros, metaMinorUnitOffset, microsToMinor, minorToMicros } from './money.js';

type MetaCreds = Extract<ConnectorContext['credentials'], { provider: 'meta' }>;

function creds(ctx: ConnectorContext): MetaCreds {
  if (ctx.credentials.provider !== 'meta') throw new Error('meta credentials required');
  return ctx.credentials;
}

function graphUrl(ctx: ConnectorContext, path: string, query: Record<string, string> = {}): string {
  const c = creds(ctx);
  const u = new URL(`${ctx.endpoints.metaGraph.replace(/\/$/, '')}/${ctx.versions.meta}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  if (c.appSecret) u.searchParams.set('appsecret_proof', hmacSha256Hex(c.appSecret, c.accessToken));
  return u.toString();
}

async function graph<T>(ctx: ConnectorContext, method: 'GET' | 'POST' | 'DELETE', path: string, opts: { query?: Record<string, string>; form?: Record<string, string> } = {}): Promise<HttpResponse<T>> {
  try {
    return await ctx.http.request<T>({
      method,
      url: graphUrl(ctx, path, opts.query),
      headers: { authorization: `Bearer ${creds(ctx).accessToken}` },
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
  const res = await graph<MetaCampaign>(ctx, 'GET', campaignId, { query: { fields: 'id,name,daily_budget,status,effective_status,objective' } });
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
    const res = await graph<{ success: boolean }>(ctx, 'POST', p.campaignId, { form: { status: p.status } });
    if (res.data?.success !== true) throw new ProviderHttpError('meta did not confirm status update', { status: res.status, phase: 'ambiguous', body: res.data });
    return { receipt: receiptOf(ctx, res, p.campaignId), beforeState: { ...before }, rawResponse: res.data };
  },
  async verify(ctx, p) {
    const c = await readCampaign(ctx, p.campaignId);
    return compareProof('read_after_write', { status: p.status }, { status: c.status, effective_status: c.effective_status }, ctx.now());
  },
  async rollback(ctx, p, receipt) {
    const res = await graph<{ success: boolean }>(ctx, 'POST', p.campaignId, { form: { status: p.previousStatus } });
    return { receipt: receiptOf(ctx, res, receipt.providerObjectId), beforeState: null, rawResponse: res.data };
  },
  async verifyRollback(ctx, p) {
    const c = await readCampaign(ctx, p.campaignId);
    return compareProof('read_after_write', { status: p.previousStatus }, { status: c.status }, ctx.now());
  },
};

/* --------------------------- Read side --------------------------- */

export const metaRead: ReadConnector = {
  provider: 'meta',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const me = await graph<{ id: string; name?: string }>(ctx, 'GET', 'me', { query: { fields: 'id,name' } });
      let scopes: string[] | null = null;
      try {
        const perms = await graph<{ data: { permission: string; status: string }[] }>(ctx, 'GET', 'me/permissions');
        scopes = perms.data.data.filter((x) => x.status === 'granted').map((x) => x.permission);
      } catch {
        scopes = null; // page tokens cannot list permissions; scope state stays as recorded
      }
      return { healthy: true, status: 'healthy', grantedScopes: scopes, details: { id: me.data.id } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
  async listCampaigns(ctx): Promise<CampaignSnapshot[]> {
    const account = String(ctx.connection.metadata.adAccountId ?? ctx.connection.externalAccountId);
    const acct = await graph<{ currency: string }>(ctx, 'GET', `act_${account}`, { query: { fields: 'currency' } });
    const offset = metaMinorUnitOffset(acct.data.currency);
    const out: CampaignSnapshot[] = [];
    let next: string | null = null;
    let path = `act_${account}/campaigns`;
    let query: Record<string, string> = { fields: 'id,name,status,daily_budget,objective', limit: '200' };
    for (let page = 0; page < 50; page++) {
      const res = await graph<{ data: MetaCampaign[]; paging?: { cursors?: { after?: string }; next?: string } }>(ctx, 'GET', path, { query });
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
      path = `act_${account}/campaigns`;
      query = { ...query, after: next };
    }
    return out;
  },
  async fetchSpend(ctx, from, to): Promise<SpendRow[]> {
    const account = String(ctx.connection.metadata.adAccountId ?? ctx.connection.externalAccountId);
    const acct = await graph<{ currency: string }>(ctx, 'GET', `act_${account}`, { query: { fields: 'currency' } });
    const res = await graph<{ data: { campaign_id: string; date_start: string; spend: string; impressions: string; clicks: string; actions?: { action_type: string; value: string }[]; action_values?: { action_type: string; value: string }[] }[] }>(ctx, 'GET', `act_${account}/insights`, {
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

export type { ExecuteResult };
