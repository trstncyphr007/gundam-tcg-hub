import { expect, test } from '@playwright/test';

test.describe('catalog', () => {
  test('shows seeded cards and supports search', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Gundam Card Game' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sample Unit Alpha' })).toBeVisible();

    await page.getByLabel('Search cards').fill('pilot');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('link', { name: 'Sample Pilot Gamma' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sample Unit Alpha' })).toBeHidden();
  });

  test('reports an empty result without breaking', async ({ page }) => {
    await page.goto('/?q=definitely-not-a-card');
    await expect(page.getByText(/no cards matched/i)).toBeVisible();
  });

  test('opens a card and lists its printings', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Sample Unit Alpha' }).click();
    await expect(page.getByRole('heading', { name: 'Sample Unit Alpha' })).toBeVisible();
    await expect(page.getByText('normal · EN')).toBeVisible();
    await expect(page.getByText('parallel · EN')).toBeVisible();
  });

  test('treats a SQL-looking search term as plain text', async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent("'; drop table app.cards; --")}`);
    await expect(page.getByText(/no cards matched/i)).toBeVisible();
    // The catalog still works afterwards.
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sample Unit Alpha' })).toBeVisible();
  });
});

test.describe('security headers (SR-X.14)', () => {
  test('always locks down framing, objects and base-uri', async ({ page }) => {
    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");

    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    expect(response?.headers()['x-powered-by']).toBeUndefined();
    expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('carries no wildcard fetch sources', async ({ page }) => {
    // `img-src ... https:` is a wildcard: any HTTPS origin, which is an exfiltration
    // channel (the path carries the data) and a tracking one. A ZAP baseline found exactly
    // that on 2026-09-20. The nightly scan now accepts CSP rule 10055 so it can tolerate
    // style-src 'unsafe-inline', which would otherwise hide a wildcard regression -- so the
    // narrower thing is asserted here instead.
    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'] ?? '';

    const directives = new Map(
      csp
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name, ...values] = part.split(/\s+/);
          return [name ?? '', values] as const;
        }),
    );

    for (const name of ['default-src', 'script-src', 'img-src', 'connect-src', 'font-src']) {
      const values = directives.get(name) ?? [];
      for (const value of values) {
        expect(value, `${name} must not allow a whole scheme or every origin`).not.toBe('*');
        expect(value, `${name} must not allow a whole scheme`).not.toBe('https:');
        expect(value, `${name} must not allow a whole scheme`).not.toBe('http:');
      }
    }
    // script-src is deliberately looser on the dev server (fast refresh needs un-nonced
    // inline scripts), so the assertion that inline execution stays closed belongs with the
    // other production-build checks below.
  });

  // The dev server needs un-nonced inline scripts for fast refresh, so the strict policy is
  // only asserted against a production build (which is what CI and prod actually run).
  test('uses a strict nonce policy in production builds', async ({ page }) => {
    test.skip(process.env['NODE_ENV'] === 'development', 'dev server uses a relaxed CSP');

    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src [^;]*'nonce-/);
    expect(csp).toMatch(/script-src [^;]*'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-eval'/);
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);

    const unnonced = await page.locator('script:not([nonce]):not([src])').count();
    expect(unnonced).toBe(0);
  });
});
