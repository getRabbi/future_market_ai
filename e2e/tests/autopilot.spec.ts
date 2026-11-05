import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, test as base, expect, type Page } from '@playwright/test';
import pg from 'pg';
import { E2E_ORIGIN, ORG, OWNER } from '../fixtures.js';

/**
 * The Autopilot home in a real browser against the real API, database and a running Graphile
 * worker (e2e/server.ts). Runs before control-plane.spec.ts (initial owner password, no
 * two-factor) and switches the Autopilot off again at the end, so that suite sees the classic home.
 */
let ipSeq = 101;
const deviceContext = (browser: Browser, phone = false) => browser.newContext({ baseURL: E2E_ORIGIN, extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${ipSeq++}` }, ...(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}) });
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

const SENTENCE = "Grow my app's organic downloads over the next 30 days with a $0 advertising budget.";

/**
 * Store reports need a real Google account to import, so this browser test seeds the rows an
 * import produces (one account, two apps, three reported days) directly into the e2e database.
 */
async function seedStoreReports() {
  const url = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.data/e2e-database-url'), 'utf8').trim();
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const org = (await db.query<{ id: string }>(`select id from organization where slug = $1`, [ORG.slug])).rows[0]!.id;
    const conn = (await db.query<{ id: string }>(`insert into connections (tenant_id, provider, external_account_id, display_name, created_by) values ($1, 'google_play', 'pubsite_prod_rev_e2e', 'E2E Play account', 'e2e') returning id`, [org])).rows[0]!.id;
    const acct = (
      await db.query<{ id: string }>(
        `insert into store_accounts (tenant_id, connection_id, provider, account_ref, display_name, health_status, last_success_at, next_sync_at, created_by) values ($1, $2, 'google_play', 'pubsite_prod_rev_e2e', 'E2E Play account', 'ok', now(), now() + interval '1 day', 'e2e') returning id`,
        [org, conn],
      )
    ).rows[0]!.id;
    for (const [pkg, name, base] of [
      ['com.example.alpha', 'Alpha Lessons', 12],
      ['com.example.beta', 'Beta Words', 4],
    ] as const) {
      const app = (await db.query<{ id: string }>(`insert into store_apps (tenant_id, store_account_id, platform, app_id, display_name, status, discovered_via, confirmed_by, confirmed_at) values ($1, $2, 'android', $3, $4, 'confirmed', '{report_bucket}', 'e2e', now()) returning id`, [org, acct, pkg, name])).rows[0]!
        .id;
      const file = (
        await db.query<{ id: string }>(
          `insert into store_report_files (tenant_id, store_account_id, store_app_id, provider, family, dimension, period, source_uri, source_version, source_rank, size_bytes, sha256, status) values ($1, $2, $3, 'google_play', 'play.installs', 'country', to_char(now(), 'YYYY-MM'), $4, '1', 1, 1, 'e2e', 'imported') returning id`,
          [org, acct, app, `gs://pubsite_prod_rev_e2e/stats/installs/installs_${pkg}_x_country.csv`],
        )
      ).rows[0]!.id;
      for (const ago of [5, 4, 3]) {
        const part = (
          await db.query<{ id: string }>(`insert into store_report_partitions (tenant_id, store_app_id, family, dimension, observation_date, report_file_id, source_rank, rows, digest, status) values ($1, $2, 'play.installs', 'country', current_date - $3::int, $4, 1, 1, 'e2e', 'provisional') returning id`, [
            org,
            app,
            ago,
            file,
          ])
        ).rows[0]!.id;
        await db.query(
          `insert into store_metric_observations (tenant_id, partition_id, store_app_id, store_account_id, platform, app_id, provider, family, dimension, metric_key, source_metric, observation_date, dims, dims_key, value, report_file_id)
           values ($1, $2, $3, $4, 'android', $5, 'google_play', 'play.installs', 'country', 'play.daily_user_installs', 'Daily User Installs', current_date - $6::int, '{"country":"BD"}', '[["country","BD"]]', $7, $8)`,
          [org, part, app, acct, pkg, ago, base + ago, file],
        );
      }
    }
  } finally {
    await db.end();
  }
}

