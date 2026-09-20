import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Phase 2 acceptance (AC-2.1 to AC-2.4), through a real browser against the real stack.
 *
 * The creator role is granted out of band by `pnpm role:set`, which is deliberate: it is
 * not something a session can do to itself (SR-2.6). The suite does the same through the
 * API's own CLI path, via the seeded creator account.
 */
const CREATOR_EMAIL = process.env['E2E_CREATOR_EMAIL'] ?? 'creator@example.test';

async function startBreak(
  page: import('@playwright/test').Page,
  title: string,
): Promise<{ overlayUrl: string }> {
  await page.goto('/creator/breaks');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Cost (USD)').fill('100');
  await page.getByRole('button', { name: /create break/i }).click();

  const overlayInput = page.getByTestId('overlay-url');
  await expect(overlayInput).toBeVisible();
  const overlayUrl = await overlayInput.inputValue();
  await page.getByRole('button', { name: /saved it/i }).click();
  return { overlayUrl };
}

test.describe('creator breaks', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, CREATOR_EMAIL);
  });

  test('a pull reaches the overlay in under a second (AC-2.1)', async ({ page, context }) => {
    const title = `Break ${randomUUID().slice(0, 8)}`;
    const { overlayUrl } = await startBreak(page, title);

    await page.getByRole('link', { name: title }).click();
    await page.getByRole('button', { name: /start break/i }).click();

    // The overlay is what OBS would load: a separate page, holding only the token.
    const overlay = await context.newPage();
    await overlay.goto(overlayUrl);
    await expect(overlay.getByTestId('overlay-title')).toHaveText(title);
    await expect(overlay.getByTestId('overlay-total')).toHaveText('$0.00');

    await page.getByTestId('pull-label').fill('Gundam Barbatos');
    await page.getByTestId('pull-value').fill('125.50');
    const sentAt = Date.now();
    await page.getByTestId('log-pull').click();

    await expect(overlay.getByTestId('overlay-last')).toContainText('Gundam Barbatos');
    await expect(overlay.getByTestId('overlay-total')).toHaveText('$125.50');
    // The stream polls once a second; allow a little slack for CI, not for a design that
    // would feel laggy on stream.
    expect(Date.now() - sentAt).toBeLessThan(3000);

    await overlay.close();
  });

  test('the overlay shows a transparent background and no site chrome', async ({
    page,
    context,
  }) => {
    const { overlayUrl } = await startBreak(page, `Chrome ${randomUUID().slice(0, 8)}`);
    const overlay = await context.newPage();
    await overlay.goto(overlayUrl);

    // OBS keys on the absence of a background; a colour here would be a grey box on stream.
    const background = await overlay.evaluate(
      () => window.getComputedStyle(document.body).backgroundColor,
    );
    expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(background);
    await expect(overlay.locator('header')).toHaveCount(0);
    await expect(overlay.locator('nav')).toHaveCount(0);
    await overlay.close();
  });

  test('regenerating the URL kills the old one immediately (AC-2.2)', async ({ page, context }) => {
    const title = `Rotate ${randomUUID().slice(0, 8)}`;
    const { overlayUrl } = await startBreak(page, title);
    await page.getByRole('link', { name: title }).click();

    const before = await context.newPage();
    await before.goto(overlayUrl);
    await expect(before.getByTestId('overlay-title')).toHaveText(title);
    await before.close();

    await page.getByRole('button', { name: /regenerate overlay url/i }).click();
    const rotated = await page.getByTestId('overlay-url').inputValue();
    expect(rotated).not.toBe(overlayUrl);

    // The page itself is a static route and still renders; what the old token no longer
    // buys is any data. Assert that, at both layers.
    const oldToken = overlayUrl.split('/').pop() ?? '';
    const refused = await context.request.get(`/v1/overlay/${oldToken}`);
    expect(refused.status()).toBe(404);

    const dead = await context.newPage();
    await dead.goto(overlayUrl);
    await expect(dead.getByTestId('overlay-title')).toHaveCount(0);
    await expect(dead.getByTestId('overlay-total')).toHaveCount(0);
    await dead.close();

    const live = await context.newPage();
    await live.goto(rotated);
    await expect(live.getByTestId('overlay-title')).toHaveText(title);
    await live.close();
  });

  test('an XSS payload in a title stays inert, and the CSP is enforced (AC-2.3)', async ({
    page,
    context,
  }) => {
    // Unique per run: a constant title collides with breaks left by earlier runs and the
    // link locator then matches several.
    const payload = `<img src=x onerror=window.__pwned=1> ${randomUUID().slice(0, 8)}`;
    const { overlayUrl } = await startBreak(page, payload);

    await page.getByRole('link', { name: payload }).click();
    await page.getByRole('button', { name: /start break/i }).click();
    await page.getByTestId('pull-label').fill('<script>window.__pwned=1</script>');
    await page.getByTestId('pull-value').fill('1');
    await page.getByTestId('log-pull').click();
    await expect(page.getByTestId('pull-count')).toHaveText('1');

    // The public page: the payload renders as text, and no injected script ran.
    const publicUrl = await page.getByRole('link', { name: /public page/i }).getAttribute('href');
    const viewer = await context.newPage();
    const response = await viewer.goto(publicUrl ?? '/');

    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");

    await expect(viewer.getByRole('heading', { name: payload })).toBeVisible();
    // No element was created: it was escaped into text, not parsed as markup.
    await expect(viewer.locator('img[src="x"]')).toHaveCount(0);
    // Next ships its own inline bootstrap scripts, which are legitimate and nonced. What
    // must not exist is a script carrying our payload.
    await expect(viewer.locator('script').filter({ hasText: '__pwned' })).toHaveCount(0);
    expect(await viewer.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    await viewer.close();

    const overlay = await context.newPage();
    await overlay.goto(overlayUrl);
    await expect(overlay.getByTestId('overlay-title')).toHaveText(payload);
    expect(await overlay.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    await overlay.close();
  });

  test('an exported CSV neutralises a formula (AC-2.4)', async ({ page }) => {
    const title = `Export ${randomUUID().slice(0, 8)}`;
    await startBreak(page, title);
    await page.getByRole('link', { name: title }).click();
    await page.getByRole('button', { name: /start break/i }).click();
    await page.getByTestId('pull-label').fill(`=cmd|'/c calc'!A1`);
    await page.getByTestId('pull-value').fill('9.99');
    await page.getByTestId('log-pull').click();
    await expect(page.getByTestId('pull-count')).toHaveText('1');

    const href = await page.getByRole('link', { name: /public page/i }).getAttribute('href');
    const id = href?.split('/').pop();
    const csv = await page.request.get(`/v1/breaks/${String(id)}/export?format=csv`);
    expect(csv.status()).toBe(200);
    const body = await csv.text();
    expect(body).toContain(`"'=cmd|'/c calc'!A1"`);
    expect(body).not.toContain('"=cmd');
  });

  test('a draft break is not public until it is started', async ({ page, context }) => {
    const title = `Draft ${randomUUID().slice(0, 8)}`;
    await startBreak(page, title);
    await page.getByRole('link', { name: title }).click();

    // No public link while it is a draft.
    await expect(page.getByRole('link', { name: /public page/i })).toHaveCount(0);

    await page.getByRole('button', { name: /start break/i }).click();
    const href = await page.getByRole('link', { name: /public page/i }).getAttribute('href');
    const viewer = await context.newPage();
    const response = await viewer.goto(href ?? '/');
    expect(response?.status()).toBe(200);
    await viewer.close();
  });
});
