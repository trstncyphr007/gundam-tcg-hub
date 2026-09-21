import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signInOnce } from './helpers';

/**
 * Commit–reveal through the browser (FR-4.2, AC-4.1, AC-4.2).
 *
 * The verifier's whole claim is that it runs on the viewer's machine, so these assertions
 * are made against what a real browser rendered after doing the cryptography itself.
 */
const CREATOR_EMAIL = process.env['E2E_CREATOR_EMAIL'] ?? 'creator@example.test';

async function startCommittedBreak(
  page: import('@playwright/test').Page,
  title: string,
): Promise<string> {
  await page.goto('/creator/breaks');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Cost (USD)').fill('100');
  await page.getByRole('button', { name: /create break/i }).click();
  await page.getByRole('button', { name: /saved it/i }).click();
  await page.getByRole('link', { name: title }).click();

  // Commit while the break is still a draft — the order is the security property.
  await page.getByTestId('slot-count').fill('8');
  await page.getByTestId('commit-break').click();
  await expect(page.getByTestId('commitment-value')).toHaveText(/^[0-9a-f]{64}$/);

  await page.getByTestId('client-seed').fill('chat said 4815162342');
  await page.getByTestId('set-client-seed').click();
  await expect(page.getByTestId('locked-seed')).toHaveText('chat said 4815162342');

  return String(page.url().split('/').pop());
}

test.describe('verifiable breaks', () => {
  test.beforeEach(async ({ page }) => {
    await signInOnce(page, CREATOR_EMAIL);
  });

  test('a viewer can check the break in their own browser (AC-4.1)', async ({ page, context }) => {
    const title = `Verified ${randomUUID().slice(0, 8)}`;
    const breakId = await startCommittedBreak(page, title);

    await page.getByRole('button', { name: /start break/i }).click();
    await page.getByTestId('pull-label').fill('Sample Unit Alpha');
    await page.getByTestId('pull-value').fill('25.00');
    await page.getByTestId('log-pull').click();
    await expect(page.getByTestId('pull-count')).toHaveText('1');

    // Before the reveal, the seed is withheld — and the page says why rather than failing.
    const early = await context.newPage();
    await early.goto(`/breaks/${breakId}`);
    await expect(early.getByTestId('verifier')).toContainText('has not been revealed yet');
    await expect(early.getByTestId('revealed-seed')).toHaveText('not revealed yet');
    await early.close();

    await page.getByRole('button', { name: /end break/i }).click();
    await page.getByTestId('reveal-break').click();
    await expect(page.getByTestId('revealed-order')).toContainText(',');

    // Now the viewer's own browser does the cryptography.
    const viewer = await context.newPage();
    await viewer.goto(`/breaks/${breakId}`);
    const verifier = viewer.getByTestId('verifier');
    await expect(verifier).toContainText('hashes to the commitment published before the break');
    await expect(verifier).toContainText('hash to the published chain, in order');
    await expect(viewer.getByTestId('verifier-disagrees')).toHaveCount(0);

    // The evidence is on the page, not just the verdict.
    await expect(viewer.getByTestId('revealed-seed')).not.toHaveText('not revealed yet');
    await expect(viewer.getByTestId('slot-order')).toContainText(',');
    await viewer.close();
  });

  test('the verifier reaches its own verdict, independent of ours', async ({ page, context }) => {
    // Feed the component a log the server called valid, with a value quietly changed. The
    // browser must catch it and say the two disagree — our answer is a convenience, not the
    // authority.
    const title = `Doctored ${randomUUID().slice(0, 8)}`;
    const breakId = await startCommittedBreak(page, title);
    await page.getByRole('button', { name: /start break/i }).click();
    await page.getByTestId('pull-label').fill('Sample Unit Alpha');
    await page.getByTestId('pull-value').fill('25.00');
    await page.getByTestId('log-pull').click();
    await expect(page.getByTestId('pull-count')).toHaveText('1');

    const viewer = await context.newPage();
    // Intercept the page's own data and tamper with it in flight.
    await viewer.route(`**/v1/breaks/${breakId}/public`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        verification: { rows: { valueCentsAtPull: number }[]; chain: { state: string } };
      };
      const first = body.verification.rows[0];
      if (first) first.valueCentsAtPull = 999_999;
      // ...while the server keeps insisting the log is fine.
      body.verification.chain.state = 'valid';
      await route.fulfill({ response, json: body });
    });

    await viewer.goto(`/breaks/${breakId}`);
    // The page arrives server-rendered, so the tampering only reaches the component when the
    // reader asks for the evidence themselves — which is the button that exists for exactly
    // this reason.
    await viewer.getByTestId('verifier-refetch').click();

    await expect(viewer.getByTestId('verifier')).toContainText('The log was altered at pull #1');
    await expect(viewer.getByTestId('verifier-disagrees')).toBeVisible();
    await expect(viewer.getByTestId('verifier-disagrees')).toContainText('Trust your browser');
    await viewer.close();
  });

  test('refuses to commit once the break has started', async ({ page }) => {
    const title = `Late ${randomUUID().slice(0, 8)}`;
    await page.goto('/creator/breaks');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: /create break/i }).click();
    await page.getByRole('button', { name: /saved it/i }).click();
    await page.getByRole('link', { name: title }).click();
    await page.getByRole('button', { name: /start break/i }).click();
    await page.reload();

    // A commitment made after the fact proves nothing, so the option is not offered.
    await expect(page.getByTestId('commit-break')).toHaveCount(0);
    await expect(page.getByTestId('fairness-panel')).toContainText('too late to commit');
  });
});
