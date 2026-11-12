import { generateKeyPairSync } from 'node:crypto';
import { HttpClient } from '@futuregrow/connectors';
import { connections, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { createConnection } from '../src/modules/connections.js';
import { appleAdsReports, syncAppleAdsReport } from '../src/modules/m19-app-growth/apple-ads-reporting.js';

let h: CoreHarness;
beforeAll(async () => {
  h = await createCoreHarness();
});
afterAll(async () => {
  await h?.close();
});
it('imports actual campaign report values, preserves missing metrics and deduplicates evidence under tenant scope', async () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const conn = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'apple_ads', externalAccountId: '456', displayName: 'Fixture Apple Ads', metadata: { reportingTermsApproved: true }, credentials: { clientId: 'client', teamId: 'team', keyId: 'key', privateKeyPem: key } });
  const end = new Date(h.clock.now().getTime() - 86400000).toISOString().slice(0, 10);
  const payload = { data: { reportingDataResponse: { row: [{ metadata: { orgId: 456, campaignId: 789, campaignName: 'Fixture campaign', app: { adamId: 555 } }, granularity: [{ date: end, impressions: 123, localSpend: { amount: '1.2345', currency: 'BDT' } }] }] } } };
  const fetchImpl = vi.fn<typeof fetch>(async (url) => Response.json(String(url).includes('oauth2/token') ? { access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600 } : payload));
  const deps = { ...h.deps, http: new HttpClient({ fetchImpl, maxRetries: 0 }) };
  const req = { connectionId: conn.id, start: end, end };
  const first = await syncAppleAdsReport(deps, h.tenantId, h.users.owner, req);
  const again = await syncAppleAdsReport(deps, h.tenantId, h.users.owner, req);
  expect(again).toMatchObject({ evidenceId: first.evidenceId, unchanged: true });
  const reports = await withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'test' }, appleAdsReports);
  expect(reports[0]?.campaigns[0]).toMatchObject({ campaignRef: 'apple_ads:456:789', appId: '555', days: [{ impressions: 123, taps: null, spend: { amount: '1.2345', currency: 'BDT' } }] });
  expect(JSON.stringify(reports)).not.toContain('fixture-access-token');
  const call = fetchImpl.mock.calls.find(([url]) => String(url).includes('/reports/'))!;
  expect(call[1]).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'X-AP-Context': 'orgId=456' } });
  expect(JSON.parse(String(call[1]!.body))).toMatchObject({ granularity: 'DAILY', timeZone: 'UTC', returnRecordsWithNoMetrics: true });
  payload.data.reportingDataResponse.row[0]!.metadata.orgId = 999;
  await expect(syncAppleAdsReport(deps, h.tenantId, h.users.owner, req)).rejects.toThrow(/identity mismatch/);
  await withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'test' }, (tx) => tx.update(connections).set({ status: 'revoked' }).where(eq(connections.id, conn.id)));
  const calls = fetchImpl.mock.calls.length;
  await expect(syncAppleAdsReport(deps, h.tenantId, h.users.owner, req)).rejects.toThrow(/revoked/);
  expect(fetchImpl.mock.calls.length).toBe(calls);
});
