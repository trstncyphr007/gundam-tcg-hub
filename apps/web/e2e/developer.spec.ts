import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/** Self-serve API keys through a browser (FR-3.7, AC-3.3). */
test.describe('API keys', () => {
  test('creates a key, uses it, and revokes it', async ({ page }) => {
    await signIn(page, `dev-${randomUUID().slice(0, 8)}@example.com`);
    await page.goto('/account/developer');
    await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();

    await page.getByTestId('key-name').fill('E2E key');
    await page.getByTestId('create-key').click();

    const shown = page.getByTestId('new-key');
    await expect(shown).toBeVisible();
    const key = await shown.inputValue();
    expect(key).toMatch(/^gth_(live|test)_[a-z0-9]{8}_/);

    // The key works, from inside the page so the browser's own fetch is what is tested.
    // `no-store` throughout: catalog responses are `public, max-age=300`, so without it the
    // second call below would be answered from the browser's cache and would tell us nothing
    // about the server. (That cache is the client's own copy of public data, so a few minutes
    // of it outliving a revocation is a cost the caller bears, not a hole.)
    const ok = await page.evaluate(async (bearer: string) => {
      const response = await fetch('/v1/cards', {
        headers: { authorization: `Bearer ${bearer}` },
        cache: 'no-store',
      });
      return { status: response.status, limit: response.headers.get('ratelimit-limit') };
    }, key);
    expect(ok.status).toBe(200);
    expect(ok.limit).toBe('60');

    // Dismissing it is the last time it exists anywhere: reloading must not bring it back.
    await page.getByTestId('dismiss-key').click();
    await page.reload();
    await expect(page.locator('body')).not.toContainText(key);

    await page.getByTestId('revoke-key').first().click();
    await expect(page.getByTestId('key-table')).toContainText('revoked');

    const dead = await page.evaluate(async (bearer: string) => {
      const response = await fetch('/v1/cards', {
        headers: { authorization: `Bearer ${bearer}` },
        cache: 'no-store',
      });
      return response.status;
    }, key);
    expect(dead).toBe(401);
  });

  test('the docs page explains itself without loading any script', async ({ page }) => {
    const response = await page.goto('/docs');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: /Gundam TCG Hub API/ })).toBeVisible();
    await expect(page.locator('script')).toHaveCount(0);

    const spec = await page.request.get('/docs/openapi.json');
    expect(spec.status()).toBe(200);
    expect(((await spec.json()) as { openapi: string }).openapi).toBe('3.1.0');
  });
});
