import { createHash, createPrivateKey, sign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type ConnectorContext, compareProof, type HealthResult, type ReadConnector } from '../types.js';

type AscCreds = Extract<ConnectorContext['credentials'], { provider: 'app_store_connect' }>;

function creds(ctx: ConnectorContext): AscCreds {
  if (ctx.credentials.provider !== 'app_store_connect') throw new Error('app_store_connect credentials required');
  return ctx.credentials;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** App Store Connect API token: ES256 JWT, max 20 minutes lifetime, audience appstoreconnect-v1. */
export function appStoreConnectJwt(c: { issuerId: string; keyId: string; privateKeyPem: string }, now = new Date()): string {
  const header = { alg: 'ES256', kid: c.keyId, typ: 'JWT' };
  const iat = Math.floor(now.getTime() / 1000);
  const payload = { iss: c.issuerId, iat, exp: iat + 19 * 60, aud: 'appstoreconnect-v1' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(c.privateKeyPem);
  const sig = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

function auth(ctx: ConnectorContext): Record<string, string> {
  return { authorization: `Bearer ${appStoreConnectJwt(creds(ctx), ctx.now())}` };
}

function url(ctx: ConnectorContext, path: string): string {
  return `${ctx.endpoints.appStoreConnect.replace(/\/$/, '')}/${ctx.versions.appStoreConnect}/${path}`;
}

type LocalizationFields = { description?: string; keywords?: string; promotionalText?: string; whatsNew?: string };

export async function readLocalization(ctx: ConnectorContext, id: string): Promise<LocalizationFields & { locale?: string }> {
  const res = await ctx.http.request<{ data: { attributes: LocalizationFields & { locale?: string } } }>({
    method: 'GET',
    url: url(ctx, `appStoreVersionLocalizations/${encodeURIComponent(id)}`),
    headers: auth(ctx),
    idempotent: true,
  });
  return res.data.data.attributes;
}

async function patchLocalization(ctx: ConnectorContext, id: string, attributes: LocalizationFields) {
  return ctx.http.request<{ data: { id: string; attributes: LocalizationFields } }>({
    method: 'PATCH',
    url: url(ctx, `appStoreVersionLocalizations/${encodeURIComponent(id)}`),
    headers: auth(ctx),
    json: { data: { type: 'appStoreVersionLocalizations', id, attributes } },
    idempotent: true, // PATCH to a fixed value is idempotent
  });
}

interface LocParams {
  localizationId: string;
  fields: LocalizationFields;
  previousFields: Record<string, string | null>;
}

const pick = (src: LocalizationFields, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (src as Record<string, string | undefined>)[k] ?? null]));

export const appStoreUpdateLocalization: ActionExecutor<LocParams> = {
  actionType: 'store.app_store.update_localization',
  provider: 'app_store_connect',
  async execute(ctx, p) {
    const keys = Object.keys(p.fields);
    const before = await preWrite(async () => {
      const cur = await readLocalization(ctx, p.localizationId);
      const now = pick(cur, keys);
      for (const k of keys) {
        if ((now[k] ?? null) !== (p.previousFields[k] ?? null)) {
          throw new ProviderHttpError(`precondition failed: ${k} changed since proposal`, { status: null, phase: 'rejected', body: { current: now } });
        }
      }
      return now;
    });
    const res = await patchLocalization(ctx, p.localizationId, p.fields);
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: p.localizationId, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { fields: keys } },
      beforeState: before,
      rawResponse: res.data,
    };
  },
  async verify(ctx, p) {
    const cur = await readLocalization(ctx, p.localizationId);
    return compareProof('read_after_write', p.fields as Record<string, unknown>, pick(cur, Object.keys(p.fields)), ctx.now());
  },
  async rollback(ctx, p, receipt, beforeState) {
    const prev = Object.fromEntries(Object.entries(beforeState ?? p.previousFields).filter(([, v]) => v !== null)) as LocalizationFields;
    const res = await patchLocalization(ctx, p.localizationId, prev);
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: receipt.providerObjectId, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { rollback: true } },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verifyRollback(ctx, p, _r, beforeState) {
    const cur = await readLocalization(ctx, p.localizationId);
    const expected = beforeState ?? p.previousFields;
    return compareProof('read_after_write', expected, pick(cur, Object.keys(expected)), ctx.now());
  },
};

