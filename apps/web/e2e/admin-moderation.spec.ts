import { createDb } from '@gth/db';
import { expect, test } from '@playwright/test';
import {
  PASSKEY_BASE_URL,
  asNewClient,
  forgetPasskeySession,
  restorePasskey,
  signIn,
  signInWithPasskeyOnce,
} from './helpers';

/**
 * The moderation console end to end (SR-3.5, SR-4.4, SR-1.10).
 *
 * On localhost, because the console needs a passkey session and WebAuthn will not bind a
 * passkey to an IP address (ADR-025). Global setup leaves exactly one reported price and one
 * held sale in the queue on every run, and an admin account with no passkey yet.
 */
test.use({ baseURL: PASSKEY_BASE_URL });

const ADMIN_EMAIL = process.env['E2E_ADMIN_EMAIL'] ?? 'admin@example.test';
const CREATOR_EMAIL = process.env['E2E_CREATOR_EMAIL'] ?? 'creator@example.test';

/** Make every session the admin holds look as though it was opened `hours` ago. */
async function ageAdminSessions(hours: number): Promise<void> {
  const url = process.env['DATABASE_URL_MIGRATOR'];
  if (!url) throw new Error('DATABASE_URL_MIGRATOR is required to age a session');
  const { db, close } = createDb({ url, max: 1 });
  try {
    await db.execute(
      `update app.sessions set created_at = now() - interval '${String(hours)} hours'
        where user_id = 'e2e-admin'`,
    );
  } finally {
    await close();
  }
}

test.describe('moderation console', () => {
  test('is closed to an account that is not an admin', async ({ page }) => {
    // Not `signInOnce`: that cache is shared by every spec, and cookies set here belong to
    // localhost. A later spec on 127.0.0.1 reusing them would be silently signed out.
    await signIn(page, CREATOR_EMAIL);
    await page.goto('/admin/moderation');
    await expect(page.getByTestId('admin-forbidden')).toBeVisible();
    // And it describes nothing about what an admin would see.
    await expect(page.getByTestId('reports-section')).toHaveCount(0);
  });

  test('asks an admin signed in by email for their passkey, not another email', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL);
    await page.goto('/admin/moderation');
    // Signed in seconds ago, and still one factor. "Sign in again" would loop through the
    // same inbox; the page asks for the thing that is actually missing.
    const prompt = page.getByTestId('step-up-required');
    await expect(prompt).toHaveAttribute('data-reason', 'passkey_required');
    await expect(prompt).toContainText('passkey');
    await expect(page.getByTestId('enroll-link')).toHaveAttribute('href', '/account/security');
  });

  test('shows both queues, each with the evidence a reviewer needs', async ({ page }) => {
    await signInWithPasskeyOnce(page, ADMIN_EMAIL);
    await page.goto('/admin/moderation');

    const held = page.getByTestId('queue-flags').filter({ hasText: '$987.65' });
    await expect(held).toBeVisible();
    await expect(held.getByRole('link', { name: 'evidence' })).toHaveAttribute(
      'href',
      'https://e2e.invalid/vod?t=90',
    );
    // Opened by an admin whose session can change published prices, so it gets no window
    // handle back to this tab.
    await expect(held.getByRole('link', { name: 'evidence' })).toHaveAttribute('rel', /noopener/);

    const report = page.getByTestId('queue-reports').filter({ hasText: '$12.34' });
    await expect(report).toBeVisible();
    // Who sent it is deliberately absent.
    await expect(report).not.toContainText(CREATOR_EMAIL);
  });

  test('will not decide without a reason', async ({ page }) => {
    await signInWithPasskeyOnce(page, ADMIN_EMAIL);
    await page.goto('/admin/moderation');

    const report = page.getByTestId('queue-reports').filter({ hasText: '$12.34' });
    await report.getByTestId('decision-accept').click();
    await expect(report.getByTestId('decision-error')).toContainText('Say why first');
  });

  test('approves a report and clears a held sale, each with a reason', async ({ page }) => {
    await signInWithPasskeyOnce(page, ADMIN_EMAIL);
    await page.goto('/admin/moderation');

    const report = page.getByTestId('queue-reports').filter({ hasText: '$12.34' });
    await report.getByTestId('decision-reason').fill('Receipt matches the listing');
    await report.getByTestId('decision-accept').click();
    await expect(page.getByTestId('decided-reports')).toContainText('Receipt matches the listing');

    const held = page.getByTestId('queue-flags').filter({ hasText: '$987.65' });
    await held.getByTestId('decision-reason').fill('Watched the VOD — it sold for that');
    await held.getByTestId('decision-accept').click();
    await expect(page.getByTestId('decided-flags')).toContainText('Cleared');

    // Decided items leave the queue for good.
    await page.reload();
    await expect(page.getByTestId('queue-reports').filter({ hasText: '$12.34' })).toHaveCount(0);
    await expect(page.getByTestId('queue-flags').filter({ hasText: '$987.65' })).toHaveCount(0);
  });

  test('asks a stale admin to sign in with their passkey again, and brings them back', async ({
    page,
  }) => {
    await signInWithPasskeyOnce(page, ADMIN_EMAIL);
    await ageAdminSessions(13);
    forgetPasskeySession(ADMIN_EMAIL);

    await page.goto('/admin/moderation');
    // Still signed in — every other page works — but not recently enough for this one.
    await expect(page.getByTestId('step-up-required')).toHaveAttribute('data-reason', 'step_up');
    await page.getByTestId('step-up-link').click();
    await expect(page.getByTestId('step-up-notice')).toBeVisible();

    // A passkey sign-in straight from that page; `next` brings them back to the console.
    const siteOrigin = new URL(page.url()).origin;
    await asNewClient(page);
    await restorePasskey(page, ADMIN_EMAIL);
    await page.getByTestId('passkey-sign-in').click();

    // Back on the *site*, not merely at a URL ending in the right path — the API answers that
    // path too, with a 404, and an earlier version of this test was fooled by exactly that.
    await page.waitForURL(`${siteOrigin}/admin/moderation`);
    await expect(page.getByTestId('held-section')).toBeVisible();
  });

  test('refuses to send anyone off-site after signing in (SR-X.13)', async ({ page }) => {
    await asNewClient(page);
    // Watch what the form actually asks the auth server to redirect to. That is the value
    // that matters — not what the page happens to contain as text.
    let callbackURL: string | undefined;
    await page.route('**/api/auth/sign-in/magic-link', async (route) => {
      callbackURL = (route.request().postDataJSON() as { callbackURL?: string }).callbackURL;
      await route.continue();
    });

    await page.goto('/sign-in?next=https%3A%2F%2Fevil.test%2Fadmin');
    await page.getByLabel('Email address').fill('nobody@example.test');
    await page.getByRole('button', { name: /email me a sign-in link/i }).click();
    await page.getByText(/check your email/i).waitFor();

    // Replaced with the default, not "cleaned up" into something that still leaves the site —
    // and absolute on this origin, because a relative callback would resolve against the API.
    expect(callbackURL).toBe(new URL('/account/watches', page.url()).href);
  });
});
