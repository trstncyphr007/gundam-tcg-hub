import { expect, test } from '@playwright/test';

/**
 * Price history charts (FR-3.3), against the synthetic index `pnpm db:seed-prices` writes.
 *
 * The CI stack seeds it, so these assert on shape — a line exists, ranges switch, an
 * unpriced condition says so — rather than on particular numbers, which would make the test
 * a copy of the seed generator.
 */
async function openFirstCard(page: import('@playwright/test').Page): Promise<string> {
  const response = await page.request.get('/v1/cards?q=Gamma');
  const { items } = (await response.json()) as { items: { id: string }[] };
  const id = items[0]?.id;
  expect(id, 'the sample catalog should have a Gamma card').toBeTruthy();
  return String(id);
}

test.describe('price charts', () => {
  test('draws a chart with no client-side charting library', async ({ page }) => {
    const id = await openFirstCard(page);
    await page.goto(`/cards/${id}?days=30&condition=nm`);

    await expect(page.getByRole('heading', { name: /Sample Pilot Gamma/ })).toBeVisible();

    // Server-rendered SVG: the data is in the HTML, not fetched and drawn afterwards.
    const chart = page.locator('svg[role="img"]');
    await expect(chart).toBeVisible();
    await expect(chart.locator('polyline')).not.toHaveCount(0);
    // The band is the 25th–75th percentile: one number alone hides the spread.
    await expect(chart.locator('polygon')).not.toHaveCount(0);

    await expect(page.getByTestId('latest-median')).toContainText('$');
    await expect(page.getByTestId('source-mix')).toContainText('live sales');
  });

  test('switching range is a link, so it works without JavaScript', async ({ browser }) => {
    // JavaScript off entirely: the chart, the ranges and the summary must all still work.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const id = await openFirstCard(page);

    await page.goto(`/cards/${id}?days=90&condition=nm`);
    await expect(page.locator('svg[role="img"] polyline')).not.toHaveCount(0);

    await page.getByTestId('range-7d').click();
    await expect(page).toHaveURL(/days=7/);
    await expect(page.locator('svg[role="img"]')).toBeVisible();
    await expect(page.getByTestId('range-7d')).toHaveAttribute('aria-current', 'page');

    await context.close();
  });

  test('says so when there is not enough data, rather than showing zero', async ({ page }) => {
    const id = await openFirstCard(page);
    // Nothing is seeded for moderately played, and the index publishes nothing below three
    // observations. A collector must not read that as "your card is worthless".
    await page.goto(`/cards/${id}?days=30&condition=mp`);

    await expect(page.getByText('Not enough data to publish a price')).toBeVisible();
    await expect(page.getByText('declining to guess')).toBeVisible();
    await expect(page.locator('svg[role="img"]')).toHaveCount(0);
  });

  test('the methodology page explains the numbers', async ({ page }) => {
    const id = await openFirstCard(page);
    await page.goto(`/cards/${id}?days=30&condition=nm`);

    await page.getByRole('link', { name: /how this is computed/i }).click();
    await expect(page).toHaveURL(/\/methodology/);
    await expect(page.getByRole('heading', { name: 'How prices are computed' })).toBeVisible();
    // The two rules that make the index defensible.
    await expect(page.getByText(/Nothing is published below three sales/)).toBeVisible();
    await expect(page.getByText(/means four sales/)).toBeVisible();
  });
});
