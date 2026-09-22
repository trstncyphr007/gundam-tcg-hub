import { type Page, expect, test } from '@playwright/test';
import { signIn, signInOnce } from './helpers';

/**
 * No inline styles anywhere, so the CSP can refuse them (ADR-031).
 *
 * Two checks per page:
 *
 *  - **No `style` attribute in the server's HTML.** Checked on every server, dev included,
 *    because a style prop that slips back in would be silently dropped in production: the
 *    page would still pass every functional test and simply look wrong.
 *  - **No CSP violation fired while it loaded.** Production builds only — the dev server's
 *    policy allows inline styles for hot reload, so there is nothing to violate there.
 */
declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

const CREATOR_EMAIL = process.env['E2E_CREATOR_EMAIL'] ?? 'creator@example.test';
const production = process.env['NODE_ENV'] !== 'development';

async function watchForViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
    });
  });
}

/**
 * Style attributes in the HTML the server sent — which is what the CSP refuses.
 *
 * Not the live DOM: Next's route announcer and dev tools set styles from script after load,
 * through the CSSOM, which the CSP allows and which shows up as a `style` attribute all the
 * same. The markup is where a stray style prop would land, so the markup is what is read.
 */
async function styledInMarkup(page: Page, path: string): Promise<string[]> {
  const html = await (await page.request.get(path)).text();
  return [...html.matchAll(/<[a-z][\w-]*\s[^>]*\bstyle="[^"]*"[^>]*>/gi)].map((m) => m[0]);
}

async function expectClean(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  expect(await styledInMarkup(page, path), `${path} has inline style attributes`).toEqual([]);
  if (production) {
    const violations = await page.evaluate(() => window.__cspViolations ?? []);
    expect(violations, `${path} violated the CSP`).toEqual([]);
  }
}

test.describe('no inline styles (ADR-031)', () => {
  test('public pages', async ({ page }) => {
    await watchForViolations(page);
    for (const path of [
      '/',
      '/products',
      '/breakers',
      '/collections',
      '/methodology',
      '/sign-in',
    ]) {
      await expectClean(page, path);
    }
    // A card page, reached the way a visitor would.
    await page.goto('/');
    await page.getByRole('link', { name: 'Sample Unit Alpha' }).click();
    await page.waitForURL(/\/cards\//);
    await expectClean(page, new URL(page.url()).pathname);
  });

  test('account pages', async ({ page }) => {
    await watchForViolations(page);
    await signIn(page, `styles-${String(Date.now())}@example.test`);
    for (const path of [
      '/account/watches',
      '/account/collections',
      '/account/developer',
      '/account/security',
      '/account/data',
    ]) {
      await expectClean(page, path);
    }
  });

  test('creator pages', async ({ page }) => {
    await watchForViolations(page);
    await signInOnce(page, CREATOR_EMAIL);
    for (const path of ['/creator/breaks', '/creator/live-sales', '/creator/profile']) {
      await expectClean(page, path);
    }
  });

  test('the classes really carry the palette', async ({ page }) => {
    // A class that compiled to nothing would pass every check above and render unstyled.
    await page.goto('/sign-in');
    const muted = page.locator('.text-muted').first();
    await expect(muted).toHaveCSS('color', 'rgb(154, 163, 184)'); // --muted: #9aa3b8
  });

  test("a missing page is the site's own 404, not Next's unstyled one", async ({ page }) => {
    await watchForViolations(page);
    // One URL nothing matches (the catch-all route), one a page answers with notFound().
    for (const path of [
      '/no-such-page/at-all',
      '/collections/00000000-0000-4000-8000-000000000000',
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByTestId('not-found')).toBeVisible();
      // Inside the site's layout, so the visitor still has the navigation.
      await expect(page.getByRole('link', { name: 'Breakers' })).toBeVisible();
      await expectClean(page, path);
    }
  });

  test('the catch-all never swallows the proxied API paths', async ({ page }) => {
    // Rewrites run before dynamic routes; this pins that, so a Next upgrade that changed the
    // order would fail here rather than turn the API into a wall of 404 pages.
    const games = await page.request.get('/v1/games');
    expect(games.status()).toBe(200);
    expect(games.headers()['content-type']).toMatch(/application\/json/);
    const auth = await page.request.get('/api/auth/ok');
    expect(auth.status()).toBe(200);
    expect(await auth.json()).toMatchObject({ ok: true });
  });
});
