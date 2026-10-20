import { createPrivateKey, sign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type ConnectorContext, type HealthResult, type ReadConnector, compareProof } from '../types.js';

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
