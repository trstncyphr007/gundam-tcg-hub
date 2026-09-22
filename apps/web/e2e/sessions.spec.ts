import { type Browser, type Page, expect, test } from '@playwright/test';
import { mailboxSubjects, signIn } from './helpers';

/**
 * Where an account is signed in, and ending it from somewhere else (§16.2, SR-X.5, ADR-026).
 *
 * Two browser contexts with different user agents stand in for two devices: a laptop the
 * owner is sitting at, and a phone they are not.
 */
test.describe.configure({ mode: 'serial' });

const EMAIL = 'sessions-user@example.test';
const LAPTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

test.use({ userAgent: LAPTOP });

async function phone(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const context = await browser.newContext({ userAgent: PHONE, ...(baseURL ? { baseURL } : {}) });
  return context.newPage();
}

async function isSignedOut(page: Page): Promise<boolean> {
  await page.goto('/account/security');
  await page.getByRole('heading', { name: 'Security' }).waitFor();
  return (await page.getByTestId('session-manager').count()) === 0;
}

test.describe('sessions', () => {
  test('shows every device, tells the owner about a new one, and signs it out', async ({
    page,
    browser,
    baseURL,
  }) => {
    await signIn(page, EMAIL);

    const other = await phone(browser, baseURL);
    await signIn(other, EMAIL);
    // The phone is a device this account has never used: the owner is told (SR-X.5).
    await expect.poll(async () => mailboxSubjects(other)).toContain('New sign-in to your account');

    await page.goto('/account/security');
    const rows = page.getByTestId('session-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.and(page.locator('[data-current="true"]'))).toContainText(
      'Chrome on Windows',
    );
    const phoneRow = rows.filter({ hasText: 'Safari on iPhone' });
    await expect(phoneRow).toContainText('email link');

    await phoneRow.getByTestId('revoke-session').click();
    await expect(rows).toHaveCount(1);
    // Signed out on the phone at once — not at its next daily refresh.
    expect(await isSignedOut(other)).toBe(true);
    await other.context().close();
  });

  test('signs out everywhere else, and keeps this device', async ({ page, browser, baseURL }) => {
    await signIn(page, EMAIL);
    const other = await phone(browser, baseURL);
    await signIn(other, EMAIL);

    await page.goto('/account/security');
    // The phone, plus the laptop session the previous test opened in a context now closed —
    // closing a browser does not end a session, which is rather the point of this page.
    await expect(
      page.getByTestId('session-row').filter({ hasText: 'Safari on iPhone' }),
    ).toHaveCount(1);
    await page.getByTestId('revoke-others').click();

    await expect(page.getByTestId('sessions-result')).toHaveText(
      /^Signed out \d+ other sessions?\.$/,
    );
    await expect(page.getByTestId('session-row')).toHaveCount(1);
    await expect(page.getByTestId('session-current')).toBeVisible();
    expect(await isSignedOut(other)).toBe(true);
    await other.context().close();
  });
});
