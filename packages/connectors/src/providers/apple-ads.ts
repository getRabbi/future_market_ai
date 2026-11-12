import { createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorContext } from '../types.js';

export const APPLE_ADS_REPORT_URL = 'https://api.searchads.apple.com/api/v5/reports/campaigns';
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Metrics = z.object({
  date: day,
  impressions: z.number().int().nonnegative().nullable().optional(),
  taps: z.number().int().nonnegative().nullable().optional(),
  localSpend: z
    .object({ amount: z.string().regex(/^\d+(?:\.\d+)?$/), currency: z.string().regex(/^[A-Z]{3}$/) })
    .nullable()
    .optional(),
});
const Row = z.object({ metadata: z.object({ campaignId: id, campaignName: z.string().max(500), orgId: id, app: z.object({ adamId: id, appName: z.string().optional() }).optional(), campaignStatus: z.string().optional() }), granularity: z.array(Metrics).max(91).optional() });
const Envelope = z.object({
  data: z.object({ reportingDataResponse: z.object({ row: z.array(Row).max(1000) }) }),
  pagination: z.object({ totalResults: z.number().int().nonnegative(), startIndex: z.number().int().nonnegative(), itemsPerPage: z.number().int().nonnegative() }).optional(),
  error: z.unknown().nullable().optional(),
});
export type AppleAdsCampaignReport = { campaignRef: string; campaignId: string; orgId: string; name: string; appId: string | null; status: string | null; days: { date: string; impressions: number | null; taps: number | null; spend: { amount: string; currency: string } | null }[] };

export function appleAdsClientSecret(c: { clientId: string; teamId: string; keyId: string; privateKeyPem: string }, now: Date) {
  if (![c.clientId, c.teamId, c.keyId, c.privateKeyPem].every((v) => typeof v === 'string' && v.length > 0)) throw new Error('Apple Ads OAuth credentials missing');
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const iat = Math.floor(now.getTime() / 1000);
  const input = `${encode({ alg: 'ES256', kid: c.keyId })}.${encode({ iss: c.teamId, sub: c.clientId, aud: 'https://appleid.apple.com', iat, exp: iat + 300 })}`;
  const key = createPrivateKey(c.privateKeyPem);
  if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Apple Ads requires an EC P-256 private key');
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** Read-only reporting; no campaign creation, budget changes or AdServices writes. */
export async function fetchAppleAdsReport(ctx: ConnectorContext, start: string, end: string): Promise<AppleAdsCampaignReport[]> {
  const c = ctx.credentials;
  if (c.provider !== 'apple_ads') throw new Error('Apple Ads connection required');
  for (const value of [start, end]) if (!day.safeParse(value).success || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Invalid report date');
  const now = ctx.now();
  if (start > end || end >= now.toISOString().slice(0, 10) || Date.parse(start) < now.getTime() - 90 * 86400000) throw new Error('Request completed UTC days within the past 90 days');
  const orgId = ctx.connection.externalAccountId;
  if (!/^[1-9]\d{0,15}$/.test(orgId) || !Number.isSafeInteger(Number(orgId))) throw new Error('Apple Ads organization ID required');
  const tokenResponse = await ctx.http.request({ method: 'POST', url: 'https://appleid.apple.com/auth/oauth2/token', form: { grant_type: 'client_credentials', client_id: c.clientId, client_secret: appleAdsClientSecret(c, now), scope: 'searchadsorg' }, timeoutMs: 15000, maxResponseBytes: 64000 });
  const token = z.object({ access_token: z.string().min(1), token_type: z.literal('Bearer'), expires_in: z.number().positive() }).parse(tokenResponse.data);
  const campaigns = new Map<string, AppleAdsCampaignReport>();
  for (let offset = 0; offset < 20000; offset += 1000) {
    const response = await ctx.http.request({
      method: 'POST',
      url: APPLE_ADS_REPORT_URL,
      headers: { authorization: `Bearer ${token.access_token}`, 'X-AP-Context': `orgId=${orgId}` },
      json: { startTime: start, endTime: end, granularity: 'DAILY', timeZone: 'UTC', returnRecordsWithNoMetrics: true, returnRowTotals: false, returnGrandTotals: false, selector: { orderBy: [{ field: 'campaignId', sortOrder: 'ASCENDING' }], pagination: { offset, limit: 1000 } } },
      idempotent: true,
      timeoutMs: 20000,
      maxResponseBytes: 8000000,
    });
    const payload = Envelope.parse(response.data);
    if (payload.error) throw new Error('Apple Ads returned a reporting error');
    const rows = payload.data.reportingDataResponse.row;
    if (payload.pagination && payload.pagination.startIndex !== offset) throw new Error('Apple Ads pagination mismatch');
    for (const row of rows) {
      const m = row.metadata;
      if (String(m.orgId) !== orgId || campaigns.has(String(m.campaignId))) throw new Error('Apple Ads organization or pagination identity mismatch');
      const days = (row.granularity ?? []).map((r) => ({ date: r.date, impressions: r.impressions ?? null, taps: r.taps ?? null, spend: r.localSpend ?? null }));
      if (days.some((d) => d.date < start || d.date > end) || new Set(days.map((d) => d.date)).size !== days.length) throw new Error('Apple Ads report dates mismatch');
      campaigns.set(String(m.campaignId), { campaignRef: `apple_ads:${orgId}:${m.campaignId}`, campaignId: String(m.campaignId), orgId, name: m.campaignName, appId: m.app ? String(m.app.adamId) : null, status: m.campaignStatus ?? null, days });
    }
    if (payload.pagination ? offset + rows.length >= payload.pagination.totalResults : rows.length < 1000) return [...campaigns.values()];
    if (rows.length !== 1000) throw new Error('Apple Ads returned an incomplete page');
    await ctx.sleep(1000);
  }
  throw new Error('Apple Ads report exceeds bounded pagination; no partial report admitted');
}
