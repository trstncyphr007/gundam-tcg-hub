import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { mailboxSubjects, signIn } from './helpers';

/**
 * Download your data, delete your account (SR-X.25, ADR-027), in a real browser.
 */
test.describe('your data', () => {
  test('downloads a file with everything, and tells the owner', async ({ page }) => {
    const email = `export-${randomUUID().slice(0, 8)}@example.test`;
    await signIn(page, email);
    await page.goto('/account/data');

    const download = page.waitForEvent('download');
    await page.getByTestId('export-data').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^gundam-tcg-hub-export-\d{4}-\d{2}-\d{2}\.json$/);

    const chunks: Buffer[] = [];
    for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      format: string;
      account: { email: string };
      withheld: string[];
    };
    expect(data.format).toBe('gundam-tcg-hub-export');
    expect(data.account.email).toBe(email);
    expect(data.withheld.length).toBeGreaterThan(0);

    await expect(page.getByTestId('export-done')).toBeVisible();
    await expect.poll(async () => mailboxSubjects(page)).toContain('Your data was downloaded');
  });

  test('deletes the account only when the address is typed, then signs it out', async ({
    page,
  }) => {
    const email = `delete-${randomUUID().slice(0, 8)}@example.test`;
    await signIn(page, email);
    await page.goto('/account/data');

    await page.getByTestId('delete-confirm').fill('not-me@example.test');
    await page.getByTestId('delete-account').click();
    await expect(page.getByTestId('delete-problem')).toContainText('not the email address');

    await page.getByTestId('delete-confirm').fill(email);
    await page.getByTestId('delete-account').click();
    await expect(page.getByTestId('account-deleted')).toBeVisible();
    await expect.poll(async () => mailboxSubjects(page)).toContain('Your account has been deleted');

    // Signed out on the spot: the session went with the account.
    await page.goto('/account/data');
    await expect(page.getByTestId('delete-panel')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Sign in' }).last()).toBeVisible();
  });
});
