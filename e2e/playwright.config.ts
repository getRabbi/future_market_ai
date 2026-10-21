import { defineConfig, devices } from '@playwright/test';
import { E2E_ORIGIN } from './fixtures.js';

/**
 * Browser end-to-end tests of the control plane (B-017). The flows share one seeded database and
 * run in order (password change and two-factor enrolment change the owner's credentials).
 * Build the web app first: `PUBLIC_API_BASE= npm run build -w @futuregrow/web`.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../dist/e2e-report' }]] : [['list']],
  outputDir: '../dist/e2e-results',
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx tsx e2e/server.ts',
    cwd: '..',
    url: `${E2E_ORIGIN}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
