import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Every page behind a sign-in closes itself to a stranger (SR-X.6, T4).
 *
 * The API has its own sweep (`deny-by-default.test.ts`) and is the thing that actually holds
 * the data, so a page that forgot its check could not leak rows. What it could do is render a
 * half-built shell, or fall over, which is its own kind of broken — and the existing coverage
 * was one page out of eleven.
 *
 * **The list is read off disk, not written here.** The API sweep needs a hand-maintained list
 * and a second test to catch it rotting; the App Router keeps its routes in the filesystem, so
 * a new page under `/account`, `/creator` or `/admin` is covered the moment it is created and
 * nobody has to remember anything.
 */
const APP = join(process.cwd(), 'app', '(site)');

/**
 * Every route under a protected section, derived from the directories that define them.
 *
 * `security/detect-non-literal-fs-filename` is disabled below, and the reason it normally
 * fires does not apply: every path here is built from `process.cwd()` and names read out of
 * our own `app/` directory, at test time, on a developer's machine. Nothing a request could
 * influence reaches it.
 */
/* eslint-disable security/detect-non-literal-fs-filename */
function protectedRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string, url: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (!statSync(path).isDirectory()) continue;
      // `[id]` and the like need a value; a well-formed one that exists nowhere is the point,
      // since an anonymous visitor must be turned away before anything is looked up.
      const segment = entry.startsWith('[') ? '00000000-0000-4000-8000-000000000000' : entry;
      const child = `${url}/${segment}`;
      if (readdirSync(path).includes('page.tsx')) routes.push(child);
      walk(path, child);
    }
  };
  for (const section of ['account', 'creator', 'admin']) {
    const dir = join(APP, section);
    if (readdirSync(APP).includes(section)) walk(dir, `/${section}`);
  }
  return routes.sort();
}
/* eslint-enable security/detect-non-literal-fs-filename */

const routes = protectedRoutes();

test.describe('pages behind a sign-in', () => {
  test('there are some, and this test knows where to look', () => {
    // Guards the guard: a refactor that moves or renames the sections would otherwise leave
    // this sweeping an empty list and reporting success.
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  for (const route of routes) {
    test(`${route} offers a sign-in instead of its contents`, async ({ page }) => {
      const response = await page.goto(route);

      // Not an error page, and not a crash: a visitor who is not signed in is an ordinary
      // visitor, not an exception.
      expect(response?.status(), route).toBeLessThan(400);

      // The gate itself, by its marker. **Not** a "Sign in" link: the site header has one on
      // every page including the public ones, so asserting that would pass everywhere and
      // prove nothing. The first version of this test did exactly that.
      await expect(page.getByTestId('sign-in-required')).toBeVisible();
    });
  }
});
