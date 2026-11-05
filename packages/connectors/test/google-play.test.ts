import { createHash, createVerify } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serviceAccountKey } from '../../../test/helpers/store-fixtures.js';
import { clearPlayTokenCache, downloadReportObject, listReportObjects, normalizeReportBucket, parseServiceAccountKey, probePlayAccess, queryVitals, serviceAccountAssertion } from '../src/providers/google-play.js';
import { FixtureServer, makeCtx } from './helpers.js';

const KEY = serviceAccountKey();
const BUCKET = 'pubsite_prod_rev_01234567890987654321';
let server: FixtureServer;
const creds = () => {
  const k = parseServiceAccountKey(KEY.json);
  return { provider: 'google_play' as const, clientEmail: k.clientEmail, privateKeyPem: k.privateKeyPem, privateKeyId: k.privateKeyId, projectId: k.projectId };
};

beforeAll(async () => {
  server = new FixtureServer();
  await server.start();
});
afterAll(async () => server.stop());
beforeEach(() => {
  server.reset();
  clearPlayTokenCache();
  server.on('POST', '/oauth/token', { json: { access_token: 'ya29.test', expires_in: 3600 } });
});

describe('Google Play service-account access', () => {
  it('validates key files without echoing them', () => {
    expect(() => parseServiceAccountKey('{not json')).toThrow(/not valid JSON/);
    expect(() => parseServiceAccountKey({ ...KEY.json, type: 'authorized_user' })).toThrow(/type must be service_account/);
    expect(() => parseServiceAccountKey({ ...KEY.json, client_email: 'someone@gmail.com' })).toThrow(/client_email/);
    try {
      parseServiceAccountKey({ ...KEY.json, private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' });
    } catch (err) {
      expect((err as Error).message).not.toContain('AAAA');
    }
    expect(parseServiceAccountKey(JSON.stringify(KEY.json))).toMatchObject({ clientEmail: KEY.json.client_email, projectId: 'fixture-project', privateKeyId: 'abcdef0123456789' });
  });

  it('accepts only Play report buckets', () => {
    expect(normalizeReportBucket(`gs://${BUCKET}/stats/installs/`)).toBe(BUCKET);
    expect(normalizeReportBucket(` ${BUCKET.toUpperCase()} `)).toBe(BUCKET);
    for (const bad of ['gs://my-bucket', 'pubsite_prod_', 'pubsite-prod-rev-123', 'https://storage.googleapis.com/x']) expect(() => normalizeReportBucket(bad)).toThrow();
  });

  it('signs an RS256 assertion for the token endpoint with the requested scope', () => {
    const jwt = serviceAccountAssertion(creds(), ['https://www.googleapis.com/auth/devstorage.read_only'], 'https://oauth2.googleapis.com/token', new Date('2026-11-06T00:00:00Z'));
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'abcdef0123456789' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ iss: KEY.json.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_only', aud: 'https://oauth2.googleapis.com/token', iat: 1793923200, exp: 1793926800 });
    expect(createVerify('sha256').update(`${h}.${p}`).verify(KEY.publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('maps a rejected key to re-authorization and a 403 bucket to a permission problem', async () => {
    const ctx = makeCtx(server, creds());
    server.on('POST', '/oauth/token', { status: 400, json: { error: 'invalid_grant' } });
    expect((await probePlayAccess(ctx, BUCKET)).reports).toBe('auth_failed');
    clearPlayTokenCache();
    server.on('POST', '/oauth/token', { json: { access_token: 'ya29.test', expires_in: 3600 } });
    server.on('GET', `/storage/v1/b/${BUCKET}/o`, { status: 403, json: { error: { code: 403 } } });
    server.on('GET', '/v1beta1/apps:search', { json: { apps: [] } });
    const p = await probePlayAccess(ctx, BUCKET);
    expect(p).toMatchObject({ reports: 'permission_denied', reporting: 'ok' });
    expect(String(p.details.reportsError)).toMatch(/View app information/);
  });

  it('lists with read-only scope, follows pages and verifies MD5 on download', async () => {
    const ctx = makeCtx(server, creds());
    const body = Buffer.from('Date,Package Name\n');
    const md5 = createHash('md5').update(body).digest('base64');
    server.on('GET', `/storage/v1/b/${BUCKET}/o`, (req) =>
      req.query.get('pageToken')
        ? { json: { items: [{ name: 'stats/installs/b.csv', generation: '2', size: String(body.length), md5Hash: md5 }] } }
        : {
            json: {
              items: [
                { name: 'stats/installs/a.csv', generation: '1', size: String(body.length), md5Hash: md5 },
                { name: 'bad', generation: 'x' },
              ],
              nextPageToken: 'p2',
            },
          },
    );
    const objs = await listReportObjects(ctx, BUCKET, 'stats/installs/');
    expect(objs.map((o) => o.name)).toEqual(['stats/installs/a.csv', 'stats/installs/b.csv']);
    const tokenForm = server.find('POST', '/oauth/token')[0]!.form!;
    const claims = JSON.parse(Buffer.from(tokenForm.get('assertion')!.split('.')[1]!, 'base64url').toString());
    expect(claims.scope).toBe('https://www.googleapis.com/auth/devstorage.read_only');
    server.on('GET', /^\/storage\/v1\/b\/.+\/o\/.+/, { body });
    expect(Buffer.from(await downloadReportObject(ctx, BUCKET, objs[0]!, 1024))).toEqual(body);
    await expect(downloadReportObject(ctx, BUCKET, { ...objs[0]!, md5Hash: 'AAAAAAAAAAAAAAAAAAAAAA==' }, 1024)).rejects.toThrow(/checksum mismatch/);
    await expect(downloadReportObject(ctx, BUCKET, { ...objs[0]!, size: 5000 }, 1024)).rejects.toThrow(/import limit/);
  });

  it('queries DAILY vitals in America/Los_Angeles and keeps missing values null', async () => {
    const ctx = makeCtx(server, creds());
    server.on('POST', '/v1beta1/apps/com.example.app/crashRateMetricSet:query', {
      json: {
        rows: [
          {
            aggregationPeriod: 'DAILY',
            startTime: { year: 2026, month: 10, day: 1, timeZone: { id: 'America/Los_Angeles' } },
            metrics: [
              { metric: 'crashRate', decimalValue: { value: '0.0125' } },
              { metric: 'distinctUsers', decimalValue: { value: 'NaN' } },
            ],
          },
        ],
      },
    });
    const r = await queryVitals(ctx, 'com.example.app', 'crashRateMetricSet', { from: '2026-10-01', to: '2026-10-02' });
    expect(r.rows).toEqual([{ date: '2026-10-01', metrics: { crashRate: 0.0125, userPerceivedCrashRate: null, distinctUsers: null } }]);
    const sent = server.find('POST', '/v1beta1/apps/com.example.app/crashRateMetricSet:query')[0]!.json as { timelineSpec: { aggregationPeriod: string; startTime: { timeZone: { id: string } } } };
    expect(sent.timelineSpec).toMatchObject({ aggregationPeriod: 'DAILY', startTime: { year: 2026, month: 10, day: 1, timeZone: { id: 'America/Los_Angeles' } } });
  });
});
