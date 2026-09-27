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
    /**
     * `localhost`, matching `APP_BASE_URL` — and it has to match, because cookies are
     * host-scoped.
     *
     * Any redirect the app builds from `APP_BASE_URL` (Checkout's `success_url`, Connect's
     * `return_url`) sends the browser to that host. If the suite browses `127.0.0.1:3000` while
     * those land on `localhost:3000`, the session cookie set on one is invisible on the other,
     * and a signed-in test waits for a logged-in page that can never arrive. That fails by
     * **timing out**, not by asserting — the whole job was cancelled at its limit, with no
     * failed expectation to point at.
     *
     * The server still binds `127.0.0.1`, which is fine and was already proven: the passkey
     * suites have always loaded `localhost:3000` against exactly that, because WebAuthn refuses
     * an IP address as a relying party. This just makes the rest of the suite agree with them,
     * so there is one host for the whole site instead of two.
     */
    baseURL: process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
