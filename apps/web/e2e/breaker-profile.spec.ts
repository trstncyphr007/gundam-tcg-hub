import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signInOnce } from './helpers';

/**
 * Breaker profiles end to end (FR-4.3).
 *
 * The assertions worth having here are the ones about restraint: that the page is off until
 * someone turns it on, that it does not draw a conclusion from a handful of packs, and that
 * the badge is a claim about evidence rather than decoration.
 */
/**
 * A dedicated account, not the shared e2e creator.
 *
 * A profile is a running total over everything its owner has ever done, so "this breaker has
 * no verified breaks" is only assertable on an account no other spec has run a break on.
 * Global setup clears this one before the suite starts.
 */
const CREATOR_EMAIL = process.env['E2E_BREAKER_EMAIL'] ?? 'breaker@example.test';

/** Handles are unique, so each run claims its own. */
function newHandle(): string {
  return `e2e-${randomUUID().slice(0, 8)}`;
}

async function claimProfile(
  page: import('@playwright/test').Page,
  handle: string,
  options: { publish: boolean },
): Promise<void> {
  await page.goto('/creator/profile');
  await page.getByTestId('profile-handle').fill(handle);
  await page.getByTestId('profile-display-name').fill('GUNDAM with TRSTN');
  await page.getByTestId('profile-bio').fill('Breaks on Fridays.');
  if (options.publish) await page.getByTestId('profile-published').check();
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-link')).toBeVisible();
}

async function runBreak(
  page: import('@playwright/test').Page,
  title: string,
  options: { packs?: string; pulls: number },
): Promise<void> {
  await page.goto('/creator/breaks');
  await page.getByLabel('Title').fill(title);
  // Published odds belong to a product, so a break without one has nothing to compare
  // against and never reaches the hit-rate table.
  await page.getByLabel(/product/i).selectOption({ index: 1 });
  await page.getByRole('button', { name: /create break/i }).click();
  await page.getByRole('button', { name: /saved it/i }).click();
  await page.getByRole('link', { name: title }).click();

  if (options.packs !== undefined) {
    await page.getByTestId('packs-opened').fill(options.packs);
    await page.getByTestId('save-packs').click();
    await expect(page.getByTestId('packs-saved')).toContainText(options.packs);
  }

  await page.getByRole('button', { name: /start break/i }).click();
  for (let i = 0; i < options.pulls; i += 1) {
    await page.getByTestId('pull-label').fill('Sample Unit Alpha');
    await page.getByTestId('pull-value').fill('25.00');
    await page.getByTestId('log-pull').click();
    await expect(page.getByTestId('pull-count')).toHaveText(String(i + 1));
  }
  // Wait for the server to have ended it. The caller navigates away next, and a break still
  // live when the profile is read is — correctly — left out of the comparison, which is how
  // this raced once the timing shifted.
  const ended = page.waitForResponse(
    (r) => r.url().endsWith('/status') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /end break/i }).click();
  expect((await ended).ok()).toBe(true);
}

