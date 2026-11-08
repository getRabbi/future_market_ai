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

/* --------------------------- Paid campaign creation (P3-06) --------------------------- */

export interface GoogleCreateCampaignParams {
  customerId: string;
  draftId: string;
  name: string;
  dailyBudget: AdsMoney;
  /** Customer time zone, yyyy-MM-dd (Campaign.start_date_time / end_date_time since v23). */
  startDate: string;
  endDate: string;
  geoTargetConstants: number[];
  languageConstants: number[];
  bidding: { strategy: 'MAXIMIZE_CLICKS' | 'MANUAL_CPC'; cpcBidCeiling: AdsMoney | null };
  adGroup: { name: string; cpcBid: AdsMoney | null };
  ad: { finalUrl: string; finalUrlSuffix: string | null; headlines: string[]; descriptions: string[]; path1: string | null; path2: string | null };
  keywords: { text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }[];
}

export const googleFgName = (p: Pick<GoogleCreateCampaignParams, 'name' | 'draftId'>) => `${p.name} [fg:${p.draftId.slice(0, 8)}]`;

const gaqlString = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

async function findCampaignByName(ctx: ConnectorContext, customerId: string, name: string) {
  const rows = await gaqlSearch<{ campaign: { resourceName: string; status: string } }>(ctx, customerId, `SELECT campaign.resource_name, campaign.status FROM campaign WHERE campaign.name = ${gaqlString(name)} AND campaign.status != 'REMOVED'`);
  return rows[0]?.campaign ?? null;
}

/** All operations of one campaign in a single atomic GoogleAdsService.Mutate (temporary ids -1…). */
export function createCampaignOperations(p: GoogleCreateCampaignParams) {
  const c = `customers/${p.customerId}`;
  const budget = `${c}/campaignBudgets/-1`;
  const campaign = `${c}/campaigns/-2`;
  const adGroup = `${c}/adGroups/-3`;
  const bidding = p.bidding.strategy === 'MAXIMIZE_CLICKS' ? { targetSpend: p.bidding.cpcBidCeiling ? { cpcBidCeilingMicros: String(p.bidding.cpcBidCeiling.amountMicros) } : {} } : { manualCpc: {} };
  return [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${googleFgName(p)} budget`, amountMicros: String(p.dailyBudget.amountMicros), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: googleFgName(p),
          status: 'PAUSED',
          advertisingChannelType: 'SEARCH',
          campaignBudget: budget,
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          startDateTime: `${p.startDate} 00:00:00`,
          endDateTime: `${p.endDate} 23:59:59`,
          containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          ...(p.ad.finalUrlSuffix ? { finalUrlSuffix: p.ad.finalUrlSuffix } : {}),
          ...bidding,
        },
      },
    },
    ...p.geoTargetConstants.map((g) => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${g}` } } } })),
    ...p.languageConstants.map((l) => ({ campaignCriterionOperation: { create: { campaign, language: { languageConstant: `languageConstants/${l}` } } } })),
    { adGroupOperation: { create: { resourceName: adGroup, campaign, name: p.adGroup.name, status: 'ENABLED', type: 'SEARCH_STANDARD', ...(p.adGroup.cpcBid ? { cpcBidMicros: String(p.adGroup.cpcBid.amountMicros) } : {}) } } },
    ...p.keywords.map((k) => ({ adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword: { text: k.text, matchType: k.matchType } } } })),
    {
      adGroupAdOperation: {
        create: {
          adGroup,
          status: 'ENABLED',
          ad: { finalUrls: [p.ad.finalUrl], responsiveSearchAd: { headlines: p.ad.headlines.map((text) => ({ text })), descriptions: p.ad.descriptions.map((text) => ({ text })), ...(p.ad.path1 ? { path1: p.ad.path1 } : {}), ...(p.ad.path2 ? { path2: p.ad.path2 } : {}) } },
        },
      },
    },
  ];
}

/**
 * Creates a Search campaign PAUSED (with its budget, targeting, ad group, keywords and responsive
 * search ad) in one atomic mutate after a validate-only pass, so either everything exists or
 * nothing does. Activation is a separate approved status change. A retry after an ambiguous
 * failure finds the tagged campaign instead of creating a second one.
 */