/** Download a Sales & Trends report (gzip TSV) and return parsed rows. */
export async function fetchSalesReport(ctx: ConnectorContext, reportDate: string): Promise<{ header: string[]; rows: string[][]; bytes: Uint8Array }> {
  const c = creds(ctx);
  if (!c.vendorNumber) throw new Error('vendorNumber is required for sales reports');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error('invalid report date');
  const q = new URLSearchParams({
    'filter[frequency]': 'DAILY',
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': c.vendorNumber,
    'filter[reportDate]': reportDate,
  });
  const res = await ctx.http.request({
    method: 'GET',
    url: `${url(ctx, 'salesReports')}?${q.toString()}`,
    headers: { ...auth(ctx), accept: 'application/a-gzip' },
    binary: true,
    idempotent: true,
    maxResponseBytes: 50 * 1024 * 1024,
  });
  const text = gunzipSync(res.bytes).toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = (lines[0] ?? '').split('\t');
  return { header, rows: lines.slice(1).map((l) => l.split('\t')), bytes: res.bytes };
}

export const appStoreRead: ReadConnector = {
  provider: 'app_store_connect',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const res = await ctx.http.request<{ data: { id: string }[] }>({ method: 'GET', url: `${url(ctx, 'apps')}?limit=1`, headers: auth(ctx), idempotent: true });
      return { healthy: true, status: 'healthy', grantedScopes: null, details: { apps: res.data.data.length } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};

/* ------------------------------------------------------------------ */
/* App discovery and the Analytics Reports API (D-045)                  */
/* ------------------------------------------------------------------ */

interface JsonApiPage<A> {
  data?: { id?: string; attributes?: A }[];
  links?: { next?: string };
}

/** Follows `links.next` only within the configured App Store Connect origin. */
async function listAll<A>(ctx: ConnectorContext, first: string, maxPages = 20): Promise<{ id: string; attributes: A }[]> {
  const origin = new URL(ctx.endpoints.appStoreConnect).origin;
  const out: { id: string; attributes: A }[] = [];
  let next: string | undefined = first;
  for (let page = 0; next && page < maxPages; page++) {
    if (new URL(next).origin !== origin) throw new ProviderHttpError('App Store Connect pagination left the API origin', { status: null, phase: 'rejected' });
    const res: { data: JsonApiPage<A> } = await ctx.http.request<JsonApiPage<A>>({ method: 'GET', url: next, headers: auth(ctx), idempotent: true });
    for (const d of res.data.data ?? []) if (typeof d.id === 'string' && d.attributes) out.push({ id: d.id, attributes: d.attributes });
    next = res.data.links?.next;
  }
  return out;
}

/** Apps visible to the API key (`GET /v1/apps`). */
export async function listAscApps(ctx: ConnectorContext): Promise<{ id: string; bundleId: string; name: string | null }[]> {
  const rows = await listAll<{ bundleId?: string; name?: string }>(ctx, `${url(ctx, 'apps')}?fields[apps]=bundleId,name&limit=200`);
  return rows.filter((r) => /^\d{1,20}$/.test(r.id) && typeof r.attributes.bundleId === 'string').map((r) => ({ id: r.id, bundleId: r.attributes.bundleId!.slice(0, 200), name: r.attributes.name?.slice(0, 200) ?? null }));
}

export type AnalyticsAccessType = 'ONGOING' | 'ONE_TIME_SNAPSHOT';
export interface AnalyticsReportRequest {
  id: string;
  accessType: AnalyticsAccessType;
  stoppedDueToInactivity: boolean;
}

const ASC_ID = /^[A-Za-z0-9-]{1,100}$/;
const ascId = (id: string, what: string) => {
  if (!ASC_ID.test(id)) throw new Error(`invalid ${what} id`);
  return encodeURIComponent(id);
};

export async function listAnalyticsReportRequests(ctx: ConnectorContext, appResourceId: string): Promise<AnalyticsReportRequest[]> {
  const rows = await listAll<{ accessType?: string; stoppedDueToInactivity?: boolean }>(ctx, `${url(ctx, `apps/${ascId(appResourceId, 'app')}/analyticsReportRequests`)}?limit=200`);
  return rows.filter((r) => r.attributes.accessType === 'ONGOING' || r.attributes.accessType === 'ONE_TIME_SNAPSHOT').map((r) => ({ id: r.id, accessType: r.attributes.accessType as AnalyticsAccessType, stoppedDueToInactivity: r.attributes.stoppedDueToInactivity === true }));
}

/** `POST /v1/analyticsReportRequests`. Needs an Admin API key; Apple generates the first reports in 1–2 days. */
export async function createAnalyticsReportRequest(ctx: ConnectorContext, appResourceId: string, accessType: AnalyticsAccessType): Promise<AnalyticsReportRequest> {
  const res = await ctx.http.request<{ data?: { id?: string; attributes?: { accessType?: string; stoppedDueToInactivity?: boolean } } }>({
    method: 'POST',
    url: url(ctx, 'analyticsReportRequests'),
    headers: auth(ctx),
    json: { data: { type: 'analyticsReportRequests', attributes: { accessType }, relationships: { app: { data: { type: 'apps', id: appResourceId } } } } },
    idempotent: false,
  });
  const id = res.data.data?.id;
  if (!id) throw new ProviderHttpError('App Store Connect returned no report request id', { status: res.status, phase: 'ambiguous' });
  return { id, accessType, stoppedDueToInactivity: res.data.data?.attributes?.stoppedDueToInactivity === true };
}

export async function listAnalyticsReports(ctx: ConnectorContext, requestId: string): Promise<{ id: string; name: string; category: string }[]> {
  const rows = await listAll<{ name?: string; category?: string }>(ctx, `${url(ctx, `analyticsReportRequests/${ascId(requestId, 'report request')}/reports`)}?limit=200`);
  return rows.filter((r) => typeof r.attributes.name === 'string').map((r) => ({ id: r.id, name: r.attributes.name!.slice(0, 200), category: r.attributes.category ?? '' }));
}

export async function listReportInstances(ctx: ConnectorContext, reportId: string, granularity: 'DAILY' | 'WEEKLY' | 'MONTHLY'): Promise<{ id: string; granularity: string; processingDate: string }[]> {
  const rows = await listAll<{ granularity?: string; processingDate?: string }>(ctx, `${url(ctx, `analyticsReports/${ascId(reportId, 'report')}/instances`)}?filter[granularity]=${granularity}&limit=200`);
  return rows.filter((r) => typeof r.attributes.processingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.attributes.processingDate)).map((r) => ({ id: r.id, granularity: r.attributes.granularity ?? granularity, processingDate: r.attributes.processingDate! }));
}

