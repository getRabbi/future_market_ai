import { sha256Hex } from '@futuregrow/observability';
import { type HttpClient, type HttpResponse, ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type CampaignSnapshot, type ConnectorContext, compareProof, type HealthResult, type ReadConnector, type SpendRow } from '../types.js';
import { majorToMicros } from './money.js';

/* --------------------------- OAuth 2.0 (shared by Ads/YouTube/Search Console) --------------------------- */

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function googleAccessToken(http: HttpClient, tokenUrl: string, c: { clientId: string; clientSecret: string; refreshToken: string }): Promise<string> {
  const cacheKey = sha256Hex(`${c.clientId}:${c.refreshToken}`);
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  try {
    const res = await http.request<{ access_token: string; expires_in: number; scope?: string }>({
      method: 'POST',
      url: tokenUrl,
      form: { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' },
      idempotent: true,
    });
    tokenCache.set(cacheKey, { token: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 });
    return res.data.access_token;
  } catch (err) {
    if (err instanceof ProviderHttpError && err.status === 400) {
      // invalid_grant => refresh token revoked/expired: re-authorization required.
      throw new ProviderHttpError('google refresh token rejected (re-authorization required)', { status: 401, phase: 'before_send', body: err.body });
    }
    throw err;
  }
}

export function clearGoogleTokenCache(): void {
  tokenCache.clear();
}

/* --------------------------- Google Ads --------------------------- */

type AdsCreds = Extract<ConnectorContext['credentials'], { provider: 'google_ads' }>;

function adsCreds(ctx: ConnectorContext): AdsCreds {
  if (ctx.credentials.provider !== 'google_ads') throw new Error('google_ads credentials required');
  return ctx.credentials;
}

async function adsHeaders(ctx: ConnectorContext): Promise<Record<string, string>> {
  const c = adsCreds(ctx);
  const token = await preWrite(() => googleAccessToken(ctx.http, ctx.endpoints.googleOAuth, c));
  const h: Record<string, string> = { authorization: `Bearer ${token}` };
  if (c.loginCustomerId) h['login-customer-id'] = c.loginCustomerId;
  // D-003: since 2026-09-09 the developer token is optional and ignored; send only if configured.
  if (c.developerToken) h['developer-token'] = c.developerToken;
  return h;
}

function adsUrl(ctx: ConnectorContext, path: string): string {
  return `${ctx.endpoints.googleAds.replace(/\/$/, '')}/${ctx.versions.googleAds}/${path}`;
}

export async function gaqlSearch<T>(ctx: ConnectorContext, customerId: string, query: string): Promise<T[]> {
  const headers = await adsHeaders(ctx);
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res: HttpResponse<{ results?: T[]; nextPageToken?: string }> = await ctx.http.request({
      method: 'POST',
      url: adsUrl(ctx, `customers/${customerId}/googleAds:search`),
      headers,
      json: pageToken ? { query, pageToken } : { query },
      idempotent: true,
    });
    out.push(...(res.data.results ?? []));
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

async function mutate(ctx: ConnectorContext, customerId: string, service: 'campaignBudgets' | 'campaigns', operation: Record<string, unknown>, validateOnly: boolean) {
  const headers = await adsHeaders(ctx);
  return ctx.http.request<{ results?: { resourceName: string }[] }>({
    method: 'POST',
    url: adsUrl(ctx, `customers/${customerId}/${service}:mutate`),
    headers,
    json: { operations: [operation], validateOnly },
    idempotent: false,
  });
}

interface AdsMoney {
  amountMicros: number;
  currency: string;
}

async function assertCurrency(ctx: ConnectorContext, customerId: string, currency: string) {
  const rows = await gaqlSearch<{ customer: { currencyCode: string } }>(ctx, customerId, 'SELECT customer.currency_code FROM customer');
  const actual = rows[0]?.customer.currencyCode;
  if (actual !== currency) {
    throw new ProviderHttpError(`account currency is ${actual ?? 'unknown'}, action expects ${currency}`, { status: null, phase: 'rejected' });
  }
}

async function readBudgetMicros(ctx: ConnectorContext, customerId: string, budgetId: string): Promise<number | null> {
  const rows = await gaqlSearch<{ campaignBudget: { amountMicros?: string } }>(ctx, customerId, `SELECT campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.id = ${budgetId}`);
  const v = rows[0]?.campaignBudget.amountMicros;
  return v === undefined ? null : Number(v);
}

interface BudgetParams {
  customerId: string;
  campaignBudgetId: string;
  newDailyBudget: AdsMoney;
  previousDailyBudget: AdsMoney;
}

function budgetOp(p: BudgetParams, micros: number) {
  return {
    updateMask: 'amountMicros',
    update: { resourceName: `customers/${p.customerId}/campaignBudgets/${p.campaignBudgetId}`, amountMicros: String(micros) },
  };
}

export const googleUpdateCampaignBudget: ActionExecutor<BudgetParams> = {
  actionType: 'ads.google.update_campaign_budget',
  provider: 'google_ads',
  async execute(ctx, p) {
    const before = await preWrite(async () => {
      await assertCurrency(ctx, p.customerId, p.newDailyBudget.currency);
      const current = await readBudgetMicros(ctx, p.customerId, p.campaignBudgetId);
      if (current !== p.previousDailyBudget.amountMicros) {
        throw new ProviderHttpError(`precondition failed: budget is ${current} micros, expected ${p.previousDailyBudget.amountMicros}`, { status: null, phase: 'rejected' });
      }
      // Provider-side dry run (validateOnly) before the real mutation.
      await mutate(ctx, p.customerId, 'campaignBudgets', budgetOp(p, p.newDailyBudget.amountMicros), true);
      return { amountMicros: current };
    });
    const res = await mutate(ctx, p.customerId, 'campaignBudgets', budgetOp(p, p.newDailyBudget.amountMicros), false);
    const rn = res.data.results?.[0]?.resourceName ?? null;
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: rn, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: {} },
      beforeState: before,
      rawResponse: res.data,
    };
  },
  async verify(ctx, p) {
    const current = await readBudgetMicros(ctx, p.customerId, p.campaignBudgetId);
    return compareProof('read_after_write', { amountMicros: p.newDailyBudget.amountMicros }, { amountMicros: current }, ctx.now());
  },
  async rollback(ctx, p) {
    const res = await mutate(ctx, p.customerId, 'campaignBudgets', budgetOp(p, p.previousDailyBudget.amountMicros), false);
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: res.data.results?.[0]?.resourceName ?? null, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { rollback: true } },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verifyRollback(ctx, p) {
    const current = await readBudgetMicros(ctx, p.customerId, p.campaignBudgetId);
    return compareProof('read_after_write', { amountMicros: p.previousDailyBudget.amountMicros }, { amountMicros: current }, ctx.now());
  },
};