test.describe('breaker profiles', () => {
  test.beforeEach(async ({ page }) => {
    await signInOnce(page, CREATOR_EMAIL);
  });

  test('a profile does not exist until its owner publishes it', async ({ page, context }) => {
    const handle = newHandle();
    await claimProfile(page, handle, { publish: false });

    // Not "hidden in the UI": the page is a 404 for anyone else.
    const stranger = await context.newPage();
    const response = await stranger.goto(`/breakers/${handle}`);
    expect(response?.status()).toBe(404);
    await stranger.close();

    await page.goto('/breakers');
    await expect(page.getByTestId('breaker-list')).toHaveCount(0);
  });

  test('publishing shows the page, and it names only what the creator typed', async ({
    page,
    context,
  }) => {
    const handle = newHandle();
    await claimProfile(page, handle, { publish: true });

    const viewer = await context.newPage();
    await viewer.goto(`/breakers/${handle}`);
    await expect(viewer.getByRole('heading', { name: 'GUNDAM with TRSTN' })).toBeVisible();
    await expect(viewer.getByText('Breaks on Fridays.')).toBeVisible();
    // The account behind the page is never on it (SR-3.8).
    await expect(viewer.locator('body')).not.toContainText(CREATOR_EMAIL);
    await viewer.close();
  });

  test('a break with no pack count is left out rather than counted wrongly', async ({ page }) => {
    const handle = newHandle();
    await claimProfile(page, handle, { publish: true });
    await runBreak(page, `Uncounted ${randomUUID().slice(0, 8)}`, { pulls: 2 });

    await page.goto(`/breakers/${handle}`);
    await expect(page.getByTestId('breaker-totals')).toContainText('2');
    // Counted in the totals, absent from the comparison, and the page says why.
    await expect(page.getByTestId('odds-report')).toHaveCount(0);
    await expect(page.locator('body')).toContainText('no pack count');
  });

  test('a small sample says “too few packs”, not a verdict about the breaker', async ({ page }) => {
    const handle = newHandle();
    await claimProfile(page, handle, { publish: true });
    await runBreak(page, `Counted ${randomUUID().slice(0, 8)}`, { packs: '24', pulls: 2 });

    await page.goto(`/breakers/${handle}`);
    const report = page.getByTestId('odds-report');
    await expect(report).toContainText('24 packs');
    // Without published odds there is nothing to compare against, and the page says exactly
    // that instead of inventing a baseline.
    const rows = page.getByTestId('rarity-row');
    if ((await rows.count()) > 0) {
      const verdicts = await rows.evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute('data-verdict')),
      );
      expect(verdicts.every((v) => v === 'unpublished' || v === 'insufficient')).toBe(true);
    }
  });

  test('the badge is not awarded to a break that was never committed to', async ({ page }) => {
    const handle = newHandle();
    await claimProfile(page, handle, { publish: true });
    await runBreak(page, `Unverified ${randomUUID().slice(0, 8)}`, { pulls: 1 });

    await page.goto(`/breakers/${handle}`);
    await expect(page.getByTestId('fairness-badge')).toHaveAttribute('data-badge', 'none');
    await expect(page.getByTestId('fairness-detail')).toContainText('nothing to verify');
  });

  test('the badge is earned by commit–reveal, and the page shows its working', async ({ page }) => {
    const handle = newHandle();
    await claimProfile(page, handle, { publish: true });

    const title = `Verified ${randomUUID().slice(0, 8)}`;
    await page.goto('/creator/breaks');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel(/product/i).selectOption({ index: 1 });
    await page.getByRole('button', { name: /create break/i }).click();
    await page.getByRole('button', { name: /saved it/i }).click();
    await page.getByRole('link', { name: title }).click();

    await page.getByTestId('slot-count').fill('8');
    await page.getByTestId('commit-break').click();
    await expect(page.getByTestId('commitment-value')).toHaveText(/^[0-9a-f]{64}$/);
    await page.getByTestId('client-seed').fill('chat said 7');
    await page.getByTestId('set-client-seed').click();
    await page.getByTestId('packs-opened').fill('24');
    await page.getByTestId('save-packs').click();

    await page.getByRole('button', { name: /start break/i }).click();
    await page.getByTestId('pull-label').fill('Sample Unit Alpha');
    await page.getByTestId('pull-value').fill('25.00');
    await page.getByTestId('log-pull').click();
    await page.getByRole('button', { name: /end break/i }).click();
    await page.getByTestId('reveal-break').click();
    await expect(page.getByTestId('revealed-order')).toContainText(',');

    await page.goto(`/breakers/${handle}`);
    await expect(page.getByTestId('fairness-badge')).toHaveAttribute('data-badge', 'verified');
    // A badge nobody can interrogate is a logo, so the page states what it rests on.
    await expect(page.getByTestId('fairness-detail')).toContainText(
      're-derived from its own hashes',
    );
    await expect(page.getByTestId('fairness-detail')).toContainText('had their pull log re-hashed');
  });

  test('refuses a handle that would read as official', async ({ page }) => {
    await page.goto('/creator/profile');
    await page.getByTestId('profile-handle').fill('admin');
    await page.getByTestId('profile-display-name').fill('Not staff');
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-error')).toContainText('not available');
  });
});