export const googleCreateCampaign: ActionExecutor<GoogleCreateCampaignParams> = {
  actionType: 'ads.google.create_campaign',
  provider: 'google_ads',
  async execute(ctx, p) {
    await preWrite(() => assertCurrency(ctx, p.customerId, p.dailyBudget.currency));
    const existing = await preWrite(() => findCampaignByName(ctx, p.customerId, googleFgName(p)));
    if (existing) {
      return { receipt: { providerRequestId: null, providerObjectId: existing.resourceName, httpStatus: 200, responseSha256: '', observedAt: ctx.now().toISOString(), details: { replayed: true } }, beforeState: null, rawResponse: { existing } };
    }
    const headers = await adsHeaders(ctx);
    const body = (validateOnly: boolean) => ({ mutateOperations: createCampaignOperations(p), partialFailure: false, validateOnly });
    await preWrite(() => ctx.http.request({ method: 'POST', url: adsUrl(ctx, `customers/${p.customerId}/googleAds:mutate`), headers, json: body(true), idempotent: true }));
    const res = await ctx.http.request<{ mutateOperationResponses?: Record<string, { resourceName?: string }>[] }>({ method: 'POST', url: adsUrl(ctx, `customers/${p.customerId}/googleAds:mutate`), headers, json: body(false), idempotent: false });
    const results = res.data.mutateOperationResponses ?? [];
    const pick = (key: string) => results.map((r) => r[key]?.resourceName).filter((x): x is string => Boolean(x));
    const campaign = pick('campaignResult')[0];
    if (!campaign) throw new ProviderHttpError('google ads returned no campaign resource name', { status: res.status, phase: 'ambiguous', body: res.data });
    return {
      receipt: {
        providerRequestId: res.requestId,
        providerObjectId: campaign,
        httpStatus: res.status,
        responseSha256: res.sha256,
        observedAt: ctx.now().toISOString(),
        details: { budget: pick('campaignBudgetResult')[0] ?? null, adGroup: pick('adGroupResult')[0] ?? null, ads: pick('adGroupAdResult'), keywords: pick('adGroupCriterionResult').length, criteria: pick('campaignCriterionResult').length },
      },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verify(ctx, p, receipt) {
    const rows = await gaqlSearch<{ campaign: { name: string; status: string; advertisingChannelType: string }; campaignBudget: { amountMicros: string } }>(
      ctx,
      p.customerId,
      `SELECT campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.resource_name = ${gaqlString(receipt.providerObjectId!)}`,
    );
    const ads = await gaqlSearch<{ adGroupAd: { status: string } }>(ctx, p.customerId, `SELECT ad_group_ad.status FROM ad_group_ad WHERE campaign.resource_name = ${gaqlString(receipt.providerObjectId!)}`);
    const r = rows[0];
    return compareProof(
      'read_after_write',
      { name: googleFgName(p), status: 'PAUSED', channel: 'SEARCH', budgetMicros: String(p.dailyBudget.amountMicros), ads: 1 },
      { name: r?.campaign.name ?? null, status: r?.campaign.status ?? null, channel: r?.campaign.advertisingChannelType ?? null, budgetMicros: r?.campaignBudget.amountMicros ?? null, ads: ads.length },
      ctx.now(),
    );
  },
  async rollback(ctx, p, receipt) {
    const res = await mutate(ctx, p.customerId, 'campaigns', { remove: receipt.providerObjectId }, false);
    return { receipt: { providerRequestId: res.requestId, providerObjectId: receipt.providerObjectId, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: {} }, beforeState: null, rawResponse: res.data };
  },
  async verifyRollback(ctx, p, receipt) {
    const rows = await gaqlSearch<{ campaign: { status: string } }>(ctx, p.customerId, `SELECT campaign.status FROM campaign WHERE campaign.resource_name = ${gaqlString(receipt.providerObjectId!)}`);
    return compareProof('read_after_write', { status: 'REMOVED' }, { status: rows[0]?.campaign.status ?? 'REMOVED' }, ctx.now());
  },
};