export interface ReportSegment {
  id: string;
  url: string;
  checksum: string | null;
  sizeInBytes: number | null;
}

export async function listInstanceSegments(ctx: ConnectorContext, instanceId: string): Promise<ReportSegment[]> {
  const rows = await listAll<{ url?: string; checksum?: string; sizeInBytes?: number }>(ctx, `${url(ctx, `analyticsReportInstances/${ascId(instanceId, 'report instance')}/segments`)}?limit=200`);
  return rows.filter((r) => typeof r.attributes.url === 'string').map((r) => ({ id: r.id, url: r.attributes.url!, checksum: typeof r.attributes.checksum === 'string' ? r.attributes.checksum.toLowerCase() : null, sizeInBytes: typeof r.attributes.sizeInBytes === 'number' ? r.attributes.sizeInBytes : null }));
}

/**
 * Downloads one segment from its pre-signed URL. The API token is never sent there. Size and the
 * documented MD5 checksum are verified; the gzip body is expanded later with a bounded output size.
 */
export async function downloadReportSegment(ctx: ConnectorContext, seg: ReportSegment, maxBytes: number): Promise<Uint8Array> {
  const target = new URL(seg.url);
  const sameApi = target.origin === new URL(ctx.endpoints.appStoreConnect).origin;
  if (!sameApi && (target.protocol !== 'https:' || /^[\d.]+$|^\[|^localhost$/i.test(target.hostname))) throw new ProviderHttpError('report segment URL is not an https host', { status: null, phase: 'rejected' });
  if (seg.sizeInBytes !== null && seg.sizeInBytes > maxBytes) throw new ProviderHttpError(`report segment is ${seg.sizeInBytes} bytes, above the ${maxBytes}-byte import limit`, { status: 413, phase: 'rejected' });
  const res = await ctx.http.request({ method: 'GET', url: seg.url, headers: { accept: 'application/a-gzip, application/octet-stream' }, binary: true, idempotent: true, maxResponseBytes: maxBytes, timeoutMs: 120_000 });
  if (seg.sizeInBytes !== null && res.bytes.byteLength !== seg.sizeInBytes) throw new ProviderHttpError('report segment size mismatch', { status: 502, phase: 'rejected' });
  if (seg.checksum) {
    const md5 = createHash('md5').update(res.bytes).digest();
    if (seg.checksum !== md5.toString('hex') && seg.checksum !== md5.toString('base64').toLowerCase()) throw new ProviderHttpError('report segment checksum mismatch', { status: 502, phase: 'rejected' });
  }
  return res.bytes;
}
