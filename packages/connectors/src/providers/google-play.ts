import { createHash, createPrivateKey, sign } from 'node:crypto';
import { sha256Hex } from '@futuregrow/observability';
import { ProviderHttpError } from '../http.js';
import type { ConnectorContext, HealthResult, ProviderCredentials, ReadConnector } from '../types.js';

/**
 * Google Play reporting, read-only (D-045).
 *
 * - Bulk reports: the developer account's private Cloud Storage bucket (`pubsite_prod_…`), read with
 *   the Cloud Storage JSON API. Google: "use OAuth2 server-to-server authentication with the scope
 *   https://www.googleapis.com/auth/devstorage.read_only"; the service account needs Play Console
 *   "View app information" set to Global (support.google.com/googleplay/android-developer/answer/6135870).
 * - App discovery and vitals: Play Developer Reporting API v1beta1 (`apps:search`,
 *   `{crash,anr}RateMetricSet:query`), scope https://www.googleapis.com/auth/playdeveloperreporting.
 *
 * Authentication is Google's documented service-account JWT bearer flow (RFC 7523) over the same
 * guarded HTTP client as every other connector, so requests stay size/time bounded, redacted and
 * fixture-testable. The private key never leaves the server process.
 */

export type PlayCreds = Extract<ProviderCredentials, { provider: 'google_play' }>;

export const PLAY_SCOPES = {
  storage: 'https://www.googleapis.com/auth/devstorage.read_only',
  reporting: 'https://www.googleapis.com/auth/playdeveloperreporting',
} as const;

const SERVICE_ACCOUNT_EMAIL = /^[a-z0-9][a-z0-9._-]{0,99}@[a-z0-9-]{1,63}\.iam\.gserviceaccount\.com$/;
const BUCKET = /^pubsite_prod_[a-z0-9_]{3,80}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

function creds(ctx: ConnectorContext): PlayCreds {
  if (ctx.credentials.provider !== 'google_play') throw new Error('google_play credentials required');
  return ctx.credentials;
}

/**
 * Validates a downloaded service-account key file. Only the fields the JWT flow needs are kept;
 * nothing from the key is echoed in errors.
 */
export function parseServiceAccountKey(raw: unknown): { clientEmail: string; privateKeyPem: string; privateKeyId: string | null; projectId: string | null } {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      throw new Error('the service account key is not valid JSON');
    }
  }
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.type !== 'service_account') throw new Error('the key file is not a Google service account key (type must be service_account)');
  const clientEmail = typeof o.client_email === 'string' ? o.client_email.trim().toLowerCase() : '';
  if (!SERVICE_ACCOUNT_EMAIL.test(clientEmail)) throw new Error('the key file has no valid service account client_email');
  const pem = typeof o.private_key === 'string' ? o.private_key : '';
  if (!pem.includes('-----BEGIN PRIVATE KEY-----')) throw new Error('the key file has no PKCS#8 private_key');
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
  } catch {
    throw new Error('the key file private_key is not a usable RSA key');
  }
  return {
    clientEmail,
    privateKeyPem: pem,
    privateKeyId: typeof o.private_key_id === 'string' && /^[a-f0-9]{8,64}$/i.test(o.private_key_id) ? o.private_key_id : null,
    projectId: typeof o.project_id === 'string' && /^[a-z][a-z0-9-]{4,62}$/.test(o.project_id) ? o.project_id : null,
  };
}

