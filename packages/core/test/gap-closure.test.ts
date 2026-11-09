import { randomUUID } from 'node:crypto';
import { OpenAISpeechProvider } from '@futuregrow/agent-kernel';
import { clearGoogleTokenCache } from '@futuregrow/connectors';
import { getActionType } from '@futuregrow/contracts';
import { actionRequests, adCampaigns, adDailyMetrics, assetRights, assets, auditLog, brands, commissionLedger, connections, costLedger, keywordMetrics, kgEntities, paidCampaignDrafts, payoutRequests, socialMetricObservations, withTenant } from '@futuregrow/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { createBrand } from '../src/modules/brands/index.js';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import { catalogOverview, catalogProduct, setProductBrand, syncShopifyCatalog } from '../src/modules/m12-offers/catalog.js';
import { csvCell, socialAnalyticsCsv } from '../src/modules/m16-social/analytics.js';
import { optimizationSuggestions, proposeOptimization } from '../src/modules/m17-paid/optimize.js';
import { keywordOpportunities, syncSearchConsole, uploadKeywordMetrics } from '../src/modules/m18-discovery/index.js';
import { listProperties, propertyOf, searchConsoleOverview, searchPerformance, selectProperty } from '../src/modules/m18-discovery/search-console.js';
import { attributionApps, attributionReport } from '../src/modules/m19-app-growth/attribution.js';
import { createCreator } from '../src/modules/m22-creators/index.js';
import * as payouts from '../src/modules/m22-creators/payouts.js';
import { getHooks } from '../src/modules/m23-execution/registry.js';
import { approveArtifact, approveModel, registerArtifact, seedModelRegistry } from '../src/modules/m24-governance/index.js';
import { mediaProviders } from '../src/modules/media/index.js';
import { processNextMediaJob } from '../src/modules/media/sources.js';
import { requestVoiceover, speechReadiness } from '../src/modules/media/voice.js';

/**
 * P1+P2+P3 gap closure: the read models behind the Product catalog, Creator payouts, Attribution
 * report and Search Console screens, and the correctness fixes found while building them.
 */
const server = new FixtureServer();
let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

async function evidenceId(kind = 'document') {
  const e = await tx((t) =>
    admitEvidence(
      t,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'internal',
        sourceOwner: 'acme',
        sourceUriOrObjectId: `doc://${randomUUID()}`,
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'first-party',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: 1,
        freshnessSlaHours: 24 * 90,
        permittedUses: ['analytics', 'creative_generation', 'autonomous_execution'],
        kind,
        summary: 'record',
        content: { n: randomUUID() },
      } as never,
      { now: h.clock.now() },
    ),
  );
  return e.evidenceId;
}

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
  h.clock.advance(Date.parse('2026-11-09T08:00:00Z') - h.clock.now().getTime());
}, 180_000);
afterAll(async () => {
  await h?.close();
  await server.stop();
});
beforeEach(() => {
  server.reset();
  clearGoogleTokenCache();
});

/* ------------------------------------------------------------------ */

