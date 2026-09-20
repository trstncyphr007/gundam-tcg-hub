import { expect, test } from '@playwright/test';
import { asNewClient, clearMailbox, fetchLatestMagicLink, signIn } from './helpers';

test.describe('sign-in', () => {
  test('signs in with a one-time email link and signs out again', async ({ page }) => {
    await signIn(page, `e2e-${String(Date.now())}@example.com`);

    await page.goto('/account/watches');
    await expect(page.getByRole('heading', { name: 'My watches' })).toBeVisible();
    await expect(page.getByText(/signed in as/i)).toBeVisible();

    await page.getByRole('button', { name: /sign out/i }).click();
    await page.waitForURL('**/sign-in');

    // The session is revoked server-side, so the protected page is closed again.
    await page.goto('/account/watches');
    await expect(page.getByText(/need to sign in/i)).toBeVisible();
  });

  test('keeps protected pages closed when signed out', async ({ page }) => {
    await page.goto('/account/watches');
    await expect(page.getByText(/need to sign in/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  });

  test('a used sign-in link cannot be replayed', async ({ page }) => {
    await asNewClient(page);
    await clearMailbox(page);
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(`replay-${String(Date.now())}@example.com`);
    await page.getByRole('button', { name: /email me a sign-in link/i }).click();
    await page.getByText(/check your email/i).waitFor();
    const link = await fetchLatestMagicLink(page);

    // First use signs in.
    await page.goto(link);
    await page.goto('/account/watches');
    await expect(page.getByText(/signed in as/i)).toBeVisible();

    // Same link again, from a clean browser state: must not mint a second session.
    await page.context().clearCookies();
    await page.goto(link);
    await page.goto('/account/watches');
    await expect(page.getByText(/need to sign in/i)).toBeVisible();
  });
});

test.describe('watches', () => {
  test('watch and unwatch a product', async ({ page }) => {
    await signIn(page, `watcher-${String(Date.now())}@example.com`);

    await page.goto('/products');
    const watchButton = page.getByRole('button', { name: 'Watch' }).first();
    await expect(watchButton).toBeVisible();
    await watchButton.click();

    await expect(page.getByRole('button', { name: 'Watching' }).first()).toBeVisible();

    await page.goto('/account/watches');
    await expect(page.getByText('Product watch')).toBeVisible();
    await expect(page.getByText(/alerts via email/i)).toBeVisible();

    await page.goto('/products');
    await page.getByRole('button', { name: 'Watching' }).first().click();
    await expect(page.getByRole('button', { name: 'Watch' }).first()).toBeVisible();

    await page.goto('/account/watches');
    await expect(page.getByText(/no watches yet/i)).toBeVisible();
  });

  test('prompts anonymous visitors to sign in instead of watching', async ({ page }) => {
    await page.goto('/products');
    await expect(page.getByRole('link', { name: /sign in to watch/i }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Watch' })).toHaveCount(0);
  });

  test("one user cannot see another user's watches", async ({ page, context }) => {
    const alice = `alice-${String(Date.now())}@example.com`;
    await signIn(page, alice);
    await page.goto('/products');
    await page.getByRole('button', { name: 'Watch' }).first().click();
    await expect(page.getByRole('button', { name: 'Watching' }).first()).toBeVisible();

    await context.clearCookies();
    await signIn(page, `bob-${String(Date.now())}@example.com`);
    await page.goto('/account/watches');
    await expect(page.getByText(/no watches yet/i)).toBeVisible();
  });
});
