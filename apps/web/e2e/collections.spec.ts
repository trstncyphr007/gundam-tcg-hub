import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The collection manager end to end (FR-3.4, FR-3.5, AC-3.2, AC-3.5), in a real browser
 * against the real stack.
 *
 * The seeded sample catalog has `SAMPLE-01` cards 001–003, which is what the CSV rows below
 * refer to. Nothing here depends on publisher data (plan §23).
 */
async function newCollection(page: import('@playwright/test').Page, name: string): Promise<string> {
  await page.goto('/account/collections');
  await page.getByTestId('collection-name').fill(name);
  await page.getByTestId('create-collection').click();
  const link = page.getByRole('link', { name, exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  return page.url().split('/').pop() ?? '';
}

test.describe('collections', () => {
  test('adds a card by searching for it, and counts it', async ({ page }) => {
    await signIn(page, `coll-${randomUUID().slice(0, 8)}@example.com`);
    await newCollection(page, `Binder ${randomUUID().slice(0, 8)}`);

    await page.getByTestId('card-search').fill('Sample Unit Alpha');
    await page.getByTestId('card-hits').getByRole('button').first().click();
    await expect(page.getByTestId('chosen-card')).toContainText('Sample Unit Alpha');

    await page.getByTestId('quantity').fill('2');
    await page.getByTestId('paid').fill('12.50');
    await page.getByTestId('add-card').click();

    const row = page.getByTestId('item-table').locator('tbody tr').first();
    await expect(row).toContainText('Sample Unit Alpha');
    await expect(row.getByTestId('item-quantity')).toHaveText('2');
    // Cents in the database, dollars on the screen, and no float in between.
    await expect(row).toContainText('$12.50');
  });

  test('says what it could not value instead of calling it zero', async ({ page }) => {
    await signIn(page, `value-${randomUUID().slice(0, 8)}@example.com`);
    await newCollection(page, `Value ${randomUUID().slice(0, 8)}`);

    await page.getByTestId('card-search').fill('Sample Unit Alpha');
    await page.getByTestId('card-hits').getByRole('button').first().click();
    await page.getByTestId('quantity').fill('3');
    await page.getByTestId('add-card').click();

    // No index price exists for the sample catalog, so the total is zero -- but the page has
    // to say *why*, or a collector reads it as "your cards are worthless".
    await expect(page.getByTestId('collection-value')).toHaveText('$0.00');
    await expect(page.getByTestId('not-valued')).toContainText('3 cards');
    await expect(page.getByTestId('not-valued')).toContainText('not worth nothing');
  });

  test('previews a CSV import before writing anything (FR-3.5)', async ({ page }) => {
    await signIn(page, `csv-${randomUUID().slice(0, 8)}@example.com`);
    await newCollection(page, `Import ${randomUUID().slice(0, 8)}`);

    await page
      .getByTestId('csv-text')
      .fill('set,number,quantity\nSAMPLE-01,001,2\nSAMPLE-01,002,zero\n');
    await page.getByTestId('preview-import').click();

    const report = page.getByTestId('import-report');
    await expect(report).toContainText('Nothing has been written yet');
    await expect(report).toContainText('Row 3');
    // The preview did not write: the table is still empty.
    await expect(page.getByTestId('item-table')).toHaveCount(0);

    await page.getByTestId('apply-import').click();
    await expect(page.getByTestId('import-report')).toContainText('1 added');
    await expect(page.getByTestId('item-table').locator('tbody tr')).toHaveCount(1);
  });

  test('an imported formula comes back out of the export neutralised (AC-3.5)', async ({
    page,
  }) => {
    await signIn(page, `formula-${randomUUID().slice(0, 8)}@example.com`);
    const id = await newCollection(page, `Formula ${randomUUID().slice(0, 8)}`);

    await page
      .getByTestId('csv-text')
      .fill(`set,number,quantity,notes\nSAMPLE-01,001,1,"=cmd|'/c calc'!A1"\n`);
    await page.getByTestId('preview-import').click();
    await page.getByTestId('apply-import').click();
    await expect(page.getByTestId('item-table').locator('tbody tr')).toHaveCount(1);

    const csv = await page.request.get(`/v1/collections/${id}/export`);
    expect(csv.status()).toBe(200);
    const body = await csv.text();
    expect(body).toContain(`"'=cmd|'/c calc'!A1"`);
    expect(body).not.toContain('"=cmd');
  });

  test('a private collection is not reachable by anyone else (AC-3.2)', async ({
    page,
    context,
  }) => {
    await signIn(page, `private-${randomUUID().slice(0, 8)}@example.com`);
    const id = await newCollection(page, `Private ${randomUUID().slice(0, 8)}`);

    const visitor = await context.browser()?.newContext();
    if (!visitor) throw new Error('no browser context');
    const stranger = await visitor.newPage();
    // 404, not 403: a 403 would confirm the id is real.
    const api = await stranger.request.get(`/v1/collections/${id}`);
    expect(api.status()).toBe(404);
    const page404 = await stranger.goto(`/collections/${id}`);
    expect(page404?.status()).toBe(404);
    await visitor.close();
  });

  test('sharing shows the cards but not the owner or what they paid (SR-3.8)', async ({
    page,
    context,
  }) => {
    const name = `Shared ${randomUUID().slice(0, 8)}`;
    await signIn(page, `share-${randomUUID().slice(0, 8)}@example.com`);
    const id = await newCollection(page, name);

    await page.getByTestId('card-search').fill('Sample Unit Alpha');
    await page.getByTestId('card-hits').getByRole('button').first().click();
    await page.getByTestId('paid').fill('42.00');
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('item-table')).toContainText('$42.00');

    await page.getByTestId('visibility').selectOption('unlisted');

    const visitor = await context.browser()?.newContext();
    if (!visitor) throw new Error('no browser context');
    const stranger = await visitor.newPage();
    await stranger.goto(`/collections/${id}`);
    await expect(stranger.getByRole('heading', { name })).toBeVisible();
    await expect(stranger.getByText('Sample Unit Alpha')).toBeVisible();
    // What it cost is the owner's business, and there is no gain to show without it.
    await expect(stranger.locator('body')).not.toContainText('$42.00');
    await expect(stranger.getByTestId('collection-gain')).toHaveText('—');

    // Unlisted means "not discoverable", so it must not appear in the public list.
    await stranger.goto('/collections');
    await expect(stranger.getByRole('link', { name })).toHaveCount(0);

    // Made public, it is listed.
    await page.getByTestId('visibility').selectOption('public');
    await stranger.goto('/collections');
    await expect(stranger.getByRole('link', { name })).toBeVisible();
    await visitor.close();
  });
});
