import { type Browser, test as base, expect, type Page } from '@playwright/test';
import { SECTIONS } from '../../apps/web/src/lib/catalog.js';
import { E2E_ORIGIN, ORG, OWNER, totp } from '../fixtures.js';

/**
 * Each browser context is a separate device with its own client address (as behind the Pages
 * proxy), so Better Auth's per-IP sign-in limits apply per device rather than to the whole suite.
 */
let ipSeq = 1;
const deviceContext = (browser: Browser) => browser.newContext({ baseURL: E2E_ORIGIN, extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${ipSeq++}` } });
const test = base.extend({
  context: async ({ browser }, use) => {
    const ctx = await deviceContext(browser);
    await use(ctx);
    await ctx.close();
  },
});

/**
 * Click-through of the control plane against the real API and database. The tests run in order
 * and carry the owner's credentials forward (password change, then two-factor enrolment).
 */
test.describe.configure({ mode: 'serial' });

const state = { password: OWNER.password, totpSecret: null as string | null, lastCode: null as string | null };
const NEW_PASSWORD = 'e2e-rotated-harbour-passphrase-91';
const problems = new WeakMap<Page, string[]>();

/** Any page error or console error (CSP violations included) fails the test. */
function watch(page: Page) {
  const list: string[] = [];
  problems.set(page, list);
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Expected HTTP failures (e.g. a wrong password => 401) are asserted in the UI instead.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) list.push(`console: ${m.text()}`);
  });
}

test.beforeEach(async ({ page }) => watch(page));
test.afterEach(async ({ page }) => {
  expect(problems.get(page) ?? [], 'page errors / console errors (CSP violations included)').toEqual([]);
});

/** A code from the authenticator, never the one just used (TOTP codes are valid once per step). */
async function nextCode(): Promise<string> {
  for (;;) {
    const code = totp(state.totpSecret!);
    if (code !== state.lastCode) {
      state.lastCode = code;
      return code;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function signIn(page: Page, email: string, password: string, opts: { totp?: boolean } = {}) {
  if (!page.url().includes('/login')) await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Continue' }).click();
  if (opts.totp) {
    await expect(page.getByLabel('Authentication code')).toBeVisible();
    await page.getByLabel('Authentication code').fill(await nextCode());
    await page.getByRole('button', { name: 'Verify' }).click();
  }
}

async function signOut(page: Page) {
  await page.goto('/app/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

async function freshPage(browser: Browser) {
  const ctx = await deviceContext(browser);
  const page = await ctx.newPage();
  watch(page);
  return page;
}

test('unauthenticated visits go to the login page; a wrong password is refused', async ({ page }) => {
  await page.goto('/app/governance');
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fgovernance/);
  await expect(page.getByRole('heading', { name: 'Sign in to FUTUREGROW' })).toBeVisible();
  await signIn(page, OWNER.email, 'definitely-not-the-password');
  await expect(page.getByRole('alert')).toContainText(/invalid email or password/i);
  await expect(page).toHaveURL(/\/login/);
});

test('the owner signs in, returns to the requested section, and every module section renders', async ({ page }) => {
  await page.goto('/app/governance');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, OWNER.email, state.password);
  await expect(page).toHaveURL(/\/app\/governance$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Governance' })).toBeVisible();
  await expect(page.locator('#org')).toHaveValue(/.+/);
  await expect(page.locator('#org option:checked')).toHaveText(ORG.name);

  for (const s of SECTIONS) {
    await page.goto(s.slug === 'overview' ? '/app/' : `/app/${s.slug}`);
    await expect(page.getByRole('heading', { level: 1, name: s.title, exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    // Lists load without errors (GET endpoints need no two-factor session).
    await expect(page.locator('.notice.error'), `section ${s.slug}`).toHaveCount(0);
  }
});

test('change password: the old password stops working and other sessions are signed out', async ({ page, browser }) => {
  await signIn(page, OWNER.email, state.password);
  await expect(page).toHaveURL(/\/app\/$/);
  // A second device that must lose its session.
  const other = await freshPage(browser);
  await signIn(other, OWNER.email, state.password);
  await expect(other).toHaveURL(/\/app\/$/);

  await page.goto('/app/settings');
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Change password' }) });
  await card.getByLabel('Current password').fill('wrong-current-password');
  await card.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await card.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await card.getByRole('button', { name: 'Change password' }).click();
  await expect(card.getByRole('alert')).toContainText('current password is incorrect');

  await card.getByLabel('Current password').fill(state.password);
  await card.getByLabel('Confirm new password').fill(`${NEW_PASSWORD}x`);
  await expect(card.getByText('The two new passwords do not match.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Change password' })).toBeDisabled();
  await card.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await card.getByRole('button', { name: 'Change password' }).click();
  await expect(card.getByRole('status')).toContainText('Password changed');
  state.password = NEW_PASSWORD;

  // This session continues; the other device is sent to the login page.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Account & security' })).toBeVisible();
  await expect(card).toContainText('Last changed');
  await other.goto('/app/');
  await expect(other).toHaveURL(/\/login/);

  await signOut(page);
  await signIn(page, OWNER.email, OWNER.password);
  await expect(page.getByRole('alert')).toContainText(/invalid email or password/i);
  await signIn(page, OWNER.email, state.password);
  await expect(page).toHaveURL(/\/app\/$/);
  await other.context().close();
});

test('two-factor enrolment, then sign-in requires the authenticator code', async ({ page }) => {
  await signIn(page, OWNER.email, state.password);
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto('/app/settings');
  await page.getByLabel('Confirm your password').fill(state.password);
  await page.getByRole('button', { name: 'Turn on two-factor' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await page.getByText("Can't scan? Enter a setup key instead").click();
  const key = page.locator('code.mono').first();
  await expect(key).toBeVisible();
  state.totpSecret = (await key.innerText()).replace(/\s+/g, '');
  expect(state.totpSecret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.locator('#code').fill(await nextCode());
  await page.getByRole('button', { name: 'Verify and enable' }).click();
  await expect(page.getByText('Two-factor is on.')).toBeVisible();
  // The same session counts as two-factor straight away; no re-login needed.
  await expect(page.locator('section', { hasText: 'Two-factor authentication (TOTP)' }).getByText('active')).toBeVisible();

  await signOut(page);
  await signIn(page, OWNER.email, state.password, { totp: true });
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto('/app/settings');
  await expect(page.locator('section', { hasText: 'Two-factor authentication (TOTP)' }).getByText('active')).toBeVisible();

  // "Remember this device" is ticked by default: the next sign-in in this browser skips the code
  // (other tests use fresh browsers and still have to enter it).
  await signOut(page);
  await signIn(page, OWNER.email, state.password);
  await expect(page).toHaveURL(/\/app\/$/);
});

test('with a two-factor session the owner engages and releases a kill switch, and the audit chain verifies', async ({ page }) => {
  await signIn(page, OWNER.email, state.password, { totp: true });
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto('/app/governance');
  const ks = page.locator('section', { has: page.getByRole('heading', { name: 'Kill switches' }) });
  await ks.getByLabel('Scope').selectOption('connector');
  await ks.getByLabel('Target').fill('meta');
  await ks.getByLabel('Reason').fill('E2E drill: suspicious spend spike');
  await ks.getByRole('button', { name: 'Engage' }).click();
  const row = ks.locator('tr', { hasText: 'E2E drill: suspicious spend spike' });
  await expect(row.getByRole('button', { name: 'Release' })).toBeVisible();
  await expect(ks.getByText('1 engaged')).toBeVisible();
  await row.getByRole('button', { name: 'Release' }).click();
  await expect(row.getByRole('button', { name: 'Release' })).toHaveCount(0);
  await expect(ks.locator('.notice.error')).toHaveCount(0);

  await page.goto('/app/audit');
  await page.getByRole('button', { name: 'Verify chain now' }).click();
  await expect(page.getByText(/Chain intact: \d+ records verified/)).toBeVisible();
  const records = page.locator('section', { has: page.getByRole('heading', { name: 'Recent records' }) });
  await expect(records).toContainText('auth.password_changed');
  await expect(records).toContainText('governance.kill_switch.engaged');
});

test('an invited approver joins through the invitation link', async ({ page, browser }) => {
  await signIn(page, OWNER.email, state.password, { totp: true });
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto('/app/settings');
  const members = page.locator('section', { has: page.getByRole('heading', { name: 'Members' }) });
  const invitee = { email: 'approver@e2e.futuregrow.test', password: 'e2e-joining-meadow-passphrase-55', name: 'E2E Approver' };
  await members.getByLabel('Email').fill(invitee.email);
  await members.getByLabel('Role').selectOption('approver');
  await members.getByRole('button', { name: 'Create invitation' }).click();
  const link = await members.locator('.notice.ok code').innerText();
  expect(link).toMatch(/\/invite\?id=/);

  const guest = await freshPage(browser);
  await guest.goto(link);
  await expect(guest.getByRole('heading', { name: 'Join FUTUREGROW' })).toBeVisible();
  await guest.getByLabel('Name').fill(invitee.name);
  await guest.getByLabel('Email').fill(invitee.email);
  await guest.getByLabel('Password (12+ characters)').fill(invitee.password);
  await guest.getByRole('button', { name: 'Create account and join' }).click();
  await expect(guest).toHaveURL(/\/app\/settings$/);
  await expect(guest.getByRole('heading', { level: 1, name: 'Account & security' })).toBeVisible();
  await expect(guest.locator('.who')).toHaveText('approver');
  await guest.context().close();

  await page.reload();
  await expect(members.locator('table')).toContainText(invitee.email);
});
