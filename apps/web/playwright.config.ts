import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against an already-running stack (see README "End-to-end tests"):
 *   pnpm stack:up && pnpm db:migrate && pnpm db:seed
 *   pnpm --filter @gth/api dev & pnpm --filter @gth/web dev &
 */
export default defineConfig({
  testDir: './e2e',
  // Grants the creator role to the e2e account, which the app deliberately cannot do
  // to itself (SR-2.6).
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
