import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signInOnce } from './helpers';

/**
 * VOD timestamps end to end (FR-4.4).
 *
 * The point of this feature is the last assertion: a viewer gets a link straight to the
 * moment, and the page is honest that the link is not part of what they can verify.
 */
const CREATOR_EMAIL = process.env['E2E_CREATOR_EMAIL'] ?? 'creator@example.test';
const VOD = 'https://www.youtube.com/watch?v=abc';

/** An ended break with `count` pulls, ready to timestamp. */
async function endedBreak(
  page: import('@playwright/test').Page,
  title: string,
  count: number,
): Promise<string> {
  await page.goto('/creator/breaks');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: /create break/i }).click();
  await page.getByRole('button', { name: /saved it/i }).click();
  await page.getByRole('link', { name: title }).click();

  await page.getByRole('button', { name: /start break/i }).click();
  for (let i = 0; i < count; i += 1) {
    await page.getByTestId('pull-label').fill(`Card ${String(i + 1)}`);
    await page.getByTestId('pull-value').fill('10.00');
    await page.getByTestId('log-pull').click();
    await expect(page.getByTestId('pull-count')).toHaveText(String(i + 1));
  }
  await page.getByRole('button', { name: /end break/i }).click();
  await expect(page.getByTestId('vod-panel')).toBeVisible();

  return String(page.url().split('/').pop());
}

test.describe('VOD timestamps', () => {
  test.beforeEach(async ({ page }) => {
    await signInOnce(page, CREATOR_EMAIL);
  });

  test('the panel only appears once there is a finished log to walk down', async ({ page }) => {
    const title = `Running ${randomUUID().slice(0, 8)}`;
    await page.goto('/creator/breaks');
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: /create break/i }).click();
    await page.getByRole('button', { name: /saved it/i }).click();
    await page.getByRole('link', { name: title }).click();

    // Timestamping happens after the stream, when the VOD exists.
    await expect(page.getByTestId('vod-panel')).toHaveCount(0);
  });

  test('a viewer gets a link straight to the moment', async ({ page, context }) => {
    const title = `Timestamped ${randomUUID().slice(0, 8)}`;
    const breakId = await endedBreak(page, title, 2);

    await page.getByTestId('vod-url').fill(VOD);
    await page.getByTestId('save-vod').click();
    await expect(page.getByTestId('vod-progress')).toContainText('0 of 2');

    // Typed the way a person reads a scrubber, not in seconds.
    await page.getByTestId('vod-offset-1').fill('1:02:03');
    await page.getByTestId('vod-offset-1').press('Enter');
    await expect(page.getByTestId('vod-progress')).toContainText('1 of 2');

    const viewer = await context.newPage();
    await viewer.goto(`/breaks/${breakId}`);
    const link = viewer.getByTestId('pull-vod-link').first();
    await expect(link).toHaveText('1:02:03');
    await expect(link).toHaveAttribute('href', `${VOD}&t=3723`);
    // It leaves our origin, so it must not hand the destination a window handle back.
    await expect(link).toHaveAttribute('rel', /noopener/);

    // Only the pull that was timestamped gets one.
    await expect(viewer.getByTestId('pull-vod-link')).toHaveCount(1);
    await viewer.close();
  });

  test('says plainly that a timestamp is not covered by the hashes', async ({ page, context }) => {
    const title = `Honest ${randomUUID().slice(0, 8)}`;
    const breakId = await endedBreak(page, title, 1);
    await page.getByTestId('vod-url').fill(VOD);
    await page.getByTestId('save-vod').click();
    await page.getByTestId('vod-offset-1').fill('30');
    await page.getByTestId('vod-offset-1').press('Enter');

    const viewer = await context.newPage();
    await viewer.goto(`/breaks/${breakId}`);
    // A reader who assumes the link is proven has been misled by us, not by the creator.
    await expect(viewer.locator('body')).toContainText('not');
    await expect(viewer.locator('body')).toContainText('covered by the hashes');
    // And the chain still verifies, because nothing here touched the log.
    await expect(viewer.getByTestId('verifier')).toContainText('hash to the published chain');
    await viewer.close();
  });

  test('clearing the box removes the link', async ({ page, context }) => {
    const title = `Cleared ${randomUUID().slice(0, 8)}`;
    const breakId = await endedBreak(page, title, 1);
    await page.getByTestId('vod-url').fill(VOD);
    await page.getByTestId('save-vod').click();
    await page.getByTestId('vod-offset-1').fill('30');
    await page.getByTestId('vod-offset-1').press('Enter');
    await expect(page.getByTestId('vod-progress')).toContainText('1 of 1');

    // Better than a link pointing at the wrong moment.
    await page.getByTestId('vod-offset-1').fill('');
    await page.getByTestId('vod-offset-1').press('Enter');
    await expect(page.getByTestId('vod-progress')).toContainText('0 of 1');

    const viewer = await context.newPage();
    await viewer.goto(`/breaks/${breakId}`);
    await expect(viewer.getByTestId('pull-vod-link')).toHaveCount(0);
    await viewer.close();
  });

  test('refuses a timestamp it cannot read, and keeps what was there', async ({ page }) => {
    const title = `Bad ${randomUUID().slice(0, 8)}`;
    await endedBreak(page, title, 1);
    await page.getByTestId('vod-url').fill(VOD);
    await page.getByTestId('save-vod').click();

    await page.getByTestId('vod-offset-1').fill('near the end');
    await page.getByTestId('vod-offset-1').press('Enter');
    await expect(page.getByTestId('vod-error')).toContainText('is not a timestamp');
    await expect(page.getByTestId('vod-progress')).toContainText('0 of 1');
  });

  test('carries the timestamp out of a pasted link into the empty boxes', async ({ page }) => {
    const title = `Carried ${randomUUID().slice(0, 8)}`;
    await endedBreak(page, title, 1);

    // Creators paste from the platform's own "copy at current time" button. Reading the
    // offset beats asking them to type it again.
    await page.getByTestId('vod-url').fill(`${VOD}&t=90`);
    await page.getByTestId('save-vod').click();
    await expect(page.getByTestId('vod-offset-1')).toHaveValue('1:30');
  });
});