describe('Shopify product catalog (P2-09 UI)', () => {
  const product = (id: number, title: string, price: string, stock: number) => ({
    id: `gid://shopify/Product/${id}`,
    title,
    handle: title.toLowerCase().replace(/\s+/g, '-'),
    status: 'ACTIVE',
    totalInventory: stock,
    onlineStoreUrl: null,
    variants: { nodes: [{ id: `gid://shopify/ProductVariant/${id}`, sku: `S-${id}`, price, inventoryQuantity: stock }] },
  });
  const serve = (nodes: unknown[]) => server.on('POST', '/admin/api/2026-10/graphql.json', { json: { data: { shop: { currencyCode: 'EUR' }, products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });

  it('lists shops and products with freshness, keeps unchanged facts, re-points brand links and marks removed products', async () => {
    const shop = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'shopify', externalAccountId: 'gap.myshopify.com', displayName: 'Gap shop', grantedScopes: ['read_products'], credentials: { shopDomain: 'gap.myshopify.com', accessToken: 'shpat_gap' } })).id;
    serve([product(1, 'Mug', '9.00', 5), product(2, 'Tote', '15.00', 0)]);
    expect(await syncShopifyCatalog(h.deps, h.tenantId, shop, { actor: h.users.operator })).toMatchObject({ products: 2, facts: 2, unchanged: 0 });

    let view = await tx((t) => catalogOverview(t, h.clock.now()));
    const conn = view.connections.find((c) => c.id === shop)!;
    expect(conn).toMatchObject({ shop: 'gap.myshopify.com', missingScopes: ['read_inventory'], brand: null, lastSync: { products: 2, stale: false } });
    const mug = view.products.find((p) => p.name === 'Mug')!;
    expect(mug).toMatchObject({ prices: ['9.00'], currency: 'EUR', totalInventory: 5, inStock: true, inLatestSync: true, connectionId: shop, brands: [] });
    expect(view.products.find((p) => p.name === 'Tote')).toMatchObject({ inStock: false });

    // Link the product to a brand; an analyst may not.
    const brand = await tx((t) => createBrand(t, h.tenantId, h.users.operator, { slug: 'gap-brand', name: 'Gap Brand' }));
    await expect(tx((t) => setProductBrand(t, h.tenantId, h.users.analyst, mug.id, { brandId: brand.id, linked: true, expectedVersion: brand.version }))).rejects.toThrow(/roles/);
    const linked = await tx((t) => setProductBrand(t, h.tenantId, h.users.operator, mug.id, { brandId: brand.id, linked: true, expectedVersion: brand.version }));
    expect(linked.productEntityIds).toEqual([mug.id]);
    await expect(tx((t) => setProductBrand(t, h.tenantId, h.users.operator, mug.id, { brandId: brand.id, linked: true, expectedVersion: brand.version }))).rejects.toThrow(/changed since version/);

    // Re-sync: the mug's price changed (new version, brand link moves to it), the tote is gone from the shop.
    h.clock.advance(3_600_000);
    serve([product(1, 'Mug', '11.00', 4)]);
    expect(await syncShopifyCatalog(h.deps, h.tenantId, shop)).toMatchObject({ products: 1, facts: 1, unchanged: 0, relinked: 1 });
    // Same data again: no new version.
    h.clock.advance(3_600_000);
    serve([product(1, 'Mug', '11.00', 4)]);
    expect(await syncShopifyCatalog(h.deps, h.tenantId, shop)).toMatchObject({ facts: 0, unchanged: 1, relinked: 0 });

    view = await tx((t) => catalogOverview(t, h.clock.now()));
    const mug2 = view.products.find((p) => p.name === 'Mug')!;
    expect(mug2.id).not.toBe(mug.id);
    expect(mug2).toMatchObject({ prices: ['11.00'], version: 2, inLatestSync: true, brands: [{ id: brand.id, name: 'Gap Brand' }] });
    expect(view.products.find((p) => p.name === 'Tote')).toMatchObject({ inLatestSync: false });
    const [b] = await tx((t) => t.select().from(brands).where(eq(brands.id, brand.id)));
    expect(b!.productEntityIds).toEqual([mug2.id]);

    const detail = await tx((t) => catalogProduct(t, mug.id, h.clock.now()));
    expect(detail.product.id).toBe(mug2.id);
    expect(detail.versions.map((v) => [v.version, v.status, v.prices])).toEqual([
      [2, 'active', ['11.00']],
      [1, 'superseded', ['9.00']],
    ]);
    expect(detail.brands).toEqual([{ id: brand.id, name: 'Gap Brand' }]);

    // Unlinking removes every version of the product from the brand.
    const after = await tx((t) => setProductBrand(t, h.tenantId, h.users.operator, mug2.id, { brandId: brand.id, linked: false, expectedVersion: b!.version }));
    expect(after.productEntityIds).toEqual([]);
    const logs = await tx((t) => t.select().from(auditLog).where(eq(auditLog.action, 'brand.product_unlinked')));
    expect(logs).toHaveLength(1);
    // After 24 hours inventory is shown as stale.
    h.clock.advance(25 * 3_600_000);
    view = await tx((t) => catalogOverview(t, h.clock.now()));
    expect(view.connections.find((c) => c.id === shop)!.lastSync!.stale).toBe(true);
    expect(view.products.find((p) => p.name === 'Mug')!.stale).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('creator payouts overview and reconciliation (P2-14 UI)', () => {
  it('shows balances, masked destinations and every failing condition; only finance-capable roles may read it', async () => {
    const creator = await tx((t) => createCreator(t, h.tenantId, h.users.operator, { name: 'Quinn' }));
    await tx((t) => payouts.setPayoutProfile(t, h.tenantId, h.users.finance, creator.id, { provider: 'paypal', receiver: 'quinn@pay.example', kycStatus: 'pending' }));
    await tx((t) => t.insert(commissionLedger).values({ tenantId: h.tenantId, creatorId: creator.id, kind: 'adjustment', amountMicros: 50_000_000, currency: 'USD', ref: `adj:${creator.id}` }));
    await expect(tx((t) => payouts.payoutsOverview(t, { ...h.users.analyst, roles: ['viewer'] }, h.clock.now()))).rejects.toThrow(/roles/);
    const o = await tx((t) => payouts.payoutsOverview(t, h.users.analyst, h.clock.now()));
    expect(o.execution).toMatchObject({ enabled: false, blockerRef: 'B-015', legalApproved: false, provider: null });
    const row = o.creators.find((c) => c.id === creator.id)!;
    expect(row.profile).toMatchObject({ receiver: 'qu…', kycStatus: 'pending' });
    expect(row.balance).toEqual([{ currency: 'USD', accruedMicros: 0, clawedBackMicros: 0, paidMicros: 0, payableMicros: 50_000_000, inRefundWindowMicros: 0 }]);
    expect(row.readiness.ready).toBe(false);
    expect(row.readiness.failing).toEqual(expect.arrayContaining(['contract', 'identity', 'tax_form', 'legal_approval', 'provider', 'execution_enabled']));
    expect(row.readiness.failing).not.toContain('payable_balance');
    expect(JSON.stringify(o)).not.toContain('quinn@pay.example');
  });

  it('a verified payout is written to the ledger once and lowers the balance; an open request blocks a second one', async () => {
    const creator = await tx((t) => createCreator(t, h.tenantId, h.users.operator, { name: 'Sasha' }));
    await tx((t) => t.insert(commissionLedger).values({ tenantId: h.tenantId, creatorId: creator.id, kind: 'adjustment', amountMicros: 20_000_000, currency: 'USD', ref: `adj:${creator.id}` }));
    const [req] = await tx((t) =>
      t
        .insert(payoutRequests)
        .values({ tenantId: h.tenantId, creatorId: creator.id, status: 'approved', amounts: [{ currency: 'USD', amountMicros: 20_000_000 }], readiness: {}, requestedBy: 'user:test' })
        .returning(),
    );
    // An open request: readiness refuses another one.
    const ready = await tx((t) => payouts.payoutReadiness(t, creator.id, h.clock.now()));
    expect(ready.checks.find((c) => c.key === 'no_open_request')).toMatchObject({ ok: false });
    const blocked = await payouts.requestPayout(h.deps, h.tenantId, h.users.finance, creator.id);
    expect(blocked.request.status).toBe('blocked');
    expect(blocked.request.blockers.join(' ')).toMatch(/no_open_request/);

    const action = { tenantId: h.tenantId, params: { payoutRequestId: req!.id, creatorId: creator.id, items: [{ itemId: 'i0', receiver: 'x@y.z', amountMicros: 20_000_000, currency: 'USD', note: 'n' }] } };
    const hook = getHooks('creator.payout')[0]!;
    const receipt = { providerRequestId: null, providerObjectId: 'BATCH-1', httpStatus: 200, responseSha256: 'x', observedAt: h.clock.now().toISOString(), details: {} };
    await tx((t) => hook.onVerified!(t as never, action as never, receipt as never, {} as never));
    await tx((t) => hook.onVerified!(t as never, action as never, receipt as never, {} as never));
    const ledger = await tx((t) => payouts.creatorLedger(t, h.users.finance, creator.id));
    expect(ledger.filter((l) => l.kind === 'payout')).toEqual([expect.objectContaining({ amountMicros: -20_000_000, currency: 'USD', ref: `payout:${req!.id}:USD` })]);
    const [paid] = await tx((t) => t.select().from(payoutRequests).where(eq(payoutRequests.id, req!.id)));
    expect(paid).toMatchObject({ status: 'paid', providerBatchId: 'BATCH-1', providerStatus: 'paid' });
    expect(paid!.reconciledAt).not.toBeNull();
    const o = await tx((t) => payouts.payoutsOverview(t, h.users.finance, h.clock.now()));
    expect(o.creators.find((c) => c.id === creator.id)!.balance[0]).toMatchObject({ paidMicros: 20_000_000, payableMicros: 0 });
    expect(o.reconciliation.paid).toBeGreaterThanOrEqual(1);

    // A denied payout pays nothing and closes the open request.
    const [other] = await tx((t) => t.insert(payoutRequests).values({ tenantId: h.tenantId, creatorId: creator.id, status: 'proposed', amounts: [], readiness: {}, requestedBy: 'user:test' }).returning());
    await tx((t) => hook.onTerminalFailure!(t as never, { ...action, params: { ...action.params, payoutRequestId: other!.id } } as never, 'DENIED', 'policy', null));
    const [denied] = await tx((t) => t.select().from(payoutRequests).where(eq(payoutRequests.id, other!.id)));
    expect(denied!.status).toBe('denied');
  });
});

/* ------------------------------------------------------------------ */

describe('attribution report with store reports but no telemetry (P3-08 UI)', () => {
  it('lists store-reported campaigns, keeps the two funnels apart, filters by brand and explains missing data', async () => {
    const app = 'com.gap.lessons';
    const brandA = await tx((t) => createBrand(t, h.tenantId, h.users.operator, { slug: 'attr-a', name: 'Attr A' }));
    const ev = await evidenceId('metric');
    await tx(async (t) => {
      const conn = (await t.execute<{ id: string }>(sql`insert into connections (tenant_id, provider, external_account_id, display_name, created_by) values (${h.tenantId}, 'google_play', 'pubsite_gap', 'Gap Play', 'test') returning id`)).rows[0]!.id;
      const acct = (await t.execute<{ id: string }>(sql`insert into store_accounts (tenant_id, connection_id, provider, account_ref, display_name, created_by) values (${h.tenantId}, ${conn}, 'google_play', 'pubsite_gap', 'Gap Play', 'test') returning id`)).rows[0]!.id;
      const storeApp = (await t.execute<{ id: string }>(sql`insert into store_apps (tenant_id, store_account_id, platform, app_id, display_name, status) values (${h.tenantId}, ${acct}, 'android', ${app}, 'Gap Lessons', 'confirmed') returning id`)).rows[0]!.id;
      await t.execute(sql`insert into brand_apps (tenant_id, brand_id, platform, app_id, listing_url, created_by) values (${h.tenantId}, ${brandA.id}, 'android', ${app}, 'https://play.google.com/store/apps/details?id=com.gap.lessons', 'test')`);
      await t.execute(sql`insert into campaign_links (tenant_id, brand_id, channel_platform, app_platform, app_id, campaign, content, url, report_scope, created_by) values (${h.tenantId}, ${brandA.id}, 'facebook', 'android', ${app}, 'post_a', 'c1', 'https://x', 'campaign', 'test')`);
      const file = (
        await t.execute<{ id: string }>(
          sql`insert into store_report_files (tenant_id, store_account_id, store_app_id, provider, family, dimension, period, source_uri, source_version, source_rank, size_bytes, sha256, status, evidence_id) values (${h.tenantId}, ${acct}, ${storeApp}, 'google_play', 'play.store_performance', 'traffic_source', '2026-10', 'gs://x/traffic.csv', '1', 1, 1, 'gap', 'imported', ${ev}) returning id`,
        )
      ).rows[0]!.id;
      for (const day of ['2026-11-01', '2026-11-02']) {
        const part = (
          await t.execute<{ id: string }>(
            sql`insert into store_report_partitions (tenant_id, store_app_id, family, dimension, observation_date, report_file_id, source_rank, rows, digest, status) values (${h.tenantId}, ${storeApp}, 'play.store_performance', 'traffic_source', ${day}::date, ${file}, 1, 4, 'gap', 'complete') returning id`,
          )
        ).rows[0]!.id;
        for (const [campaign, acq, vis] of [
          ['post_a', 3, 30],
          ['ext_b', 2, 10],
        ] as const) {
          for (const [metric, value] of [
            ['play.store_listing_acquisitions', acq],
            ['play.store_listing_visitors', vis],
          ] as const) {
            await t.execute(
              sql`insert into store_metric_observations (tenant_id, partition_id, store_app_id, store_account_id, platform, app_id, provider, family, dimension, metric_key, source_metric, observation_date, dims, dims_key, value, report_file_id) values (${h.tenantId}, ${part}, ${storeApp}, ${acct}, 'android', ${app}, 'google_play', 'play.store_performance', 'traffic_source', ${metric}, ${metric}, ${day}::date, ${JSON.stringify({ utm_source: 'facebook', utm_campaign: campaign })}::jsonb, ${`${campaign}|${metric}`}, ${value}, ${file})`,
            );
          }
        }
      }
    });

    const apps = await tx((t) => attributionApps(t));
    expect(apps.find((a) => a.appId === app)).toMatchObject({ platform: 'android', name: 'Gap Lessons', brandId: brandA.id, storeReports: true, telemetry: false });

    const q = { appId: app, platform: 'android', from: '2026-10-27T00:00:00Z', to: '2026-11-08T00:00:00Z' };
    const r = await tx((t) => attributionReport(t, q, h.clock.now()));
    expect(r.campaigns.map((c) => c.campaign).sort()).toEqual(['ext_b', 'post_a']);
    const a = r.campaigns.find((c) => c.campaign === 'post_a')!;
    expect(a).toMatchObject({ identity: { status: 'post', brandId: brandA.id }, telemetry: null, storeReported: { acquisitions: 6, visitors: 60, reportedDays: 2, reportedThrough: '2026-11-02' }, telemetryCoverageOfStore: null });
    expect(r.campaigns.find((c) => c.campaign === 'ext_b')!.identity.status).toBe('unregistered');
    expect(r.funnel.store.steps).toEqual([expect.objectContaining({ key: 'visitors', value: 80 }), expect.objectContaining({ key: 'acquisitions', value: 10 })]);
    expect(r.funnel.telemetry.steps.map((s) => s.value)).toEqual([null, null, null]);
    expect(r.coverage).toMatchObject({ campaigns: 2, withStoreReport: 2, withTelemetry: 0, withBoth: 0, registered: 1, storeReportedThrough: '2026-11-02', storeLagDays: 6 });
    expect(r.missingData.map((m) => m.key)).toEqual(expect.arrayContaining(['store_lag', 'no_telemetry', 'unregistered_campaigns']));
    expect(JSON.stringify(r)).not.toMatch(/"total"/);

    // Brand filter: only the brand's registered campaign remains.
    const mine = await tx((t) => attributionReport(t, { ...q, brandId: brandA.id }, h.clock.now()));
    expect(mine.campaigns.map((c) => c.campaign)).toEqual(['post_a']);
    expect(mine.funnel.store.steps.find((s) => s.key === 'acquisitions')!.value).toBe(6);
    const other = await tx((t) => createBrand(t, h.tenantId, h.users.operator, { slug: 'attr-b', name: 'Attr B' }));
    await expect(tx((t) => attributionReport(t, { ...q, brandId: other.id }, h.clock.now()))).rejects.toThrow(/not linked to that brand/);
  });
});

/* ------------------------------------------------------------------ */

describe('Google Search Console workspace (P2-13 UI)', () => {
  const sites = {
    siteEntry: [
      { siteUrl: 'https://gap.example/', permissionLevel: 'siteOwner' },
      { siteUrl: 'sc-domain:gap.example', permissionLevel: 'siteFullUser' },
      { siteUrl: 'https://other.example/', permissionLevel: 'siteUnverifiedUser' },
    ],
  };
  const rows = (impressions: number) => ({
    rows: [
      { keys: ['gap mugs', 'https://gap.example/mugs'], clicks: 6, impressions, ctr: 6 / impressions, position: 8 },
      { keys: ['gap', 'https://gap.example/'], clicks: 40, impressions: 100, ctr: 0.4, position: 1.2 },
    ],
  });

  it('lists properties, accepts only a verified one, syncs it, records outcomes and reads one period at a time', async () => {
    server.on('POST', '/oauth/token', { json: { access_token: 'ya29.sc', expires_in: 3600 } });
    server.on('GET', '/webmasters/v3/sites', { json: sites });
    const c = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'search_console', externalAccountId: 'https://gap.example/', displayName: 'Gap SC', credentials: { clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt' } });
    expect(propertyOf(c as never)).toBe('https://gap.example/');

    const list = await listProperties(h.deps, h.tenantId, h.users.analyst, c.id);
    expect(list).toMatchObject({ selected: 'https://gap.example/', explicitlySelected: false });
    expect(list.properties.find((p) => p.siteUrl === 'https://other.example/')).toMatchObject({ verified: false, kind: 'url_prefix' });
    await expect(selectProperty(h.deps, h.tenantId, h.users.operator, c.id, 'sc-domain:gap.example')).rejects.toThrow(/roles/);
    await expect(selectProperty(h.deps, h.tenantId, h.users.owner, c.id, 'https://other.example/')).rejects.toThrow(/not a verified user/);
    await expect(selectProperty(h.deps, h.tenantId, h.users.owner, c.id, 'https://nope.example/')).rejects.toThrow(/not in the authorized account/);
    expect(await selectProperty(h.deps, h.tenantId, h.users.owner, c.id, 'sc-domain:gap.example')).toMatchObject({ siteUrl: 'sc-domain:gap.example', permissionLevel: 'siteFullUser' });

    // Two overlapping daily windows of the same property.
    server.on('POST', /\/webmasters\/v3\/sites\/sc-domain%3Agap\.example\/searchAnalytics\/query/, { json: rows(300) });
    expect(await syncSearchConsole(h.deps, h.tenantId, c.id, { startDate: '2026-10-28', endDate: '2026-11-03' })).toMatchObject({ rows: 2, siteUrl: 'sc-domain:gap.example' });
    server.on('POST', /\/webmasters\/v3\/sites\/sc-domain%3Agap\.example\/searchAnalytics\/query/, { json: rows(400) });
    await syncSearchConsole(h.deps, h.tenantId, c.id, { startDate: '2026-10-29', endDate: '2026-11-04', trigger: 'scheduled' });

    let overview = await tx((t) => searchConsoleOverview(t, h.clock.now()));
    const conn = overview.connections.find((x) => x.id === c.id)!;
    expect(conn).toMatchObject({ property: 'sc-domain:gap.example', propertySelected: true, permissionLevel: 'siteFullUser', lastSync: { status: 'ok', rows: 2, trigger: 'scheduled', period: { start: '2026-10-29', end: '2026-11-04' } } });
    expect(conn.periods.map((p) => `${p.start}..${p.end}`)).toEqual(['2026-10-29..2026-11-04', '2026-10-28..2026-11-03']);

    const perf = await tx((t) => searchPerformance(t, { siteUrl: 'sc-domain:gap.example' }));
    // The latest period only: 400 + 100 impressions, never 300 + 400 + 200.
    expect(perf.period).toEqual({ start: '2026-10-29', end: '2026-11-04' });
    expect(perf.totals).toMatchObject({ rows: 2, clicks: 46, impressions: 500, queries: 2, pages: 2 });
    expect(perf.totals!.ctr).toBeCloseTo(46 / 500);
    expect(perf.queries[0]).toMatchObject({ key: 'gap', clicks: 40 });
    const older = await tx((t) => searchPerformance(t, { siteUrl: 'sc-domain:gap.example', periodStart: '2026-10-28', periodEnd: '2026-11-03' }));
    expect(older.totals!.impressions).toBe(400);
    expect(await tx((t) => searchPerformance(t, { siteUrl: 'https://gap.example/' }))).toMatchObject({ period: null, totals: null });

    // Opportunities read the latest period too (impressions are not inflated by overlapping windows).
    const opp = await tx((t) => keywordOpportunities(t, { minImpressions: 50, siteUrl: 'sc-domain:gap.example' }));
    expect(opp.period).toEqual({ start: '2026-10-29', end: '2026-11-04' });
    expect(opp.rows.map((r) => [r.query, Number(r.impressions)])).toEqual([['gap mugs', 400]]);

    // A failed sync is recorded on the connection (and still thrown).
    server.on('POST', /searchAnalytics\/query/, { status: 403, json: { error: { message: 'User does not have sufficient permission' } } });
    await expect(syncSearchConsole(h.deps, h.tenantId, c.id, { startDate: '2026-10-30', endDate: '2026-11-05' })).rejects.toThrow();
    overview = await tx((t) => searchConsoleOverview(t, h.clock.now()));
    expect(overview.connections.find((x) => x.id === c.id)!.lastSync).toMatchObject({ status: 'failed', trigger: 'manual' });
    const [stored] = await tx((t) => t.select().from(connections).where(eq(connections.id, c.id)));
    expect(JSON.stringify(stored!.metadata)).not.toMatch(/ya29|refreshToken|clientSecret/);
    const n = await tx((t) =>
      t
        .select({ n: sql<number>`count(*)::int` })
        .from(keywordMetrics)
        .where(and(eq(keywordMetrics.source, 'search_console'))),
    );
    expect(n[0]!.n).toBe(4);
  });

  it('uploaded keyword periods are read on their own and never mixed into a property', async () => {
    const ev = await evidenceId('metric');
    await tx((t) => uploadKeywordMetrics(t, h.tenantId, h.users.analyst, { periodStart: '2026-09-01', periodEnd: '2026-09-30', evidenceId: ev, rows: [{ query: 'upload q', pageUrl: 'https://gap.example/u', impressions: 50, clicks: 1, position: 9 }] }));
    const perf = await tx((t) => searchPerformance(t, { source: 'upload' }));
    expect(perf.totals).toMatchObject({ rows: 1, impressions: 50 });
    const sc = await tx((t) => searchPerformance(t, { siteUrl: 'sc-domain:gap.example' }));
    expect(sc.queries.map((q) => q.key)).not.toContain('upload q');
    await expect(tx((t) => searchPerformance(t, {}))).rejects.toThrow(/choose a property/);
    const facts = await tx((t) => t.select().from(kgEntities).where(eq(kgEntities.kind, 'product')));
    expect(facts.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */

describe('controlled optimisation of created campaigns (P3-06)', () => {
  it('suggests only pauses and budget reductions from synced data; a chosen one becomes an M23 proposal, never an execution', async () => {
    const conn = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'meta', externalAccountId: 'act_777', displayName: 'Gap ads', credentials: { accessToken: 'EAAG', appSecret: 's' } })).id;
    const ends = new Date(h.clock.now().getTime() + 10 * 86_400_000).toISOString();
    const [draft] = await tx((t) =>
      t
        .insert(paidCampaignDrafts)
        .values({ tenantId: h.tenantId, platform: 'meta', connectionId: conn, name: 'Gap launch', status: 'created', spec: { lifetimeCap: { amountMicros: 50_000_000, currency: 'USD' }, endTime: ends }, geographies: ['US'], externalCampaignId: '120210000000001', createdBy: 'user:test' })
        .returning(),
    );
    // Not synced yet: nothing to suggest.
    expect((await tx((t) => optimizationSuggestions(t, draft!.id, h.clock.now()))).suggestions).toEqual([]);
    const [camp] = await tx((t) => t.insert(adCampaigns).values({ tenantId: h.tenantId, connectionId: conn, platform: 'meta', externalCampaignId: '120210000000001', name: 'Gap launch', status: 'ACTIVE', dailyBudgetMicros: 10_000_000, currency: 'USD', lastSyncedAt: h.clock.now() }).returning());
    for (const date of ['2026-11-05', '2026-11-06', '2026-11-07']) await tx((t) => t.insert(adDailyMetrics).values({ tenantId: h.tenantId, campaignId: camp!.id, date, impressions: 400, clicks: 0, costMicros: 10_000_000, conversions: 0, conversionValueMicros: 0 } as never));
    const s = await tx((t) => optimizationSuggestions(t, draft!.id, h.clock.now()));
    expect(s.suggestions.map((x) => x.key)).toEqual(['pause_no_clicks', 'pace_to_cap']);
    expect(s.suggestions.find((x) => x.key === 'pace_to_cap')!.proposal).toEqual({ newDailyBudgetMicros: 2_000_000 });
    for (const x of s.suggestions) if ('newDailyBudgetMicros' in x.proposal) expect(x.proposal.newDailyBudgetMicros).toBeLessThan(10_000_000);

    await expect(proposeOptimization(h.deps, h.tenantId, h.users.analyst, draft!.id, 'pause_no_clicks')).rejects.toThrow(/roles/);
    await expect(proposeOptimization(h.deps, h.tenantId, h.users.operator, draft!.id, 'turn_on')).rejects.toThrow(/no longer applies/);
    const action = await proposeOptimization(h.deps, h.tenantId, h.users.operator, draft!.id, 'pause_no_clicks');
    expect(action.status).not.toMatch(/EXECUT|VERIFIED/);
    const [row] = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.id, action.id)));
    expect(row).toMatchObject({ actionType: 'ads.meta.set_campaign_status', params: expect.objectContaining({ campaignId: '120210000000001', status: 'PAUSED' }) });
    // The budget suggestion lowers spend: the proposal carries the paced budget and the previous one.
    const budget = await proposeOptimization(h.deps, h.tenantId, h.users.operator, draft!.id, 'pace_to_cap');
    const [b] = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.id, budget.id)));
    expect(b!.params).toMatchObject({ newDailyBudget: { amountMicros: 2_000_000 }, previousDailyBudget: { amountMicros: 10_000_000 } });
    expect(server.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe('social analytics CSV export and Instagram carousels (P3-05, P2-02)', () => {
  it('exports per-platform rows with unknowns left empty, neutralises formulas, checks the role and audits', async () => {
    const conn = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'tiktok', externalAccountId: 'tt_gap', displayName: '=HYPERLINK("x")', credentials: { accessToken: 'act', refreshToken: 'r', clientKey: 'k', clientSecret: 's' } as never })).id;
    await tx((t) =>
      t.insert(socialMetricObservations).values([
        { tenantId: h.tenantId, connectionId: conn, platform: 'tiktok', scope: 'post', objectRef: 'v1', metricKey: 'views', value: 120, status: 'reported', observedOn: '2026-11-08', observedAt: h.clock.now() },
        { tenantId: h.tenantId, connectionId: conn, platform: 'tiktok', scope: 'post', objectRef: 'v1', metricKey: 'shares', value: null, status: 'not_returned', observedOn: '2026-11-08', observedAt: h.clock.now() },
      ]),
    );
    await expect(tx((t) => socialAnalyticsCsv(t, h.tenantId, { ...h.users.analyst, roles: ['viewer'] }, h.clock.now()))).rejects.toThrow(/roles/);
    const out = await tx((t) => socialAnalyticsCsv(t, h.tenantId, h.users.analyst, h.clock.now(), { platform: 'tiktok' }));
    const lines = out.csv.trim().split('\r\n');
    expect(lines[0]).toBe('platform,account,scope,object_ref,post_url,metric_key,metric_label,unit,value,status,observed_on,revision');
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.includes(',views,'))).toMatch(/^tiktok,"'=HYPERLINK\(""x""\)",post,v1,,views,.*,120,reported,2026-11-08,1$/);
    expect(lines.find((l) => l.includes(',shares,'))).toMatch(/,,not_returned,/);
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell(-3)).toBe('-3');
    const logs = await tx((t) => t.select().from(auditLog).where(eq(auditLog.action, 'social.analytics.exported')));
    expect(logs.at(-1)!.payload).toMatchObject({ rows: 2, platform: 'tiktok' });
  });

  it('an Instagram carousel lists one item per asset (2–10); a single image or reel has none', () => {
    const schema = getActionType('social.instagram.publish_media')!.paramsSchema;
    const base = { igUserId: 'ig', mediaUrl: 'asset://a', caption: 'c', postId: randomUUID(), claimIds: [], disclosure: { isAiGenerated: false, paidPartnership: false, syntheticPersonaId: null, disclosureText: null } };
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    expect(schema.safeParse({ ...base, mediaType: 'CAROUSEL', assetIds: ids, items: ids.map((id) => ({ mediaType: 'IMAGE', mediaUrl: `asset://${id}` })) }).success).toBe(true);
    expect(schema.safeParse({ ...base, mediaType: 'CAROUSEL', assetIds: ids, items: ids.slice(0, 2).map((id) => ({ mediaType: 'IMAGE', mediaUrl: `asset://${id}` })) }).success).toBe(false);
    expect(schema.safeParse({ ...base, mediaType: 'IMAGE', assetIds: ids }).success).toBe(false);
    expect(schema.safeParse({ ...base, mediaType: 'IMAGE', assetIds: [ids[0]] }).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('AI voiceover (P3-04 voice/TTS) and generative video status', () => {
  const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 1)]);
  const providers = async () => Object.fromEntries((await tx((t) => mediaProviders({ t, deps: h.deps, tenantId: h.tenantId }))).map((p) => [p.id, p]));

  it('stays disabled until a speech model is approved and priced, the provider configured and the licence recorded; generative video is never offered', async () => {
    await seedModelRegistry(h.t.handle.db);
    let p = await providers();
    expect(p['ai-voice-model']).toMatchObject({ enabled: false, adapter: 'available', requires: [expect.stringMatching(/approved for speech_generation/)] });
    expect(p['ai-video-model']).toMatchObject({ enabled: false, adapter: 'not_built', prerequisitesMet: false });
    await expect(tx((t) => requestVoiceover(t, h.deps, h.tenantId, h.users.operator, { text: 'Welcome to Gap.', voice: 'alloy' }))).rejects.toThrow(/not enabled/);

    await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'openai', modelId: 'tts-1', trainingOnCustomerData: 'no', dataRetentionTerms: 'API data not used for training', inputUsdPerMtok: null, outputUsdPerMtok: null });
    p = await providers();
    expect(p['ai-voice-model']!.requires).toEqual(expect.arrayContaining([expect.stringMatching(/speech provider is not configured/), expect.stringMatching(/licence record named "openai\/tts-1"/), expect.stringMatching(/price per million characters/)]));
    await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'openai', modelId: 'tts-1', trainingOnCustomerData: 'no', dataRetentionTerms: 'API data not used for training', inputUsdPerMtok: null, outputUsdPerMtok: null, usdPerMillionChars: 15 });
    h.deps.speech = { openai: new OpenAISpeechProvider({ apiKey: 'sk-tts', baseUrl: `${server.baseUrl}/v1` }) };
    const a = await tx((t) =>
      registerArtifact(t, h.tenantId, h.users.legal, {
        exactName: 'openai/tts-1',
        versionOrCommit: '2026-11',
        sha256: 'a'.repeat(64),
        artifactType: 'weights',
        copyrightOwner: null,
        licenseIdOrCustomTerms: 'OpenAI Services Agreement and Usage Policies: commercial use allowed, AI voice must be disclosed',
        commercialUse: 'allowed',
        redistribution: 'restricted',
        derivativeUse: 'allowed',
        attributionRequired: 'false',
        geographicOrUseRestrictions: [],
        sourceDataRightsStatus: 'known',
        sourceUrl: null,
      }),
    );
    await tx((t) => approveArtifact(t, h.tenantId, h.users.legal, a.id));
    p = await providers();
    expect(p['ai-voice-model']).toMatchObject({ enabled: true, reason: expect.stringMatching(/\$15 per million characters/) });
    // The text model gateway never treats a speech model as a reasoning model.
    expect((await tx((t) => speechReadiness(t, h.deps))).voices).toContain('alloy');
  });

  it('refuses impersonation and unknown voices before any call, then synthesizes, labels, records voice rights and cost', async () => {
    await expect(tx((t) => requestVoiceover(t, h.deps, h.tenantId, h.users.analyst, { text: 'Hello', voice: 'alloy' }))).rejects.toThrow(/roles/);
    await expect(tx((t) => requestVoiceover(t, h.deps, h.tenantId, h.users.operator, { text: 'Hello', voice: 'morgan' }))).rejects.toThrow(/choose one of the model/);
    await expect(tx((t) => requestVoiceover(t, h.deps, h.tenantId, h.users.operator, { text: 'Read this in the voice of a famous actor', voice: 'alloy' }))).rejects.toThrow(/impersonate/);
    expect(server.find('POST', '/v1/audio/speech')).toHaveLength(0);

    server.on('POST', '/v1/audio/speech', (req) => (req.headers.authorization === 'Bearer sk-tts' ? { headers: { 'x-request-id': 'req_tts_1', 'content-type': 'audio/mpeg' }, body: MP3 } : { status: 401, json: { error: { code: 'invalid_api_key' } } }));
    const text = 'Learn one Korean word every day with Gap Lessons.';
    const job = await tx((t) => requestVoiceover(t, h.deps, h.tenantId, h.users.operator, { text, voice: 'nova', title: 'Daily word intro' }));
    const out = await processNextMediaJob(h.deps);
    expect(out, JSON.stringify(out)).toMatchObject({ kind: 'succeeded', jobId: job.id });
    if (out.kind !== 'succeeded') return;
    expect(server.find('POST', '/v1/audio/speech')[0]!.json).toMatchObject({ model: 'tts-1', voice: 'nova', input: text, response_format: 'mp3' });
    const [asset] = await tx((t) => t.select().from(assets).where(eq(assets.id, out.assetId)));
    expect(asset).toMatchObject({ kind: 'audio', mime: 'audio/mpeg', origin: 'generated', title: 'Daily word intro', disclosure: { isAiGenerated: true, disclosureText: 'AI-generated voice' } });
    expect(asset!.manifest).toMatchObject({ contains: { voice: true, aiGenerated: true, music: false }, model: { modelId: 'tts-1', voice: 'nova' } });
    const rights = await tx((t) => t.select().from(assetRights).where(eq(assetRights.assetId, asset!.id)));
    expect(rights.map((r) => r.component).sort()).toEqual(['model', 'source_media', 'voice']);
    const cost = await tx((t) => t.select().from(costLedger).where(eq(costLedger.refId, job.id)));
    expect(cost).toEqual([expect.objectContaining({ category: 'speech_generation', unit: 'characters', quantity: text.length })]);
    expect(cost[0]!.amountUsd).toBeCloseTo((text.length / 1e6) * 15, 9);
  });

  it('a provider refusal is terminal and costs nothing', async () => {
    server.on('POST', '/v1/audio/speech', { status: 400, json: { error: { code: 'moderation_blocked', message: 'rejected' } } });
    const job = await tx((t) => requestVoiceover(t, h.deps, h.tenantId, h.users.operator, { text: 'A calm morning message for our learners.', voice: 'alloy' }));
    expect(await processNextMediaJob(h.deps)).toMatchObject({ kind: 'refused', jobId: job.id });
    expect(await tx((t) => t.select().from(costLedger).where(eq(costLedger.refId, job.id)))).toEqual([]);
  });
});
