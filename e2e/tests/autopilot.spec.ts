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

const e2eDatabase = () => new pg.Client({ connectionString: fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.data/e2e-database-url'), 'utf8').trim() });

/**
 * Store reports need a real Google account to import, so this browser test seeds the rows an
 * import produces (one account, two apps, three reported days) directly into the e2e database.
 * The account's last sync found the optional Reporting API denied (B-023).
 */
async function seedStoreReports() {
  const db = e2eDatabase();
  await db.connect();
  try {
    const org = (await db.query<{ id: string }>(`select id from organization where slug = $1`, [ORG.slug])).rows[0]!.id;
    const conn = (await db.query<{ id: string }>(`insert into connections (tenant_id, provider, external_account_id, display_name, created_by) values ($1, 'google_play', 'pubsite_prod_rev_e2e', 'E2E Play account', 'e2e') returning id`, [org])).rows[0]!.id;
    const acct = (
      await db.query<{ id: string }>(
        `insert into store_accounts (tenant_id, connection_id, provider, account_ref, display_name, health_status, health_detail, last_success_at, next_sync_at, created_by) values ($1, $2, 'google_play', 'pubsite_prod_rev_e2e', 'E2E Play account', 'ok', '{"bucket":"pubsite_prod_rev_e2e","reporting":"permission_denied","appsInBucket":2,"appsInReportingApi":0}', now(), now() + interval '1 day', 'e2e') returning id`,
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
          await db.query<{ id: string }>(
            `insert into store_report_partitions (tenant_id, store_app_id, family, dimension, observation_date, report_file_id, source_rank, rows, digest, status) values ($1, $2, 'play.installs', 'country', (now() at time zone 'UTC')::date - $3::int, $4, 1, 1, 'e2e', 'provisional') returning id`,
            [org, app, ago, file],
          )
        ).rows[0]!.id;
        await db.query(
          `insert into store_metric_observations (tenant_id, partition_id, store_app_id, store_account_id, platform, app_id, provider, family, dimension, metric_key, source_metric, observation_date, dims, dims_key, value, report_file_id)
           values ($1, $2, $3, $4, 'android', $5, 'google_play', 'play.installs', 'country', 'play.daily_user_installs', 'Daily User Installs', (now() at time zone 'UTC')::date - $6::int, '{"country":"BD"}', '[["country","BD"]]', $7, $8)`,
          [org, part, app, acct, pkg, ago, base + ago, file],
        );
      }
    }
  } finally {
    await db.end();
  }
}

/**
 * A content studio draft from two Bangladesh days ago that was never submitted (the production
 * case: a 3 Nov draft still offered after its lesson went out on 6 Nov).
 */
async function seedStaleStudioDraft(): Promise<string> {
  const db = e2eDatabase();
  await db.connect();
  try {
    const org = (await db.query<{ id: string }>(`select id from organization where slug = $1`, [ORG.slug])).rows[0]!.id;
    const conn = (await db.query<{ id: string }>(`insert into connections (tenant_id, provider, external_account_id, display_name, created_by) values ($1, 'meta', 'e2e-lessons-page', 'E2E Lessons Page', 'e2e') returning id`, [org])).rows[0]!.id;
    const program = (await db.query<{ id: string }>(`insert into studio_programs (tenant_id, connection_id, pack, status, settings, created_by) values ($1, $2, 'eps-topik-bn', 'paused', '{}', 'e2e') returning id`, [org, conn])).rows[0]!.id;
    const item = (
      await db.query<{ id: string }>(
        `insert into content_plan_items (tenant_id, program_id, day, kind, unit_id, pack_version, objective, segment, template, palette, rationale, status) values ($1, $2, (now() at time zone 'Asia/Dhaka')::date - 2, 'vocab', 'v-anjeonmo', 'e2e', 'EDUCATE', 'beginners', 'vocab', 'navy', 'e2e', 'drafted') returning id`,
        [org, program],
      )
    ).rows[0]!.id;
    const post = (
      await db.query<{ id: string }>(
        `insert into social_posts (tenant_id, connection_id, platform, caption, asset_ids, claim_ids, disclosure, scheduled_at, status, status_reason, created_by) values ($1, $2, 'facebook', 'আজকের শব্দ: 안전모 — হেলমেট (stale e2e draft)', '{}', '{}', $3, now() - interval '2 days', 'draft', 'Studio draft from the verified curriculum', 'system:autopilot') returning id`,
        [org, conn, JSON.stringify({ review: { draftedBy: 'system:content-studio', planItemId: item, language: 'bn' } })],
      )
    ).rows[0]!.id;
    await db.query(`update content_plan_items set post_id = $1 where id = $2`, [post, item]);
    return post;
  } finally {
    await db.end();
  }
}

/**
 * A fixture action waiting for approval (as the gateway leaves a post that needs a person), walked
 * through the legal states the database guard allows. Returns its id; `cancelApproval` ends it.
 */
async function seedApproval(): Promise<string> {
  const db = e2eDatabase();
  await db.connect();
  try {
    const org = (await db.query<{ id: string }>(`select id from organization where slug = $1`, [ORG.slug])).rows[0]!.id;
    const id = (
      await db.query<{ id: string }>(
        `insert into action_requests (tenant_id, action_type, provider, target, params, action_hash, proposed_by_type, proposed_by_id, risk, idempotency_key, status_reason)
         values ($1, 'social.facebook.publish_post', 'meta', '{"pageId":"e2e-page"}', $2, repeat('a', 64), 'system', 'system:autopilot', '{}', gen_random_uuid()::text, 'Your publishing policy requires a person for this post') returning id`,
        [org, JSON.stringify({ caption: 'E2E lesson post waiting for approval', scheduledAt: new Date(Date.now() + 86_400_000).toISOString() })],
      )
    ).rows[0]!.id;
    for (const to of ['EVIDENCE_READY', 'POLICY_CHECKED', 'APPROVAL_REQUIRED']) await db.query(`update action_requests set status = $2 where id = $1`, [id, to]);
    return id;
  } finally {
    await db.end();
  }
}

async function cancelApproval(id: string) {
  const db = e2eDatabase();
  await db.connect();
  try {
    await db.query(`update action_requests set status = 'CANCELLED', status_reason = 'e2e fixture removed' where id = $1`, [id]);
  } finally {
    await db.end();
  }
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('an owner turns the Autopilot on and starts a goal from one sentence; the worker runs it and the blockers are explained', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  // One product: Home is the dashboard of the unified shell, whether or not the Autopilot is on.
  await expect(page.getByRole('heading', { level: 1, name: 'Your growth at a glance' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.locator('.area-glance')).toContainText('The Autopilot is off.');
  // Off by default: Onboarding & Setup offers it.
  await page.locator('.area-glance').getByRole('link', { name: 'Turn it on' }).click();
  await expect(page).toHaveURL(/\/app\/setup$/);
  await page.getByRole('button', { name: 'Turn the Autopilot on' }).click();
  await expect(page.getByRole('button', { name: 'Turn the Autopilot off' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Goals & OKRs' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Goals & OKRs' })).toBeVisible();
  await page.getByLabel('What do you want to achieve?').fill(SENTENCE);
  await page.getByRole('button', { name: 'Make a plan' }).click();
  await expect(page.getByText('Advertising budget: $0 (no paid ads)')).toBeVisible();
  await expect(page.getByLabel('Advertising budget for the whole goal (USD)')).toHaveValue('0');
  await expect(page.getByRole('checkbox', { name: 'Paid ads' })).toBeDisabled();
  await page.getByRole('button', { name: 'Start the Autopilot for this goal' }).click();
  const card = page.locator('section.ap-goal').first();
  await expect(card.getByRole('heading', { name: /Grow app store first-time downloads/i })).toBeVisible();
  await expect(card).toContainText('$0');

  // The background worker (no browser involvement) runs the first cycle; the control center polls persisted state.
  await page.goto('/app/autopilot');
  await expect(page.getByRole('heading', { level: 1, name: 'Autopilot (Growth Engine)' })).toBeVisible();
  const blocked = page.locator('section', { has: page.getByRole('heading', { name: 'Blocked — needs you' }) });
  await expect(blocked).toContainText('App Store Connect', { timeout: 120_000 });
  // No model is configured in this stack: AI steps say so instead of producing anything.
  await expect(blocked).toContainText('No approved AI model', { timeout: 60_000 });
  await expect(blocked.getByRole('link', { name: 'Add or connect KPI data' }).first()).toBeVisible();
  const done = page.locator('section', { has: page.getByRole('heading', { name: 'Completed' }) });
  await expect(done).toContainText('Check data, connections and open work');

  // Home: the next best action is the real blocker, linked to the exact goal; nothing waits for approval.
  await page.goto('/app/');
  const next = page.locator('.area-next');
  await expect(next.getByRole('heading', { name: 'Next best action' })).toBeVisible();
  await expect(next).toContainText('Unblock', { timeout: 30_000 });
  await expect(next.getByRole('link', { name: 'See what is blocked' })).toHaveAttribute('href', /\/app\/goals\?id=/);
  await expect(next.getByRole('link', { name: /Review & approve/ })).toHaveCount(0);
  await expect(page.locator('.area-glance')).toContainText('Needs attention');

  await page.goto('/app/approvals');
  await expect(page.getByText('Nothing waits for you')).toBeVisible();
  // Goal details: execution timeline, results not measured yet.
  await page.goto('/app/goals');
  await page
    .getByRole('link', { name: /Details & timeline/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/app\/goals\?id=/);
  await expect(page.getByRole('heading', { name: 'Execution timeline' })).toBeVisible();
  await expect(page.getByText(/No measured results yet/)).toBeVisible();
  await expect(page.getByText(/Cycle 1/).first()).toBeVisible();
  // D-040: the content studio offers daily lessons once a Page is connected, and the community workspace.
  await page.goto('/app/content');
  await expect(page.getByRole('heading', { name: 'Daily lessons for your Facebook Page' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Community groups' })).toBeVisible();
  await page.goto('/app/setup');
  await expect(page.getByText('No KPI data yet', { exact: false })).toBeVisible();

  // Every former Advanced-workspace tool is in the same shell; old addresses keep working.
  await page.goto('/app/advanced');
  await expect(page).toHaveURL(/\/app\/tools$/);
  await expect(page.getByRole('heading', { level: 1, name: 'All tools' })).toBeVisible();
  await expect(page.locator('.tool-card')).toHaveCount(41);
  await page.goto('/app/?view=goals');
  await expect(page).toHaveURL(/\/app\/goals$/);
  await page.goto('/app/brain');
  await expect(page.getByRole('heading', { level: 1, name: /Growth Brain/i })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Apps & Intelligence');
});

test('global search reaches every tool from the keyboard, and the notification bell opens the exact approval', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Your growth at a glance' })).toBeVisible();
  // Ctrl+K opens the palette; module ids and plain words both work; Enter opens the page.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search FUTUREGROW' });
  await expect(palette).toBeVisible();
  const box = palette.getByRole('combobox', { name: /^Search goals/ });
  await expect(box).toBeFocused();
  await box.fill('M17');
  await expect(palette.getByRole('option', { name: /Campaigns & paid media/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/app\/ads$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns & paid media' })).toBeVisible();
  // Records too: the goal created above, by name.
  await page.getByRole('button', { name: /^Search goals/ }).click();
  await page.getByRole('combobox', { name: /^Search goals/ }).fill('first-time downloads');
  await expect(page.getByRole('dialog', { name: 'Search FUTUREGROW' }).getByRole('group', { name: 'Goals', exact: true }).getByRole('option').first()).toContainText(/Grow app store first-time downloads/i, { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Search FUTUREGROW' })).toHaveCount(0);

  // A real approval reaches the bell; it opens that exact action.
  const id = await seedApproval();
  try {
    await page.goto('/app/');
    const bell = page.getByRole('button', { name: /^Notifications/ });
    await expect(bell).toHaveAccessibleName(/1 need you/, { timeout: 20_000 });
    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await panel.getByRole('link', { name: /Facebook post needs your approval/ }).click();
    await expect(page).toHaveURL(new RegExp(`/app/approvals\\?id=${id}$`));
    const detail = page.getByRole('dialog', { name: 'Facebook post' });
    await expect(detail).toContainText('What will happen');
    await expect(detail.getByRole('button', { name: 'Approve exactly this action' })).toBeVisible();
    // Home's next best action now points at the same item.
    await page.goto('/app/');
    await expect(page.locator('.area-next').getByRole('link', { name: 'Review & approve' })).toHaveAttribute('href', `/app/approvals?id=${id}`);
  } finally {
    await cancelApproval(id);
  }
});

test('Home never claims "on track" before its data arrived, and says so when a list fails', async ({ page }) => {
  await signIn(page);
  // Slow approvals: the card stays a skeleton (no premature verdict) until the request settles.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(/\/v1\/actions\?status=APPROVAL_REQUIRED/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/app/');
  const next = page.locator('.area-next');
  await expect(next.getByRole('status')).toContainText('Working out your next best action');
  await expect(next).not.toContainText("You're on track");
  await expect(next).not.toContainText('Unblock');
  release();
  await expect(next).toContainText('Unblock', { timeout: 20_000 });
  await page.unroute(/\/v1\/actions\?status=APPROVAL_REQUIRED/);

  // A failing list is an error, not "nothing needs you".
  await page.route('**/v1/governance/incidents', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"INTERNAL","message":"internal error"}}' }));
  await page.goto('/app/');
  await expect(next.getByRole('alert')).toContainText('Could not check everything that may need you');
  await expect(next).not.toContainText("You're on track");
  // The rest of the dashboard keeps working.
  await expect(page.getByRole('heading', { name: 'Your growth journey' })).toBeVisible();
});

test('on a 390 px phone the unified shell fits the screen, and store reports keep missing days apart from zeros', async ({ browser }) => {
  const ctx = await deviceContext(browser, true);
  const page = await ctx.newPage();
  watch(page);
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Your growth at a glance' })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  // Search and the menu stay reachable on a phone; every group of the navigation is in the drawer.
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Goals & OKRs' })).toBeInViewport();
  await nav.getByRole('link', { name: 'Goals & OKRs' }).click();
  await expect(page.locator('section.ap-goal').first()).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await page.goto('/app/autopilot');
  await expect(page.getByRole('heading', { name: 'Blocked — needs you' })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  expect(problems.get(page) ?? []).toEqual([]);

  // App intelligence (D-045): two apps of one developer account, seeded as imported report rows.
  await seedStoreReports();
  await page.goto('/app/apps');
  await expect(page.getByRole('heading', { level: 1, name: 'Apps & Store Reports' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Alpha Lessons/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Beta Words/ })).toBeVisible();
  // D-047: the default period is a complete reporting window that ends on the last reported day (3 days ago),
  // unpublished days are named, open totals say which apps miss days, and the optional API is a warning.
  await expect(page.getByLabel('Period')).toHaveValue('r28');
  await expect(page.getByText(/28 days, complete reporting window/)).toBeVisible();
  await expect(page.getByText(/the 2 newer days are not published by the store yet and left out/)).toBeVisible();
  await expect(page.getByText(/not totalled: Alpha Lessons reported 3 of 28 days; Beta Words reported 3 of 28 days/).first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Optional Google Play Developer Reporting API: permission denied' })).toContainText('not blocking');
  await expect(page.getByText(/\d{4}-\d{2}-\d{2}T\d{2}:/)).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: /Alpha Lessons/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Alpha Lessons' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Report coverage and freshness' })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Developer accounts & apps' }).click();
  await expect(page.getByText('E2E Play account')).toBeVisible();
  const reportingWarning = page.getByRole('status').filter({ hasText: 'Optional Google Play Developer Reporting API: permission denied' });
  await expect(reportingWarning).toContainText('What to do:');
  await expect(reportingWarning).toContainText('View app information');
  await expect(reportingWarning).toContainText('never shown as zero');
  await expect(page.getByRole('heading', { name: 'Connect a developer account' })).toBeVisible();
  await expect(page.getByLabel('Service account key (JSON file)')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);

  // Home: the performance chart states missing days (gaps, never zero), the optional API is an optional
  // enhancement (not a failure), and the chart leads into that app's report.
  await page.goto('/app/');
  const perf = page.getByRole('region', { name: 'Performance' });
  await expect(perf).toContainText(/total open: 3 of 28 days reported/);
  await expect(perf).toContainText('shown as gaps, not zero');
  const blockers = page.locator('.area-blockers');
  // The card shows the three most severe; the optional API sorts after real problems, so read the full list.
  await expect(blockers.getByRole('button', { name: /View all/ })).toBeVisible({ timeout: 20_000 });
  await blockers.getByRole('button', { name: /View all/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Blockers' });
  await expect(drawer).toContainText('Google Play Developer Reporting API', { timeout: 20_000 });
  await expect(drawer.locator('.blocker-detail', { hasText: 'Reporting API' })).toContainText('Optional enhancement');
  await expect(drawer.locator('.blocker-detail', { hasText: 'Reporting API' })).not.toContainText('Critical problem');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await perf.getByRole('link', { name: /Open the app report/ }).click();
  await expect(page).toHaveURL(/\/app\/apps\?app=/);
  await expect(page.getByRole('heading', { level: 2, name: /Alpha Lessons|Beta Words/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Report coverage and freshness' })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  expect(problems.get(page) ?? []).toEqual([]);

  // D-047: a studio draft whose day passed unsubmitted is no longer offered once the studio refreshes its plan.
  await seedStaleStudioDraft();
  await page.goto('/app/approvals');
  await expect(page.getByRole('heading', { name: 'Facebook post drafts' })).toBeVisible();
  await expect(page.getByText(/stale e2e draft/)).toBeVisible();
  await page.goto('/app/content');
  await expect(page.getByText(/Expired: the draft's day \(\d{4}-\d{2}-\d{2}\) passed before it was submitted/)).toBeVisible({ timeout: 20_000 });
  await page.goto('/app/approvals');
  await expect(page.getByText('Nothing waits for you')).toBeVisible();
  await expect(page.getByText(/stale e2e draft/)).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  expect(problems.get(page) ?? []).toEqual([]);

  // Leave the Autopilot off for the control-plane suite.
  await page.goto('/app/setup');
  await page.getByRole('button', { name: 'Turn the Autopilot off' }).click();
  await expect(page.getByRole('button', { name: 'Turn the Autopilot on' })).toBeVisible();
  await ctx.close();
});
