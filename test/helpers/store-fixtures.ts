import { createHash, generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { FixtureServer, RecordedRequest } from './fixture-server.js';

/**
 * Provider-shaped fixtures for store reporting tests (D-045). Shapes follow the official docs:
 * Play bulk report paths/columns (support.google.com/googleplay/android-developer/answer/6135870),
 * the Cloud Storage JSON API object resource, Play Developer Reporting API v1beta1, and App Store
 * Connect Analytics Reports (JSON:API resources, gzip segments with md5 checksums). All values are
 * test data; nothing here describes a real account.
 */

export function serviceAccountKey(email = 'fg-reports@fixture-project.iam.gserviceaccount.com') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return { json: { type: 'service_account', project_id: 'fixture-project', private_key_id: 'abcdef0123456789', private_key: privateKey, client_email: email, client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' }, publicKey };
}

export function ascKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return privateKey;
}

/** Play exports are UTF-16 (Google asks to convert "from UTF-16 to UTF-8" before loading). */
export function utf16(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

export const csv = (rows: (string | number)[][]) => `${rows.map((r) => r.map((c) => (typeof c === 'string' && /[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : String(c))).join(',')).join('\n')}\n`;

export const INSTALLS_HEADER = ['Date', 'Package Name', 'Country', 'Current Device Installs', 'Installs on active devices', 'Daily Device Installs', 'Daily Device Uninstalls', 'Daily Device Upgrades', 'Current User Installs', 'Total User Installs', 'Daily User Installs', 'Daily User Uninstalls'];
export const TRAFFIC_HEADER = ['Date', 'Package name', 'Traffic source', 'Search term', 'UTM source', 'UTM campaign', 'Store listing acquisitions', 'Store listing visitors', 'Store listing conversion rate'];
export const SP_COUNTRY_HEADER = ['Date', 'Package name', 'Country', 'Store listing acquisitions', 'Store listing visitors', 'Store listing conversion rate'];

export function monthDays(month: string, upTo?: string): string[] {
  const out: string[] = [];
  const d = new Date(`${month}-01T00:00:00Z`);
  while (d.toISOString().slice(0, 7) === month) {
    const day = d.toISOString().slice(0, 10);
    if (upTo && day > upTo) break;
    out.push(day);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export interface BucketObject {
  name: string;
  generation: string;
  body: Buffer;
  updated: string;
}

/** A fake Play report bucket + token endpoint + Reporting API on a fixture server. */
export class FakePlay {
  objects = new Map<string, BucketObject>();
  apps: { packageName: string; displayName: string }[] = [];
  denyBucket = false;
  denyReporting = false;
  vitals = new Map<string, { latest: string; rows: { date: string; crashRate?: string; anrRate?: string }[] }>();
  private gen = 1_700_000_000_000_000;

  constructor(
    readonly server: FixtureServer,
    readonly bucket: string,
  ) {}

  put(name: string, body: Buffer, updated: string): BucketObject {
    this.gen += 1000;
    const o = { name, generation: String(this.gen), body, updated };
    this.objects.set(name, o);
    return o;
  }

  install(): this {
    const s = this.server;
    s.on('POST', '/oauth/token', (req: RecordedRequest) => {
      const f = req.form;
      if (f?.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !f.get('assertion')) return { status: 400, json: { error: 'invalid_grant' } };
      return { json: { access_token: `ya29.fixture-${f.get('assertion')!.length}`, expires_in: 3599, token_type: 'Bearer' } };
    });
    s.on('GET', new RegExp(`^/storage/v1/b/${this.bucket}/o$`), (req) => {
      if (this.denyBucket) return { status: 403, json: { error: { code: 403, message: 'fixture: caller does not have storage.objects.list access' } } };
      const prefix = req.query.get('prefix') ?? '';
      const all = [...this.objects.values()].filter((o) => o.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name));
      const start = Number(req.query.get('pageToken') ?? 0);
      const page = all.slice(start, start + 3);
      return {
        json: { kind: 'storage#objects', items: page.map((o) => ({ name: o.name, generation: o.generation, size: String(o.body.length), md5Hash: createHash('md5').update(o.body).digest('base64'), updated: o.updated, contentType: 'text/csv' })), ...(start + 3 < all.length ? { nextPageToken: String(start + 3) } : {}) },
      };
    });
    s.on('GET', new RegExp(`^/storage/v1/b/${this.bucket}/o/.+`), (req) => {
      if (this.denyBucket) return { status: 403, json: { error: { code: 403 } } };
      const name = decodeURIComponent(req.path.split('/o/')[1]!);
      const o = this.objects.get(name);
      if (!o || req.query.get('alt') !== 'media' || req.query.get('generation') !== o.generation) return { status: 404, json: { error: { code: 404 } } };
      return { body: o.body, headers: { 'content-type': 'text/csv' } };
    });
    s.on('GET', '/v1beta1/apps:search', () => (this.denyReporting ? { status: 403, json: { error: { code: 403, status: 'PERMISSION_DENIED' } } } : { json: { apps: this.apps.map((a) => ({ name: `apps/${a.packageName}`, ...a })) } }));
    s.on('GET', /^\/v1beta1\/apps\/[^/]+\/(crash|anr)RateMetricSet$/, (req) => {
      const [, , , pkg, set] = req.path.split('/');
      const v = this.vitals.get(pkg!);
      if (!v) return { status: 404, json: { error: { code: 404 } } };
      const [y, m, d] = v.latest.split('-').map(Number);
      return { json: { name: `apps/${pkg}/${set}`, freshnessInfo: { freshnesses: [{ aggregationPeriod: 'DAILY', latestEndTime: { year: y, month: m, day: d, timeZone: { id: 'America/Los_Angeles' } } }] } } };
    });
    s.on('POST', /^\/v1beta1\/apps\/[^/]+\/(crash|anr)RateMetricSet:query$/, (req) => {
      const pkg = req.path.split('/')[3]!;
      const crash = req.path.includes('crashRate');
      const v = this.vitals.get(pkg);
      return {
        json: {
          rows: (v?.rows ?? []).map((r) => {
            const [y, m, d] = r.date.split('-').map(Number);
            const val = crash ? r.crashRate : r.anrRate;
            return { aggregationPeriod: 'DAILY', startTime: { year: y, month: m, day: d, timeZone: { id: 'America/Los_Angeles' } }, metrics: val === undefined ? [] : [{ metric: crash ? 'crashRate' : 'anrRate', decimalValue: { value: val } }] };
          }),
        },
      };
    });
    return this;
  }
}

/** Fake App Store Connect Analytics Reports API (JSON:API) with gzip segments. */
export class FakeApple {
  apps: { id: string; bundleId: string; name: string }[] = [];
  requests = new Map<string, { id: string; accessType: string; stoppedDueToInactivity: boolean }[]>();
  reports = new Map<string, { id: string; name: string; category: string }[]>();
  instances = new Map<string, { id: string; granularity: string; processingDate: string }[]>();
  segments = new Map<string, { id: string; body: Buffer }[]>();
  denyRequests = false;

  constructor(readonly server: FixtureServer) {}

  segment(instanceId: string, segId: string, tsv: string) {
    const body = gzipSync(Buffer.from(tsv, 'utf8'));
    const list = this.segments.get(instanceId) ?? [];
    list.push({ id: segId, body });
    this.segments.set(instanceId, list);
  }

  install(): this {
    const s = this.server;
    const page = <T>(items: { id: string; type: string; attributes: T }[]) => ({ json: { data: items, links: { self: 'x' } } });
    s.on('GET', '/v1/apps', () => page(this.apps.map((a) => ({ id: a.id, type: 'apps', attributes: { bundleId: a.bundleId, name: a.name } }))));
    s.on('GET', /^\/v1\/apps\/\d+\/analyticsReportRequests$/, (req) =>
      this.denyRequests ? { status: 403, json: { errors: [{ status: '403', code: 'FORBIDDEN_ERROR' }] } } : page((this.requests.get(req.path.split('/')[3]!) ?? []).map((r) => ({ id: r.id, type: 'analyticsReportRequests', attributes: { accessType: r.accessType, stoppedDueToInactivity: r.stoppedDueToInactivity } }))),
    );
    s.on('POST', '/v1/analyticsReportRequests', (req) => {
      const body = req.json as { data: { attributes: { accessType: string }; relationships: { app: { data: { id: string } } } } };
      const appId = body.data.relationships.app.data.id;
      const r = { id: `req-${appId}-${body.data.attributes.accessType.toLowerCase()}`, accessType: body.data.attributes.accessType, stoppedDueToInactivity: false };
      this.requests.set(appId, [...(this.requests.get(appId) ?? []), r]);
      return { status: 201, json: { data: { id: r.id, type: 'analyticsReportRequests', attributes: r } } };
    });
    s.on('GET', /^\/v1\/analyticsReportRequests\/[^/]+\/reports$/, (req) => page((this.reports.get(req.path.split('/')[3]!) ?? []).map((r) => ({ id: r.id, type: 'analyticsReports', attributes: { name: r.name, category: r.category } }))));
    s.on('GET', /^\/v1\/analyticsReports\/[^/]+\/instances$/, (req) =>
      page((this.instances.get(req.path.split('/')[3]!) ?? []).filter((i) => i.granularity === req.query.get('filter[granularity]')).map((i) => ({ id: i.id, type: 'analyticsReportInstances', attributes: { granularity: i.granularity, processingDate: i.processingDate } }))),
    );
    s.on('GET', /^\/v1\/analyticsReportInstances\/[^/]+\/segments$/, (req) => {
      const inst = req.path.split('/')[3]!;
      return page((this.segments.get(inst) ?? []).map((g) => ({ id: g.id, type: 'analyticsReportSegments', attributes: { checksum: createHash('md5').update(g.body).digest('hex'), sizeInBytes: g.body.length, url: `${s.baseUrl}/segment-files/${inst}/${g.id}.gz` } })));
    });
    s.on('GET', /^\/segment-files\//, (req) => {
      if (req.headers.authorization) return { status: 400, text: 'pre-signed URLs must not receive the API token' };
      const [, , inst, file] = req.path.split('/');
      const g = (this.segments.get(inst!) ?? []).find((x) => `${x.id}.gz` === file);
      return g ? { body: g.body, headers: { 'content-type': 'application/a-gzip' } } : { status: 404, text: 'missing' };
    });
    return this;
  }
}

export const DOWNLOADS_HEADER = ['Date', 'App Name', 'App Apple Identifier', 'Download Type', 'App Version', 'Device', 'Platform Version', 'Source Type', 'Page Type', 'Pre-Order', 'Territory', 'Counts'];
export const tsv = (rows: (string | number)[][]) => `${rows.map((r) => r.join('\t')).join('\n')}\n`;
