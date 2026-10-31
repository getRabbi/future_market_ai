import { type Browser, test as base, expect, type Page } from '@playwright/test';
import { E2E_ORIGIN, OWNER } from '../fixtures.js';

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

test('an owner turns the Autopilot on and starts a goal from one sentence; the worker runs it and the blockers are explained', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  // Off by default: the classic home offers it.
  await page.getByRole('button', { name: 'Turn on the Autopilot' }).click();
  await expect(page.getByRole('navigation', { name: 'Autopilot' })).toBeVisible();
  for (const name of ['Business setup', 'Growth goals', 'AI activity', 'Pending approvals', 'Results']) await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
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

  // Leave the organization on the classic home for the control-plane suite.
  await page.getByRole('button', { name: /Business setup/ }).click();
  await page.getByRole('button', { name: 'Turn the Autopilot off' }).click();
  await page.goto('/app/');
  await expect(page.getByRole('button', { name: 'Turn on the Autopilot' })).toBeVisible();
  await ctx.close();
});
