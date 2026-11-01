import { expect, test } from '@playwright/test';
import { E2E_ORIGIN } from '../fixtures.js';

// Meta reviews these URLs: each must be its own public page (not the app shell), signed out, with real operator details.
const PAGES = [
  { path: '/privacy', h1: 'Privacy Policy', must: ['pages_manage_posts', 'ads_management', 'data deletion page'] },
  { path: '/terms', h1: 'Terms of Service', must: ['Acceptable use'] },
  { path: '/data-deletion', h1: 'Data deletion instructions', must: ['Business integrations', 'futuregrowth', 'Data deletion request'] },
];

for (const p of PAGES) {
  test(`${p.path} is a standalone public page`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const res = await page.goto(`${E2E_ORIGIN}${p.path}`);
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe(p.path);
    await expect(page.locator('h1')).toHaveText(p.h1);
    const text = await page.locator('main').innerText();
    for (const s of ['Futuregrowth', 'uprightseo24@gmail.com', ...p.must]) expect(text).toContain(s);
    expect(text).not.toMatch(/\[(?:Operator|Registered|privacy@|Country)[^\]]*\]/);
    expect(errors).toEqual([]);
  });
}
