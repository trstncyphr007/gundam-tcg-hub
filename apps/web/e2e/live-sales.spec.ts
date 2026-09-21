import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signInOnce } from './helpers';

/**
 * The live-sale logger through the browser (FR-4.1, SR-4.5).
 *
 * The assertions that matter here are about speed and about restraint: the fast path stays
 * keyboard-only, and a buyer's handle reaches the seller's own screen and nowhere else.
 */
const CREATOR_EMAIL = process.env['E2E_CREATOR_EMAIL'] ?? 'creator@example.test';

test.describe('live sales', () => {
  test.beforeEach(async ({ page }) => {
    await signInOnce(page, CREATOR_EMAIL);
    await page.goto('/creator/live-sales');
  });

  test('logs a sale without touching the mouse', async ({ page }) => {
    const before = Number(await page.getByTestId('sale-count').textContent());

    // Type, Enter to pick the card, type a price, Enter to log. That is the whole path.
    await page.getByTestId('sale-label').fill('Sample Unit Alpha');
    await expect(page.getByTestId('sale-suggestions')).toBeVisible();
    await page.getByTestId('sale-label').press('Enter');
    await page.getByTestId('sale-price').fill('12.50');
    await page.getByTestId('sale-price').press('Enter');

    await expect(page.getByTestId('sale-count')).toHaveText(String(before + 1));
    await expect(page.getByTestId('sale-list')).toContainText('Sample Unit Alpha');
    await expect(page.getByTestId('sale-list')).toContainText('$12.50');
  });

  test('logs a card the catalog has never heard of', async ({ page }) => {
    // A seller must never be blocked mid-stream by a gap in our data.
    const label = `Uncatalogued ${randomUUID().slice(0, 8)}`;
    await page.getByTestId('sale-label').fill(label);
    await page.getByTestId('sale-price').fill('4.00');
    await page.getByTestId('log-sale').click();

    await expect(page.getByTestId('sale-list')).toContainText(label);
  });

  test('keeps the condition and buyer between entries, and clears the card', async ({ page }) => {
    await page.getByTestId('sale-condition').selectOption('lp');
    await page.getByTestId('sale-buyer').fill('@alice');
    await page.getByTestId('sale-label').fill(`Keep ${randomUUID().slice(0, 8)}`);
    await page.getByTestId('sale-price').fill('7.00');
    await page.getByTestId('log-sale').click();

    await expect(page.getByTestId('sale-label')).toHaveValue('');
    await expect(page.getByTestId('sale-price')).toHaveValue('');
    // A whole stream is usually one condition and often one buyer; retyping both every time
    // is where three seconds an entry would go.
    await expect(page.getByTestId('sale-condition')).toHaveValue('lp');
    await expect(page.getByTestId('sale-buyer')).toHaveValue('@alice');
  });

  test('shows the buyer handle back to the seller who typed it', async ({ page }) => {
    const label = `Buyer ${randomUUID().slice(0, 8)}`;
    await page.getByTestId('sale-buyer').fill('@alice');
    await page.getByTestId('sale-label').fill(label);
    await page.getByTestId('sale-price').fill('9.00');
    await page.getByTestId('log-sale').click();

    // Normalised on the way in: `@alice` and `alice` must not become two people.
    await expect(page.getByTestId('sale-buyer-shown').first()).toHaveText('alice');
    // And the page says what happens to it, where the person typing it will read it.
    await expect(page.getByTestId('sale-logger')).toContainText('erased 90 days after the sale');
  });

  test('a fresh entry is not claimed to be in the index', async ({ page }) => {
    const label = `Pending ${randomUUID().slice(0, 8)}`;
    await page.getByTestId('sale-label').fill(label);
    await page.getByTestId('sale-price').fill('3.00');
    await page.getByTestId('log-sale').click();

    const row = page.getByTestId('sale-row').filter({ hasText: label });
    // Logged is not published. The worker turns it into an observation later, and an odd
    // price is held for review before it counts.
    await expect(row).toContainText('not yet counted');
    await expect(row.getByTestId('sale-published')).toHaveCount(0);
  });

  test('removes a mistyped entry', async ({ page }) => {
    const label = `Typo ${randomUUID().slice(0, 8)}`;
    await page.getByTestId('sale-label').fill(label);
    await page.getByTestId('sale-price').fill('999.00');
    await page.getByTestId('log-sale').click();

    const row = page.getByTestId('sale-row').filter({ hasText: label });
    await expect(row).toBeVisible();
    await row.getByTestId('delete-sale').click();
    await expect(page.getByTestId('sale-row').filter({ hasText: label })).toHaveCount(0);
  });

  test('refuses a price that is not an amount', async ({ page }) => {
    await page.getByTestId('sale-label').fill('Sample Unit Alpha');
    await page.getByTestId('sale-price').fill('twelve fifty');
    await page.getByTestId('log-sale').click();
    await expect(page.getByTestId('sale-error')).toContainText('not an amount');
  });
});