test('an owner turns the Autopilot on and starts a goal from one sentence; the worker runs it and the blockers are explained', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  // Off by default: the classic home offers it.
  await page.getByRole('button', { name: 'Turn on the Autopilot' }).click();
  await expect(page.getByRole('navigation', { name: 'Autopilot' })).toBeVisible();
  for (const name of ['Business setup', 'Growth goals', 'Content studio', 'AI activity', 'Pending approvals', 'Results']) await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Growth goals' })).toBeVisible();

  await page.getByLabel('What do you want to achieve?').fill(SENTENCE);
  await page.getByRole('button', { name: 'Make a plan' }).click();
  await expect(page.getByText('Advertising budget: $0 (no paid ads)')).toBeVisible();
  await expect(page.getByLabel('Advertising budget for the whole goal (USD)')).toHaveValue('0');
  await expect(page.getByRole('checkbox', { name: 'Paid ads' })).toBeDisabled();
  await page.getByRole('button', { name: 'Start the Autopilot for this goal' }).click();
  const card = page.locator('section.ap-goal').first();
  await expect(card.getByRole('heading', { name: /Grow app store first-time downloads/i })).toBeVisible();
  await expect(card).toContainText('$0');

  // The background worker (no browser involvement) runs the first cycle; the page polls persisted state.
  await page.getByRole('button', { name: /AI activity/ }).click();
  const blocked = page.locator('section', { has: page.getByRole('heading', { name: 'Blocked — needs you' }) });
  await expect(blocked).toContainText('App Store Connect', { timeout: 120_000 });
  // No model is configured in this stack: AI steps say so instead of producing anything.
  await expect(blocked).toContainText('No approved AI model', { timeout: 60_000 });
  await expect(blocked.getByRole('link', { name: 'Add or connect KPI data' }).first()).toBeVisible();
  const done = page.locator('section', { has: page.getByRole('heading', { name: 'Completed' }) });
  await expect(done).toContainText('Check data, connections and open work');

  await page.getByRole('button', { name: /Pending approvals/ }).click();
  await expect(page.getByText('Nothing waits for you')).toBeVisible();
  await page.getByRole('button', { name: /Results/ }).click();
  await expect(page.getByText(/No measured results yet/)).toBeVisible();
  await expect(page.getByText(/Cycle 1/)).toBeVisible();
  // D-040: the content studio offers daily lessons once a Page is connected, and the community workspace.
  await page.getByRole('button', { name: /Content studio/ }).click();
  await expect(page.getByRole('heading', { name: 'Daily lessons for your Facebook Page' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Community groups' })).toBeVisible();
  await page.getByRole('button', { name: /Business setup/ }).click();
  await expect(page.getByText('No KPI data yet', { exact: false })).toBeVisible();

  // The full operator workspace stays one click away and keeps working.
  await page.getByRole('link', { name: 'Advanced workspace' }).click();
  await expect(page).toHaveURL(/\/app\/advanced$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('link', { name: '← Back to the Autopilot' })).toBeVisible();
  await page.goto('/app/brain');
  await expect(page.getByRole('heading', { level: 1, name: /Growth Brain/i })).toBeVisible();
});

test('on a 390 px phone the Autopilot home fits the screen and the goal is readable', async ({ browser }) => {
  const ctx = await deviceContext(browser, true);
  const page = await ctx.newPage();
  watch(page);
  await signIn(page);
  await expect(page.getByRole('navigation', { name: 'Autopilot' })).toBeVisible();
  await expect(page.locator('section.ap-goal').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: /AI activity/ }).click();
  await expect(page.getByRole('heading', { name: 'Blocked — needs you' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  expect(problems.get(page) ?? []).toEqual([]);

  // App intelligence (D-045): two apps of one developer account, seeded as imported report rows.
  await seedStoreReports();
  await page.getByRole('button', { name: /App intelligence/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'App intelligence' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Alpha Lessons/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Beta Words/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: /Alpha Lessons/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Alpha Lessons' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Report coverage and freshness' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Developer accounts & apps' }).click();
  await expect(page.getByText('E2E Play account')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect a developer account' })).toBeVisible();
  await expect(page.getByLabel('Service account key (JSON file)')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  expect(problems.get(page) ?? []).toEqual([]);

  // Leave the organization on the classic home for the control-plane suite.
  await page.getByRole('button', { name: /Business setup/ }).click();
  await page.getByRole('button', { name: 'Turn the Autopilot off' }).click();
  await page.goto('/app/');
  await expect(page.getByRole('button', { name: 'Turn on the Autopilot' })).toBeVisible();
  await ctx.close();
});
