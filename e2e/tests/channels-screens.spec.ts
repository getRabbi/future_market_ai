import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, test as base, expect, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E_ORIGIN, ORG, OWNER } from '../fixtures.js';

/**
 * The P2/P3 gap-closure screens in a real browser: Product catalog, Creator payouts, Attribution
 * report and Search Console. Provider imports need real accounts, so the rows an import produces
 * are seeded directly; everything else is clicked through the UI against the real API. Runs after
 * autopilot.spec.ts and before control-plane.spec.ts (initial owner password, no two-factor).
 */
let ipSeq = 21;
const deviceContext = (browser: Browser, phone = false) => browser.newContext({ baseURL: E2E_ORIGIN, extraHTTPHeaders: { 'x-forwarded-for': `192.0.2.${ipSeq++}` }, ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });
const test = base.extend({
  context: async ({ browser }, use) => {
    const ctx = await deviceContext(browser);
    await use(ctx);
    await ctx.close();
  },
});
test.describe.configure({ mode: 'serial' });

const problems = new WeakMap<Page, string[]>();
function watch(page: Page) {
  const list: string[] = [];
  problems.set(page, list);
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) list.push(`console: ${m.text()}`);
  });
}
test.beforeEach(async ({ page }) => watch(page));
test.afterEach(async ({ page }) => {
  expect(problems.get(page) ?? [], 'page errors / console errors (CSP violations included)').toEqual([]);
});

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/app\/$/);
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const e2eDatabase = () => new pg.Client({ connectionString: fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.data/e2e-database-url'), 'utf8').trim() });

let seeded = false;
/** What a Shopify sync, a commission accrual, a Play store-performance import and a Search Console import leave behind. */
async function seed() {
  if (seeded) return;
  const db = e2eDatabase();
  await db.connect();
  try {
    const org = (await db.query<{ id: string }>(`select id from organization where slug = $1`, [ORG.slug])).rows[0]!.id;
    const q = async (sql: string, args: unknown[]) => (await db.query<{ id: string }>(sql, args)).rows[0]?.id as string;
    const evidence = (owner: string, uri: string, content: unknown) =>
      q(
        `insert into evidence_records (tenant_id, source_type, source_owner, source_uri_or_object_id, retrieved_at, observed_at, schema_version, freshness_status, freshness_sla_hours, confidence, permitted_uses, kind, summary, content, content_sha256, status, license_or_usage_rights, pii_classification)
         values ($1, 'primary', $2, $3, now(), now(), '1', 'current', 72, 1, '{analytics,creative_generation,autonomous_execution}', $4, 'e2e import', $5, md5($3), 'admitted', 'first-party', 'none') returning id`,
        [org, owner, uri, owner === 'shopify' ? 'snapshot' : 'metric', JSON.stringify(content)],
      );
    const brand = await q(`insert into brands (tenant_id, slug, name, created_by) values ($1, 'e2e-coffee', 'E2E Coffee', 'e2e') returning id`, [org]);

    // Shopify: one shop owned by the brand, two active products from one snapshot.
    const shop = await q(`insert into connections (tenant_id, provider, external_account_id, display_name, granted_scopes, created_by) values ($1, 'shopify', 'e2e-shop.myshopify.com', 'E2E Shop', '{read_products,read_inventory}', 'e2e') returning id`, [org]);
    await db.query(`insert into brand_channels (tenant_id, brand_id, connection_id, created_by) values ($1, $2, $3, 'e2e')`, [org, brand, shop]);
    const snap = await evidence('shopify', 'shopify://e2e-shop.myshopify.com/products@e2e', { shop: 'e2e-shop.myshopify.com', products: [{ id: 'gid://shopify/Product/501' }, { id: 'gid://shopify/Product/502' }] });
    for (const [id, name, price, stock] of [
      ['501', 'Morning Blend', '14.00', 12],
      ['502', 'Night Roast', '16.00', 0],
    ] as const) {
      await db.query(`insert into kg_entities (tenant_id, kind, key, name, attributes, evidence_id, created_by) values ($1, 'product', $2, $3, $4, $5, 'system:shopify-catalog')`, [
        org,
        `shopify:product:${id}`,
        name,
        JSON.stringify({ source: 'shopify', shop: 'e2e-shop.myshopify.com', handle: name.toLowerCase().replace(' ', '-'), status: 'ACTIVE', currency: 'EUR', prices: [price], totalInventory: stock, inStock: stock > 0, url: null, variants: 1 }),
        snap,
      ]);
    }

    // A creator with 25 USD payable (an adjustment entry) and nothing else on file.
    const creator = await q(`insert into creators (tenant_id, name, handles) values ($1, 'Riley E2E', '{"instagram":"@riley"}') returning id`, [org]);
    await db.query(`insert into commission_ledger (tenant_id, creator_id, kind, amount_micros, currency, ref) values ($1, $2, 'adjustment', 25000000, 'USD', 'e2e-adj-1')`, [org, creator]);

    // Google Play store-performance (traffic source) days for two campaigns of one app; one is the brand's post.
    const play = await q(`insert into connections (tenant_id, provider, external_account_id, display_name, created_by) values ($1, 'google_play', 'pubsite_prod_rev_gamma', 'E2E Gamma account', 'e2e') returning id`, [org]);
    const acct = await q(`insert into store_accounts (tenant_id, connection_id, provider, account_ref, display_name, created_by) values ($1, $2, 'google_play', 'pubsite_prod_rev_gamma', 'E2E Gamma account', 'e2e') returning id`, [org, play]);
    const app = await q(`insert into store_apps (tenant_id, store_account_id, platform, app_id, display_name, status) values ($1, $2, 'android', 'com.example.gamma', 'Gamma Words', 'confirmed') returning id`, [org, acct]);
    await db.query(`insert into brand_apps (tenant_id, brand_id, platform, app_id, listing_url, created_by) values ($1, $2, 'android', 'com.example.gamma', 'https://play.google.com/store/apps/details?id=com.example.gamma', 'e2e')`, [org, brand]);
    await db.query(`insert into campaign_links (tenant_id, brand_id, channel_platform, app_platform, app_id, campaign, content, url, report_scope, created_by) values ($1, $2, 'facebook', 'android', 'com.example.gamma', 'e2e_post_a', 'c1', 'https://example.com', 'campaign', 'e2e')`, [org, brand]);
    const fileEv = await evidence('google_play', 'gs://pubsite_prod_rev_gamma/traffic.csv', { rows: 4 });
    const file = await q(
      `insert into store_report_files (tenant_id, store_account_id, store_app_id, provider, family, dimension, period, source_uri, source_version, source_rank, size_bytes, sha256, status, evidence_id) values ($1, $2, $3, 'google_play', 'play.store_performance', 'traffic_source', to_char(now(), 'YYYY-MM'), 'gs://pubsite_prod_rev_gamma/traffic.csv', '1', 1, 1, 'e2e', 'imported', $4) returning id`,
      [org, acct, app, fileEv],
    );
    for (const ago of [6, 5]) {
      const part = await q(
        `insert into store_report_partitions (tenant_id, store_app_id, family, dimension, observation_date, report_file_id, source_rank, rows, digest, status) values ($1, $2, 'play.store_performance', 'traffic_source', (now() at time zone 'UTC')::date - $3::int, $4, 1, 4, 'e2e', 'complete') returning id`,
        [org, app, ago, file],
      );
      for (const [campaign, acq, vis] of [
        ['e2e_post_a', 4, 40],
        ['e2e_external_b', 1, 9],
      ] as const)
        for (const [metric, value] of [
          ['play.store_listing_acquisitions', acq],
          ['play.store_listing_visitors', vis],
        ] as const)
          await db.query(
            `insert into store_metric_observations (tenant_id, partition_id, store_app_id, store_account_id, platform, app_id, provider, family, dimension, metric_key, source_metric, observation_date, dims, dims_key, value, report_file_id)
             values ($1, $2, $3, $4, 'android', 'com.example.gamma', 'google_play', 'play.store_performance', 'traffic_source', $5, $5, (now() at time zone 'UTC')::date - $6::int, $7, $8, $9, $10)`,
            [org, part, app, acct, metric, ago, JSON.stringify({ utm_source: 'facebook', utm_campaign: campaign }), `${campaign}|${metric}`, value, file],
          );
    }

    // Search Console: one connection reading sc-domain:e2e.example, one imported 7-day period.
    await db.query(`insert into connections (tenant_id, provider, external_account_id, display_name, metadata, created_by) values ($1, 'search_console', 'sc-domain:e2e.example', 'E2E Search Console', $2, 'e2e')`, [
      org,
      JSON.stringify({ siteUrl: 'sc-domain:e2e.example', permissionLevel: 'siteOwner', searchConsoleSync: { status: 'ok', at: new Date().toISOString(), rows: 3, period: { start: '2026-10-28', end: '2026-11-03' }, trigger: 'scheduled' } }),
    ]);
    const sc = await evidence('google_search_console', 'search-console://sc-domain:e2e.example/2026-10-28..2026-11-03@e2e', { rows: 3, siteUrl: 'sc-domain:e2e.example' });
    for (const [query, page, impressions, clicks, pos] of [
      ['e2e coffee beans', 'https://e2e.example/beans', 900, 9, 7.5],
      ['e2e coffee', 'https://e2e.example/', 400, 160, 1.2],
      ['how to brew e2e', 'https://e2e.example/brew', 300, 30, 11],
    ] as const)
      await db.query(`insert into keyword_metrics (tenant_id, query, page_url, period_start, period_end, impressions, clicks, position, source, evidence_id) values ($1, $2, $3, '2026-10-28', '2026-11-03', $4, $5, $6, 'search_console', $7)`, [org, query, page, impressions, clicks, pos, sc]);
    seeded = true;
  } finally {
    await db.end();
  }
}

test('Product catalog: shops, stock filters, product detail and linking a product to its brand', async ({ page }) => {
  await seed();
  await signIn(page);
  await page.goto('/app/catalog');
  await expect(page.getByRole('heading', { level: 1, name: 'Product catalog' })).toBeVisible();
  const shops = page.getByRole('region', { name: 'Shops' }).or(page.locator('section[aria-labelledby="cat-shops"]'));
  await expect(shops).toContainText('E2E Shop');
  await expect(shops).toContainText('E2E Coffee');
  await expect(shops.getByRole('button', { name: 'Sync now' })).toBeVisible();
  const products = page.locator('section[aria-labelledby="cat-products"]');
  await expect(products.getByRole('button', { name: 'Morning Blend' })).toBeVisible();
  await expect(products).toContainText('14.00 EUR');
  await expect(products).toContainText('12 in stock');
  await page.getByLabel('Stock').selectOption('out');
  await expect(products.getByRole('button', { name: 'Night Roast' })).toBeVisible();
  await expect(products.getByRole('button', { name: 'Morning Blend' })).toHaveCount(0);
  await page.getByLabel('Stock').selectOption('all');

  await products.getByRole('button', { name: 'Morning Blend' }).click();
  const drawer = page.getByRole('dialog', { name: 'Morning Blend' });
  await expect(drawer.getByRole('heading', { name: 'Brands' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Link to this brand' }).click();
  await expect(drawer.getByRole('button', { name: 'Unlink' })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'History' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();
  await page.getByLabel('Brand').selectOption({ label: 'E2E Coffee' });
  await expect(products.getByRole('button', { name: 'Morning Blend' })).toBeVisible();
  await expect(products.getByRole('button', { name: 'Night Roast' })).toHaveCount(0);
  await expect(page.locator('.notice.error')).toHaveCount(0);
});

test('Creator payouts: the honest disabled state, readiness, and a request recorded as blocked', async ({ page }) => {
  await seed();
  await signIn(page);
  await page.goto('/app/payouts');
  await expect(page.getByRole('heading', { level: 1, name: 'Creator payouts' })).toBeVisible();
  const status = page.getByRole('status', { name: 'Payout execution status' });
  await expect(status).toContainText('Payouts are not active (B-015)');
  await expect(status).toContainText('no money moves');
  await expect(page.locator('section[aria-labelledby="po-creators"]')).toContainText('$25.00');
  await page.getByRole('button', { name: 'Riley E2E' }).click();
  const drawer = page.getByRole('dialog', { name: 'Riley E2E' });
  await expect(drawer.getByText('Payout execution enabled by a platform operator')).toBeVisible();
  await expect(drawer.getByText(/payout execution disabled \(B-015\)/)).toBeVisible();
  // Without a two-factor session the payout details cannot be recorded, and the screen says why.
  await expect(drawer.getByText(/Recording payout details needs a two-factor session/)).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Save payout details' })).toBeDisabled();
  await drawer.getByRole('button', { name: 'Request payout' }).click();
  await expect(drawer.getByText(/Recorded as blocked: \d+ condition\(s\) are missing\. Nothing was paid\./)).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();
  const requests = page.locator('section[aria-labelledby="po-requests"]');
  await expect(requests).toContainText('Riley E2E');
  await requests.getByText(/Why it was not paid/).click();
  await expect(requests).toContainText('Counsel approved creator payouts');
  await expect(requests.locator('.badge').first()).toContainText(/blocked/i);
});

test('Attribution report: store campaigns without telemetry, two separate funnels, brand filter and missing-data reasons', async ({ page }) => {
  await seed();
  await signIn(page);
  await page.goto('/app/attribution');
  await expect(page.getByRole('heading', { level: 1, name: 'Attribution report' })).toBeVisible();
  await page.getByLabel('Application').selectOption({ label: 'Gamma Words (Google Play)' });
  const campaigns = page.locator('section[aria-labelledby="at-campaigns"]');
  await expect(campaigns.getByText('e2e_post_a')).toBeVisible({ timeout: 20_000 });
  await expect(campaigns.getByText('e2e_external_b')).toBeVisible();
  const row = campaigns.locator('tr', { hasText: 'e2e_post_a' });
  await expect(row).toContainText('One post');
  await expect(row).toContainText('8');
  await expect(row).toContainText('No telemetry');
  await expect(page.getByRole('region', { name: 'Store report (Google Play)' })).toContainText('Store listing acquisitions');
  await expect(page.getByRole('region', { name: 'App telemetry (consented)' })).toContainText('Observed installs');
  await expect(page.getByText('The two funnels measure different populations and are never joined or added.', { exact: false })).toBeVisible();
  const missing = page.locator('section[aria-labelledby="at-missing"]');
  await expect(missing).toContainText('No consented install telemetry');
  await expect(missing).toContainText('not in the campaign registry');
  await expect(page.locator('section[aria-labelledby="at-causal"]')).toContainText('describe what was observed, not what the campaigns caused');
  await expect(campaigns.getByRole('columnheader', { name: /total/i })).toHaveCount(0);

  await page.getByLabel('Brand').selectOption({ label: 'E2E Coffee' });
  await expect(campaigns.getByText('e2e_post_a')).toBeVisible({ timeout: 20_000 });
  await expect(campaigns.getByText('e2e_external_b')).toHaveCount(0);
  await page.getByLabel('Campaign contains').fill('nothing-like-this');
  await expect(campaigns).toContainText('No campaign matches');
});

test('Search Console: property and sync state, one period of performance, and opportunities turned into ideas', async ({ page }) => {
  await seed();
  await signIn(page);
  await page.goto('/app/search-console');
  await expect(page.getByRole('heading', { level: 1, name: 'Search Console' })).toBeVisible();
  const conn = page.locator('section[aria-labelledby="sc-conn-title"]');
  await expect(conn).toContainText('sc-domain:e2e.example');
  await expect(conn).toContainText(/Succeeded .* \(daily import\)/);
  await expect(conn.getByRole('button', { name: 'Choose property' })).toBeVisible();
  const perf = page.locator('section[aria-labelledby="sc-perf"]');
  await expect(perf.locator('.glance-tile', { hasText: 'Clicks' })).toContainText('199');
  await expect(perf.locator('.glance-tile', { hasText: 'Impressions' })).toContainText('1,600');
  await expect(perf.getByRole('cell', { name: 'e2e coffee', exact: true })).toBeVisible();
  await perf.getByRole('tab', { name: 'Pages' }).click();
  await expect(perf.getByText('https://e2e.example/beans')).toBeVisible();
  await expect(perf).toContainText('never added together');
  const opp = page.locator('section[aria-labelledby="sc-opp"]');
  await expect(opp.getByRole('cell', { name: 'e2e coffee beans' })).toBeVisible();
  await expect(opp.getByRole('cell', { name: 'e2e coffee', exact: true })).toHaveCount(0);
  await opp.getByRole('button', { name: 'Turn the top 5 into ideas' }).click();
  await expect(opp.getByText(/ideas? added to the Idea Lab, each citing its Search Console evidence/)).toBeVisible();
});

test('the new screens are found by search and fit a 390 px phone', async ({ browser }) => {
  await seed();
  const ctx = await deviceContext(browser, true);
  const page = await ctx.newPage();
  watch(page);
  await signIn(page);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Search FUTUREGROW' });
  await palette.getByRole('combobox', { name: /^Search goals/ }).fill('payouts');
  await expect(palette.getByRole('option', { name: /Creator payouts/ }).first()).toBeVisible();
  await palette.getByRole('combobox', { name: /^Search goals/ }).fill('inventory');
  await expect(palette.getByRole('option', { name: /Product catalog/ }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  for (const [slug, title] of [
    ['catalog', 'Product catalog'],
    ['payouts', 'Creator payouts'],
    ['attribution', 'Attribution report'],
    ['search-console', 'Search Console'],
  ] as const) {
    await page.goto(`/app/${slug}`);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await overflow(page), slug).toBeLessThanOrEqual(1);
  }
  expect(problems.get(page) ?? []).toEqual([]);
  await ctx.close();
});