interface StatusParams {
  customerId: string;
  campaignId: string;
  status: 'PAUSED' | 'ENABLED';
  previousStatus: 'PAUSED' | 'ENABLED';
}

async function readCampaignStatus(ctx: ConnectorContext, customerId: string, campaignId: string): Promise<string | null> {
  const rows = await gaqlSearch<{ campaign: { status?: string } }>(ctx, customerId, `SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id = ${campaignId}`);
  return rows[0]?.campaign.status ?? null;
}

const statusOp = (p: StatusParams, status: string) => ({
  updateMask: 'status',
  update: { resourceName: `customers/${p.customerId}/campaigns/${p.campaignId}`, status },
});

export const googleSetCampaignStatus: ActionExecutor<StatusParams> = {
  actionType: 'ads.google.set_campaign_status',
  provider: 'google_ads',
  async execute(ctx, p) {
    const before = await preWrite(async () => {
      const current = await readCampaignStatus(ctx, p.customerId, p.campaignId);
      if (current !== p.previousStatus) {
        throw new ProviderHttpError(`precondition failed: status is ${current}, expected ${p.previousStatus}`, { status: null, phase: 'rejected' });
      }
      await mutate(ctx, p.customerId, 'campaigns', statusOp(p, p.status), true);
      return { status: current };
    });
    const res = await mutate(ctx, p.customerId, 'campaigns', statusOp(p, p.status), false);
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: res.data.results?.[0]?.resourceName ?? null, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: {} },
      beforeState: before,
      rawResponse: res.data,
    };
  },
  async verify(ctx, p) {
    return compareProof('read_after_write', { status: p.status }, { status: await readCampaignStatus(ctx, p.customerId, p.campaignId) }, ctx.now());
  },
  async rollback(ctx, p) {
    const res = await mutate(ctx, p.customerId, 'campaigns', statusOp(p, p.previousStatus), false);
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: res.data.results?.[0]?.resourceName ?? null, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { rollback: true } },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verifyRollback(ctx, p) {
    return compareProof('read_after_write', { status: p.previousStatus }, { status: await readCampaignStatus(ctx, p.customerId, p.campaignId) }, ctx.now());
  },
};

