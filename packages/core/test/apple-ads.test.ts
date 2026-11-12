import { HttpClient } from '@futuregrow/connectors';
import { appInstalls, evidenceRecords, withTenant } from '@futuregrow/db';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { appleAttributionProvider, reconcileAppleAttribution } from '../src/modules/m19-app-growth/apple-ads.js';
import { attributionReport } from '../src/modules/m19-app-growth/attribution.js';
import { recordInstall } from '../src/modules/m19-app-growth/index.js';

it('uses the official plain-text endpoint, retries premature 404, and preserves permission failures', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{}', { status: 404 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ attribution: true, orgId: 456, campaignId: 789 }), { headers: { 'content-type': 'application/json' } }));
  const sleep = vi.fn(async () => {});
  const p = appleAttributionProvider(new HttpClient({ fetchImpl, maxRetries: 0 }), sleep);
  expect(await p.resolve('test-token')).toMatchObject({ attribution: true, campaignId: 789 });
  expect(fetchImpl.mock.calls[0]).toMatchObject(['https://api-adservices.apple.com/api/v1/', { method: 'POST', body: 'test-token', redirect: 'manual' }]);
  expect(sleep).toHaveBeenCalledWith(5000);
  const denied = appleAttributionProvider(new HttpClient({ fetchImpl: async () => new Response('{}', { status: 403 }), maxRetries: 0 }), sleep);
  await expect(denied.resolve('test-token')).rejects.toThrow(/invalid, expired, or not permitted/);
});
let h: CoreHarness;
beforeAll(async () => {
  h = await createCoreHarness();
});
afterAll(async () => {
  await h?.close();
});
it('reconciles official campaign identity into attribution, rejects test data and token reuse, and never stores tokens', async () => {
  const tx = <T>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'user:test' }, f);
  const base = { appId: 'com.example.ios', platform: 'ios', installId: 'install-apple-001', installedAt: h.clock.now().toISOString(), consent: { analytics: true } };
  await recordInstall(h.deps, h.tenantId, 'key:relay', base);
  const input = { appId: base.appId, installId: base.installId, token: 'testTokenAAAAAAAAAAAAAAAA', consent: { analytics: true } };
  const p = { resolve: vi.fn(async () => ({ attribution: true, orgId: 456, campaignId: 789, adGroupId: 33 })) };
  expect(await reconcileAppleAttribution(h.deps, h.tenantId, 'key:relay', { ...input, consent: { analytics: false } }, p)).toMatchObject({ status: 'consent_denied' });
  expect(p.resolve).not.toHaveBeenCalled();
  await expect(reconcileAppleAttribution(h.deps, h.tenantId, 'key:other', input, p)).rejects.toThrow(/backend/);
  expect(await reconcileAppleAttribution(h.deps, h.tenantId, 'key:relay', input, { resolve: async () => ({ attribution: true, orgId: 1234567890, campaignId: 1234567890 }) })).toMatchObject({ status: 'test_payload' });
  expect(await reconcileAppleAttribution(h.deps, h.tenantId, 'key:relay', input, p)).toMatchObject({ status: 'attributed', campaign: 'apple_ads:456:789' });
  expect(await reconcileAppleAttribution(h.deps, h.tenantId, 'key:relay', input, p)).toMatchObject({ recorded: false });
  const report = await tx((t) => attributionReport(t, { appId: base.appId, platform: 'ios', from: '2026-10-01T00:00:00Z', to: '2026-10-20T00:00:00Z' }, h.clock.now()));
  expect(report.campaigns[0]).toMatchObject({ campaign: 'apple_ads:456:789', storeReported: { acquisitions: null, available: false }, telemetry: { installs: 1, methods: ['apple_ads_adservices'] } });
  await recordInstall(h.deps, h.tenantId, 'key:relay', { ...base, installId: 'install-apple-002' });
  await expect(reconcileAppleAttribution(h.deps, h.tenantId, 'key:relay', { ...input, installId: 'install-apple-002' }, p)).rejects.toThrow(/another installation/);
  const stored = await tx(async (t) => ({ installs: await t.select().from(appInstalls), evidence: await t.select().from(evidenceRecords) }));
  expect(JSON.stringify(stored)).not.toContain(input.token);
});
