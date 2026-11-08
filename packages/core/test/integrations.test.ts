import { connections, storeAccounts, withTenant } from '@futuregrow/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { INTEGRATION_STATUSES, integrationCatalog } from '../src/modules/integrations.js';

let h: CoreHarness;
let other: CoreHarness;
const tx = <T>(hh: CoreHarness, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(hh.deps.db, { tenantId: hh.tenantId, actor: 'test:integrations' }, fn);

beforeAll(async () => {
  h = await createCoreHarness();
  other = await createCoreHarness({ tenantSlug: 'integrations-other' });
}, 180_000);
afterAll(async () => {
  await h?.close();
  await other?.close();
});

const byKey = async (hh: CoreHarness) => Object.fromEntries((await tx(hh, (t) => integrationCatalog(t, hh.clock.now()))).map((i) => [i.key, i]));

describe('integration status catalog (P2)', () => {
  it('covers the 14 P2 integrations (P2-15 legal readiness is its own checklist) and starts with nothing reported as working', async () => {
    const all = await tx(h, (t) => integrationCatalog(t, h.clock.now()));
    expect(all.map((i) => i.workstream)).toEqual(Array.from({ length: 14 }, (_, i) => `P2-${String(i + 1).padStart(2, '0')}`));
    for (const i of all) expect(INTEGRATION_STATUSES).toContain(i.status);
    const s = Object.fromEntries(all.map((i) => [i.key, i.status]));
    expect(s).toMatchObject({
      app_store_connect: 'requires_connection',
      instagram: 'requires_connection',
      x: 'requires_owner_authorization',
      reddit: 'owner_assisted',
      google_ads: 'requires_connection',
      posthog: 'requires_connection',
      payouts: 'requires_owner_authorization',
    });
    expect(all.some((i) => i.status === 'live_verified' || i.status === 'connected')).toBe(false);
    const x = all.find((i) => i.key === 'x')!;
    expect(x.reasons.join(' ')).toMatch(/\$0\.015 per post/);
    expect(all.find((i) => i.key === 'payouts')!.writes).toEqual([{ actionType: 'creator.payout', supported: false, blocker: 'B-015' }]);
  });

  it('separates healthy, failing and approval-limited connections, and never leaks across tenants', async () => {
    await tx(h, (t) =>
      t.insert(connections).values([
        { tenantId: h.tenantId, provider: 'chatwoot', externalAccountId: '7', displayName: 'Support', healthStatus: 'healthy', createdBy: 'test' },
        { tenantId: h.tenantId, provider: 'shopify', externalAccountId: 'shop.myshopify.com', displayName: 'Shop', healthStatus: 'failing', createdBy: 'test' },
        { tenantId: h.tenantId, provider: 'search_console', externalAccountId: 'sc-domain:example.com', displayName: 'SC', healthStatus: 'degraded', createdBy: 'test' },
        { tenantId: h.tenantId, provider: 'google_ads', externalAccountId: '1234567890', displayName: 'Ads', healthStatus: 'healthy', accessLevel: 'test', createdBy: 'test' },
      ]),
    );
    const s = await byKey(h);
    expect(s.chatwoot!.status).toBe('connected');
    expect(s.chatwoot!.summary).toMatch(/verified only by a successful sync/);
    expect(s.shopify!.status).toBe('connection_unhealthy');
    expect(s.search_console!.status).toBe('connection_unhealthy');
    expect(s.google_ads!.status).toBe('requires_provider_approval');
    const o = await byKey(other);
    expect(o.chatwoot!.status).toBe('requires_connection');
    expect(o.chatwoot!.connections).toEqual([]);
  });

  it('App Store Connect is live only after a recent successful sync of a healthy account', async () => {
    const [c] = await tx(h, (t) => t.insert(connections).values({ tenantId: h.tenantId, provider: 'app_store_connect', externalAccountId: 'issuer-1', displayName: 'Apple', createdBy: 'test' }).returning());
    const [acct] = await tx(h, (t) => t.insert(storeAccounts).values({ tenantId: h.tenantId, connectionId: c!.id, provider: 'app_store_connect', accountRef: 'issuer-1', displayName: 'Apple team', createdBy: 'test' }).returning());
    expect((await byKey(h)).app_store_connect!.status).toBe('connected');
    await tx(h, (t) => t.update(storeAccounts).set({ healthStatus: 'auth_failed' }));
    expect((await byKey(h)).app_store_connect).toMatchObject({ status: 'connection_unhealthy', summary: expect.stringMatching(/auth failed/) });
    await tx(h, (t) => t.update(storeAccounts).set({ healthStatus: 'ok', lastSuccessAt: h.clock.now() }));
    expect((await byKey(h)).app_store_connect!.status).toBe('live_verified');
    expect(acct).toBeTruthy();
  });
});