export const googleAdsRead: ReadConnector = {
  provider: 'google_ads',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const headers = await adsHeaders(ctx);
      const res = await ctx.http.request<{ resourceNames?: string[] }>({
        method: 'GET',
        url: adsUrl(ctx, 'customers:listAccessibleCustomers'),
        headers,
        idempotent: true,
      });
      const accessible = (res.data.resourceNames ?? []).map((r) => r.split('/')[1]);
      const ok = accessible.includes(ctx.connection.externalAccountId) || Boolean(adsCreds(ctx).loginCustomerId);
      return { healthy: ok, status: ok ? 'healthy' : 'degraded', grantedScopes: null, details: { accessibleCount: accessible.length } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
  async listCampaigns(ctx): Promise<CampaignSnapshot[]> {
    const cid = ctx.connection.externalAccountId;
    const [cur] = await gaqlSearch<{ customer: { currencyCode: string } }>(ctx, cid, 'SELECT customer.currency_code FROM customer');
    const rows = await gaqlSearch<{
      campaign: { id: string; name: string; status: string; advertisingChannelType?: string };
      campaignBudget?: { id?: string; amountMicros?: string };
    }>(ctx, cid, "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.id, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'");
    return rows.map((r) => ({
      externalCampaignId: r.campaign.id,
      externalBudgetId: r.campaignBudget?.id ?? null,
      name: r.campaign.name,
      status: r.campaign.status,
      dailyBudgetMicros: r.campaignBudget?.amountMicros ? Number(r.campaignBudget.amountMicros) : null,
      currency: cur?.customer.currencyCode ?? null,
      objective: r.campaign.advertisingChannelType ?? null,
      raw: r as unknown as Record<string, unknown>,
    }));
  },
  async fetchSpend(ctx, from, to): Promise<SpendRow[]> {
    const cid = ctx.connection.externalAccountId;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('invalid date range');
    const [cur] = await gaqlSearch<{ customer: { currencyCode: string } }>(ctx, cid, 'SELECT customer.currency_code FROM customer');
    const rows = await gaqlSearch<{
      campaign: { id: string };
      segments: { date: string };
      metrics: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number; conversionsValue?: number };
    }>(ctx, cid, `SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}'`);
    return rows.map((r) => ({
      campaignRef: r.campaign.id,
      date: r.segments.date,
      currency: cur?.customer.currencyCode ?? 'XXX',
      costMicros: Number(r.metrics.costMicros ?? 0),
      impressions: Number(r.metrics.impressions ?? 0),
      clicks: Number(r.metrics.clicks ?? 0),
      conversions: Number(r.metrics.conversions ?? 0),
      conversionValueMicros: majorToMicros(Number(r.metrics.conversionsValue ?? 0)),
    }));
  },
};