/** Accepts `pubsite_prod_rev_…`, `gs://pubsite_prod_rev_…/` or a copied object path. */
export function normalizeReportBucket(input: string): string {
  const trimmed = input
    .trim()
    .replace(/^gs:\/\//i, '')
    .split('/')[0]!
    .toLowerCase();
  if (!BUCKET.test(trimmed)) throw new Error('the Cloud Storage URI must be the Play Console report bucket (gs://pubsite_prod_…), copied from Download reports › Copy Cloud Storage URI');
  return trimmed;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Signed assertion for the token endpoint (Google OAuth 2.0 for server to server applications). */
export function serviceAccountAssertion(c: { clientEmail: string; privateKeyPem: string; privateKeyId?: string | null }, scopes: string[], audience: string, now: Date): string {
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (c.privateKeyId) header.kid = c.privateKeyId;
  const iat = Math.floor(now.getTime() / 1000);
  const payload = { iss: c.clientEmail, scope: scopes.join(' '), aud: audience, iat, exp: iat + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign('sha256', Buffer.from(input), createPrivateKey(c.privateKeyPem));
  return `${input}.${b64url(signature)}`;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function clearPlayTokenCache(): void {
  tokenCache.clear();
}

/** Access token for one scope set; cached per key and scope until a minute before expiry. */
export async function playAccessToken(ctx: ConnectorContext, scopes: string[]): Promise<string> {
  const c = creds(ctx);
  const cacheKey = sha256Hex(`${c.clientEmail}\u0000${sha256Hex(c.privateKeyPem)}\u0000${scopes.join(' ')}`);
  const now = ctx.now().getTime();
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > now + 60_000) return hit.token;
  try {
    const res = await ctx.http.request<{ access_token: string; expires_in: number }>({
      method: 'POST',
      url: ctx.endpoints.googleOAuth,
      form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(c, scopes, 'https://oauth2.googleapis.com/token', ctx.now()) },
      idempotent: true,
    });
    if (!res.data?.access_token) throw new ProviderHttpError('token endpoint returned no access token', { status: 502, phase: 'rejected' });
    tokenCache.set(cacheKey, { token: res.data.access_token, expiresAt: now + Math.max(60, Number(res.data.expires_in) || 0) * 1000 });
    return res.data.access_token;
  } catch (err) {
    if (err instanceof ProviderHttpError && (err.status === 400 || err.status === 401)) {
      // invalid_grant / invalid_client: deleted, disabled or rotated key.
      throw new ProviderHttpError('Google rejected the service account key (deleted, disabled or rotated)', { status: 401, phase: 'before_send', body: null });
    }
    throw err;
  }
}

async function authed(ctx: ConnectorContext, scope: string) {
  return { authorization: `Bearer ${await playAccessToken(ctx, [scope])}` };
}

/* ------------------------------------------------------------------ */
/* Cloud Storage bulk reports                                          */
/* ------------------------------------------------------------------ */

export interface ReportObject {
  name: string;
  generation: string;
  size: number;
  md5Hash: string | null;
  updated: string | null;
  contentType: string | null;
  contentEncoding: string | null;
}

/** Lists report objects under a prefix (e.g. `stats/installs/installs_com.example_`). */
export async function listReportObjects(ctx: ConnectorContext, bucket: string, prefix: string, opts: { maxPages?: number; partial?: boolean } = {}): Promise<ReportObject[]> {
  if (!BUCKET.test(bucket)) throw new Error('invalid report bucket');
  if (!/^[A-Za-z0-9_./-]{0,300}$/.test(prefix)) throw new Error('invalid report prefix');
  const out: ReportObject[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const q = new URLSearchParams({ prefix, maxResults: '1000', fields: 'items(name,generation,size,md5Hash,updated,contentType,contentEncoding),nextPageToken' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await ctx.http.request<{ items?: Record<string, unknown>[]; nextPageToken?: string }>({
      method: 'GET',
      url: `${ctx.endpoints.cloudStorage.replace(/\/$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/o?${q}`,
      headers: await authed(ctx, PLAY_SCOPES.storage),
      idempotent: true,
    });
    for (const i of res.data.items ?? []) {
      const name = typeof i.name === 'string' ? i.name : '';
      const generation = typeof i.generation === 'string' && /^\d{1,20}$/.test(i.generation) ? i.generation : '';
      if (!name || !generation) continue;
      out.push({
        name,
        generation,
        size: Number(i.size ?? 0),
        md5Hash: typeof i.md5Hash === 'string' ? i.md5Hash : null,
        updated: typeof i.updated === 'string' ? i.updated : null,
        contentType: typeof i.contentType === 'string' ? i.contentType : null,
        contentEncoding: typeof i.contentEncoding === 'string' ? i.contentEncoding : null,
      });
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken || (opts.partial && page + 1 >= (opts.maxPages ?? 20))) return out;
  }
  throw new ProviderHttpError('report listing exceeded the page limit', { status: null, phase: 'rejected' });
}

/** Downloads one object generation, checking size and MD5 against the listing. */
export async function downloadReportObject(ctx: ConnectorContext, bucket: string, obj: ReportObject, maxBytes: number): Promise<Uint8Array> {
  if (!BUCKET.test(bucket)) throw new Error('invalid report bucket');
  if (obj.size > maxBytes) throw new ProviderHttpError(`report ${obj.name} is ${obj.size} bytes, above the ${maxBytes}-byte import limit`, { status: 413, phase: 'rejected' });
  const res = await ctx.http.request({
    method: 'GET',
    url: `${ctx.endpoints.cloudStorage.replace(/\/$/, '')}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(obj.name)}?alt=media&generation=${obj.generation}`,
    headers: await authed(ctx, PLAY_SCOPES.storage),
    binary: true,
    idempotent: true,
    maxResponseBytes: maxBytes,
    timeoutMs: 120_000,
  });
  // Objects stored with Content-Encoding: gzip may be transcoded in transit; their stored hash
  // then describes the compressed form, so only identity-encoded objects are hash-checked.
  if (obj.contentEncoding !== 'gzip') {
    if (obj.size && res.bytes.byteLength !== obj.size) throw new ProviderHttpError(`report ${obj.name} size mismatch`, { status: 502, phase: 'rejected' });
    if (obj.md5Hash) {
      const md5 = createHash('md5').update(res.bytes).digest('base64');
      if (md5 !== obj.md5Hash) throw new ProviderHttpError(`report ${obj.name} checksum mismatch`, { status: 502, phase: 'rejected' });
    }
  }
  return res.bytes;
}

/* ------------------------------------------------------------------ */
/* Play Developer Reporting API                                        */
/* ------------------------------------------------------------------ */

/** Apps the service account can see (`apps:search`); requires the reporting scope. */
export async function searchPlayApps(ctx: ConnectorContext): Promise<{ packageName: string; displayName: string | null }[]> {
  const out: { packageName: string; displayName: string | null }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await ctx.http.request<{ apps?: { name?: string; packageName?: string; displayName?: string }[]; nextPageToken?: string }>({
      method: 'GET',
      url: `${ctx.endpoints.playReporting.replace(/\/$/, '')}/v1beta1/apps:search?${q}`,
      headers: await authed(ctx, PLAY_SCOPES.reporting),
      idempotent: true,
    });
    for (const a of res.data.apps ?? []) {
      if (typeof a.packageName === 'string' && PACKAGE.test(a.packageName)) out.push({ packageName: a.packageName, displayName: typeof a.displayName === 'string' ? a.displayName.slice(0, 200) : null });
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken) return out;
  }
  return out;
}

export const VITALS_METRIC_SETS = {
  crashRateMetricSet: ['crashRate', 'userPerceivedCrashRate', 'distinctUsers'],
  anrRateMetricSet: ['anrRate', 'userPerceivedAnrRate', 'distinctUsers'],
} as const;
export type VitalsMetricSet = keyof typeof VITALS_METRIC_SETS;

/** DAILY vitals use America/Los_Angeles, the only time zone the API supports for that period. */
export const VITALS_DAILY_TIMEZONE = 'America/Los_Angeles';

interface GoogleDateTime {
  year?: number;
  month?: number;
  day?: number;
}

const toGoogleDate = (day: string) => {
  const [year, month, d] = day.split('-').map(Number);
  return { year, month, day: d, timeZone: { id: VITALS_DAILY_TIMEZONE } };
};
const fromGoogleDate = (d: GoogleDateTime | undefined) => (d?.year && d.month && d.day ? `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null);

/** Latest end of DAILY data (exclusive, Pacific dates), or null when the set reports none. */
export async function vitalsFreshness(ctx: ConnectorContext, packageName: string, set: VitalsMetricSet): Promise<string | null> {
  if (!PACKAGE.test(packageName)) throw new Error('invalid package name');
  const res = await ctx.http.request<{ freshnessInfo?: { freshnesses?: { aggregationPeriod?: string; latestEndTime?: GoogleDateTime }[] } }>({
    method: 'GET',
    url: `${ctx.endpoints.playReporting.replace(/\/$/, '')}/v1beta1/apps/${encodeURIComponent(packageName)}/${set}`,
    headers: await authed(ctx, PLAY_SCOPES.reporting),
    idempotent: true,
  });
  const daily = res.data.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === 'DAILY');
  return fromGoogleDate(daily?.latestEndTime);
}

export interface VitalsRow {
  date: string;
  metrics: Record<string, number | null>;
}

/** Daily vitals for [from, to) (Pacific dates). Values are `google.type.Decimal` strings. */
export async function queryVitals(ctx: ConnectorContext, packageName: string, set: VitalsMetricSet, range: { from: string; to: string }): Promise<{ rows: VitalsRow[]; raw: unknown[] }> {
  if (!PACKAGE.test(packageName)) throw new Error('invalid package name');
  const rows: VitalsRow[] = [];
  const raw: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await ctx.http.request<{ rows?: { startTime?: GoogleDateTime; metrics?: { metric?: string; decimalValue?: { value?: string } }[] }[]; nextPageToken?: string }>({
      method: 'POST',
      url: `${ctx.endpoints.playReporting.replace(/\/$/, '')}/v1beta1/apps/${encodeURIComponent(packageName)}/${set}:query`,
      headers: await authed(ctx, PLAY_SCOPES.reporting),
      json: { timelineSpec: { aggregationPeriod: 'DAILY', startTime: toGoogleDate(range.from), endTime: toGoogleDate(range.to) }, metrics: [...VITALS_METRIC_SETS[set]], pageSize: 1000, ...(pageToken ? { pageToken } : {}) },
      idempotent: true,
    });
    raw.push(res.data);
    for (const r of res.data.rows ?? []) {
      const date = fromGoogleDate(r.startTime);
      if (!date) continue;
      const metrics: Record<string, number | null> = {};
      for (const name of VITALS_METRIC_SETS[set]) metrics[name] = null;
      for (const m of r.metrics ?? []) {
        if (!m.metric || !(m.metric in metrics)) continue;
        const v = m.decimalValue?.value;
        const n = typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
        metrics[m.metric] = n !== null && Number.isFinite(n) ? n : null;
      }
      rows.push({ date, metrics });
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  return { rows, raw };
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

export type PlayAccess = 'ok' | 'permission_denied' | 'not_found' | 'auth_failed' | 'rate_limited' | 'error';

export function classifyPlayError(err: unknown): { access: PlayAccess; message: string } {
  if (err instanceof ProviderHttpError) {
    if (err.status === 401) return { access: 'auth_failed', message: err.message };
    if (err.status === 403) return { access: 'permission_denied', message: 'access denied: the service account needs Play Console "View app information" (Global) for bulk reports' };
    if (err.status === 404) return { access: 'not_found', message: 'the report bucket or app was not found' };
    if (err.status === 429) return { access: 'rate_limited', message: 'Google rate limit reached' };
    return { access: 'error', message: err.message };
  }
  return { access: 'error', message: err instanceof Error ? err.message : String(err) };
}

/** Read-only probe: can the key list the bucket's statistics reports, and use the Reporting API? */
export async function probePlayAccess(ctx: ConnectorContext, bucket: string): Promise<{ reports: PlayAccess; reporting: PlayAccess; details: Record<string, unknown> }> {
  const details: Record<string, unknown> = { bucket };
  let reports: PlayAccess = 'ok';
  try {
    const objs = await listReportObjects(ctx, bucket, 'stats/', { maxPages: 1, partial: true });
    details.statisticsObjectsVisible = objs.length;
  } catch (err) {
    const c = classifyPlayError(err);
    reports = c.access;
    details.reportsError = c.message;
  }
  let reporting: PlayAccess = 'ok';
  try {
    details.appsVisible = (await searchPlayApps(ctx)).length;
  } catch (err) {
    const c = classifyPlayError(err);
    reporting = c.access;
    details.reportingError = c.message;
  }
  return { reports, reporting, details };
}

export const googlePlayRead: ReadConnector = {
  provider: 'google_play',
  async healthCheck(ctx): Promise<HealthResult> {
    const bucket = typeof ctx.connection.metadata.bucket === 'string' ? ctx.connection.metadata.bucket : ctx.connection.externalAccountId;
    try {
      const p = await probePlayAccess(ctx, normalizeReportBucket(bucket));
      const healthy = p.reports === 'ok';
      return { healthy, status: healthy ? (p.reporting === 'ok' ? 'healthy' : 'degraded') : p.reports === 'rate_limited' ? 'degraded' : 'failing', grantedScopes: null, details: { ...p.details, reports: p.reports, reporting: p.reporting } };
    } catch (err) {
      return { healthy: false, status: 'failing', grantedScopes: null, details: { error: classifyPlayError(err).message } };
    }
  },
};
