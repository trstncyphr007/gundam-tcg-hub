import { expect, test } from '@playwright/test';

/**
 * The published policy pages (plan §23).
 *
 * They make claims about what the service does, so the assertions here are about the claims
 * that have a control behind them — the retention periods, the limits, the licence. If one of
 * those changes in the code, this fails and the page gets corrected rather than drifting.
 */
test.describe('policy pages', () => {
  test('the footer leads to them from anywhere', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
    await page.waitForURL('**/privacy');
    await expect(page.getByTestId('privacy')).toBeVisible();

    await page.getByRole('contentinfo').getByRole('link', { name: 'Terms' }).click();
    await page.waitForURL('**/terms');
    await expect(page.getByTestId('terms')).toBeVisible();
    // The disclaimer a publisher's lawyer would look for first, on every page.
    await expect(page.getByRole('contentinfo')).toContainText('Not affiliated with Bandai');
  });

  test('the privacy page states what the code actually enforces', async ({ page }) => {
    await page.goto('/privacy');
    const keep = page.getByTestId('privacy-keep');
    await expect(keep).toContainText('15 minutes'); // magic links
    await expect(keep).toContainText('30 days'); // sessions
    await expect(keep).toContainText('90 days'); // buyer handles
    await expect(keep).toContainText('a year'); // the security log (ADR-035)
    // The IP claim is the subtle one: hashed, re-keyed daily, never stored raw (ADR-028).
    await expect(page.getByTestId('privacy-collect')).toContainText('hash');
    await expect(page.getByTestId('privacy-not')).toContainText('no analytics');
    // And it points at the page that actually does export and deletion.
    await page
      .getByTestId('privacy-rights')
      .getByRole('link', { name: 'Account → Your data' })
      .click();
    await page.waitForURL('**/account/data');
  });

  test('the terms state the real API limits and the index licence', async ({ page }) => {
    await page.goto('/terms');
    await expect(page.getByTestId('terms-api')).toContainText('60 requests a minute');
    await expect(page.getByTestId('terms-api')).toContainText('1000 a day');
    await expect(page.getByTestId('terms-data')).toContainText('CC BY 4.0');
  });

  test('the site is closed to crawlers until it is launched', async ({ page }) => {
    // One switch does both, so the site cannot end up telling crawlers "noindex" in the HTML
    // while robots.txt invites them in (lib/site.ts, SITE_IS_PUBLIC).
    const robots = await page.request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain('Disallow: /');

    const home = await (await page.request.get('/')).text();
    expect(home).toMatch(/<meta name="robots" content="noindex/i);

    // And the pages that must never be indexed say so on their own account, so that flipping
    // the switch at launch cannot reach them.
    for (const path of ['/admin/operations', '/account/security']) {
      const html = await (await page.request.get(path)).text();
      expect(html, path).toMatch(/<meta name="robots" content="noindex/i);
    }
  });

  test('security.txt is not served while there is no contact address', async ({ page }) => {
    // RFC 9116 with an address nobody reads is worse than none: it tells a finder they have
    // reported something when they have not. It starts serving when lib/site.ts has one.
    const response = await page.request.get('/.well-known/security.txt');
    expect(response.status()).toBe(404);
    for (const testId of ['privacy', 'terms']) {
      await page.goto(`/${testId}`);
      await expect(page.getByTestId('contact-pending')).toBeVisible();
    }
  });
});
