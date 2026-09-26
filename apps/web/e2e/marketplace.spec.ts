import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { signInOnce } from './helpers';

/**
 * Selling and buying, through the browser (FR-5.2, FR-5.3, SR-5.5).
 *
 * The marketplace was the only part of this system with no end-to-end test, and it is the only
 * part that moves money. Every other area — the catalogue, collections, breaks, passkeys, the
 * legal pages — had one.
 *
 * ## What this can and cannot reach
 *
 * Payments are configured per deployment: `registerSellerRoutes` and `registerCheckoutRoutes`
 * are registered only when the API has a Stripe client, and CI has none. **Listings are not**:
 * `registerMarketRoutes` is unconditional, because a draft, a photograph and a price are all
 * ours to store and none of them involves Stripe.
 *
 * So this suite covers the whole of selling up to the moment money changes hands: preparing a
 * listing, the photograph requirement above the threshold, putting it on sale, and a stranger
 * finding it. The purchase itself needs Stripe Connect enabled in a real dashboard, which is
 * recorded as blocked rather than faked — a test that mocked Stripe here would be testing the
 * mock, and the interesting failures are all in the real one.
 */
const SELLER_EMAIL = process.env['E2E_SELLER_EMAIL'] ?? 'market-seller@example.test';
const BUYER_EMAIL = process.env['E2E_BUYER_EMAIL'] ?? 'market-buyer@example.test';

/**
 * Fill in the form and hand back the id of what it created.
 *
 * By id, not by price. The first version of this suite found its listing by filtering on the
 * price it had just typed, which works exactly until two runs pick the same one — and the
 * local database keeps every listing every run has ever made. Under $25 there are only a few
 * thousand prices to go round, so "unique enough" was a matter of time rather than of design.
 */
async function createListing(page: Page, variantId: string, price: string): Promise<string> {
  await page.getByTestId('listing-variant').fill(variantId);
  await page.getByTestId('listing-price').fill(price);
  await page.getByTestId('listing-create').click();

  /**
   * The id comes out of the page, not out of a second API call.
   *
   * Asking `GET /v1/listings` for it meant a request whose auth, rate limit and response shape
   * were all extra things that could differ from the browser's — and in CI they did: the body
   * had no `items`, and the failure was a TypeError in the helper rather than anything about
   * the feature. The page already knows the id; every row's buttons are named with it.
   *
   * The list is newest first, so what was just created is at the top.
   */
  const newest = page.getByTestId('listing-list').locator('li').first();
  await expect(newest).toContainText(`$${price}`);

  const marker = await newest.getByTestId(/^publish-/).getAttribute('data-testid');
  const id = marker?.slice('publish-'.length);
  if (id === undefined || id === '') {
    throw new Error('the new listing has no publish button to take an id from');
  }
  return id;
}

/** A card from the sample seed, and the variant id the listing form takes. */
async function firstVariant(
  request: APIRequestContext,
): Promise<{ cardId: string; variantId: string }> {
  const cards = await request.get('/v1/cards?limit=1');
  const cardId = ((await cards.json()) as { items: { id: string }[] }).items[0]?.id;
  if (cardId === undefined) throw new Error('the sample seed has no cards');

  const detail = await request.get(`/v1/cards/${cardId}`);
  const variantId = ((await detail.json()) as { variants: { id: string }[] }).variants[0]?.id;
  if (variantId === undefined) throw new Error('that card has no printings');
  return { cardId, variantId };
}

test.describe('selling', () => {
  test('is usable before payments are set up', async ({ page }) => {
    /**
     * The regression this suite was written for.
     *
     * The first version of the selling page asked Stripe whether this person could take money
     * and, when the answer was "there is no Stripe here", rendered a single sentence saying the
     * marketplace did not exist — hiding the listing form, which never needed Stripe at all. On
     * a stock local install, and in CI, selling was a dead page.
     *
     * Written so it holds either way: where payments *are* configured the onboarding button is
     * shown instead, and the listing form is present in both cases. That is the actual claim —
     * preparing to sell does not depend on a payment provider.
     */
    await signInOnce(page, SELLER_EMAIL);
    await page.goto('/account/selling');

    await expect(page.getByTestId('listing-variant')).toBeVisible();
    await expect(page.getByTestId('listing-create')).toBeVisible();

    const unavailable = page.getByTestId('payments-unavailable');
    const onboard = page.getByTestId('onboard');
    const ready = page.getByTestId('seller-ready');
    await expect(unavailable.or(onboard).or(ready)).toBeVisible();
  });

  /**
   * The seller's public name (FR-5.7, SR-3.8).
   *
   * Offered only where there is a connected account to hang it on, which is the control: a
   * public seller identity costs a completed identity check, so an unverified account cannot
   * call itself a shop. Where payments are not configured — CI — the field is absent, and that
   * absence is the assertion.
   */
  test('offers a seller name only where there is an account for it', async ({ page }) => {
    await signInOnce(page, SELLER_EMAIL);
    await page.goto('/account/selling');

    /**
     * Three states, because a deployment can be in any of them and the page has to be right in
     * all three:
     *
     * 1. **No payment provider.** The field is not offered at all — this is CI.
     * 2. **A provider, but no connected account.** The field is offered and saving is refused,
     *    because the name lives on the account row and there is not one yet. This is the
     *    developer machine, where Stripe is configured but Connect is not enabled.
     * 3. **A connected account.** It saves, and a stranger sees it.
     */
    const field = page.getByTestId('seller-name');
    if ((await page.getByTestId('payments-unavailable').count()) > 0) {
      await expect(field).toHaveCount(0);
      return;
    }

    await expect(field).toBeVisible();
    const chosen = `E2E Seller ${String(Date.now()).slice(-6)}`;
    await field.fill(chosen);
    await page.getByTestId('seller-name-save').click();

    const saved = page.getByTestId('seller-name-saved');
    const problem = page.getByTestId('selling-problem');
    await expect
      .poll(async () => (await saved.count()) > 0 || (await problem.count()) > 0, {
        message: 'saving a seller name neither succeeded nor said why not',
      })
      .toBe(true);

    if ((await saved.count()) === 0) {
      // State 2. The refusal has to name the actual obstacle — "set up payments first" — and
      // must not be the generic shrug, because the seller can act on the first and not the
      // second.
      await expect(problem).toContainText(/set up payments/i);
      return;
    }

    // State 3: it reaches a stranger, on the public card page, next to the price.
    const { cardId, variantId } = await firstVariant(page.request);
    const id = await createListing(page, variantId, '6.75');
    await page.getByTestId(`publish-${id}`).click();
    await expect(page.getByTestId(`status-${id}`)).toHaveText('active');

    await page.goto(`/cards/${cardId}`);
    await expect(page.getByTestId(`seller-${id}`)).toContainText(chosen);
  });

  test('saves a draft rather than publishing it', async ({ page }) => {
    // Saving is not publishing. Somebody filling in a form has not agreed to sell anything yet.
    await signInOnce(page, SELLER_EMAIL);
    const { variantId } = await firstVariant(page.request);

    await page.goto('/account/selling');
    await page.getByTestId('listing-variant').fill(variantId);
    await page.getByTestId('listing-price').fill('4.00');
    await page.getByTestId('listing-create').click();

    const listing = page.getByTestId('listing-list').locator('li').first();
    await expect(listing).toContainText('$4.00');
    await expect(listing).toContainText('draft');
    await expect(listing.getByRole('button', { name: 'Put on sale' })).toBeVisible();
  });

  test('will not put an expensive card on sale without a photograph', async ({ page }) => {
    /**
     * The control from FR-5.2, seen from the browser.
     *
     * $40 is over the $25 threshold, so publishing must be refused until an *approved*
     * photograph exists. A pending upload is a file nobody has inspected; letting one satisfy
     * the requirement would turn the control into "did somebody send us bytes".
     *
     * The refusal is the database's and the domain rule's; what is asserted here is that a
     * seller is told which rule they hit, in words they can act on.
     */
    await signInOnce(page, SELLER_EMAIL);
    const { variantId } = await firstVariant(page.request);

    await page.goto('/account/selling');
    const id = await createListing(page, variantId, '40.00');

    await page.getByTestId(`publish-${id}`).click();

    await expect(page.getByTestId('selling-problem')).toBeVisible();
    await expect(page.getByTestId('selling-problem')).toContainText(/photo/i);
    // And it really did not go on sale, rather than merely being complained about.
    await expect(page.getByTestId(`status-${id}`)).toHaveText('draft');
  });

  test('puts a cheap card on sale, and a stranger can find it', async ({ page, browser }) => {
    await signInOnce(page, SELLER_EMAIL);
    const { cardId, variantId } = await firstVariant(page.request);

    await page.goto('/account/selling');
    const id = await createListing(page, variantId, '7.50');

    await page.getByTestId(`publish-${id}`).click();
    await expect(page.getByTestId(`status-${id}`)).toHaveText('active');

    /**
     * Now the half that did not exist until recently: somebody else finding it.
     *
     * A separate browser context, so this is a different visitor with no session — which is
     * the point. The shop window has to be readable without signing in, or nobody arrives.
     */
    const stranger = await browser.newContext();
    try {
      const strangerPage = await stranger.newPage();
      await strangerPage.goto(`/cards/${cardId}`);

      const forSale = strangerPage.getByTestId('for-sale');
      await expect(forSale).toBeVisible();
      const row = strangerPage.getByTestId(`listing-${id}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText('$7.50');

      // Unrated, and said as "no ratings yet" rather than as nought out of five.
      await expect(row).toContainText(/no ratings yet/i);
      // Signed out, so the button asks for a sign-in before it asks for money.
      await expect(row.getByRole('link', { name: /sign in to buy/i })).toBeVisible();
      // And the seller is not named on a page that answers to anybody (SR-3.8).
      expect(await forSale.innerText()).not.toContain('@');
    } finally {
      await stranger.close();
    }
  });

  test('takes it off sale again', async ({ page }) => {
    await signInOnce(page, SELLER_EMAIL);
    const { cardId, variantId } = await firstVariant(page.request);

    await page.goto('/account/selling');
    const id = await createListing(page, variantId, '9.25');

    await page.getByTestId(`publish-${id}`).click();
    await expect(page.getByTestId(`status-${id}`)).toHaveText('active');

    await page.getByTestId(`withdraw-${id}`).click();
    await expect(page.getByTestId(`status-${id}`)).toHaveText('withdrawn');

    // Gone from the shop window too, not merely relabelled on the seller's own page.
    await page.goto(`/cards/${cardId}`);
    await expect(page.getByTestId(`listing-${id}`)).toHaveCount(0);
  });

  test('refuses a card variant id that is not one', async ({ page }) => {
    await signInOnce(page, SELLER_EMAIL);
    await page.goto('/account/selling');

    await page.getByTestId('listing-variant').fill(randomUUID());
    await page.getByTestId('listing-price').fill('5.00');
    await page.getByTestId('listing-create').click();

    // A well-formed uuid for a printing that does not exist: refused by the foreign key, and
    // reported as something the seller can act on rather than as a stack trace. Specifically
    // *not* "that listing is no longer there" — there is no listing yet, that was the point.
    await expect(page.getByTestId('selling-problem')).toContainText(
      /no card printing has that id/i,
    );
  });
});

test.describe('photographs', () => {
  /**
   * The upload, all the way through, in a browser (SR-5.5).
   *
   * This is the one leg nothing else covers. The pipeline has unit tests and the routes have
   * integration tests, but the middle step — **the browser PUTs the file straight to the
   * bucket**, to another origin, with exactly the headers the signature covers — happens
   * nowhere except here. It is also the leg the site's Content-Security-Policy can silently
   * forbid: `connect-src` has to name the bucket or the request never leaves the page, and the
   * failure appears only in a console nobody is reading.
   *
   * Needs object storage and a scanner, which are a compose profile rather than the default,
   * so it says so and skips rather than failing where they are not running.
   */
  test('goes from the browser to the bucket, and comes back approved', async ({ page }) => {
    test.setTimeout(120_000);
    /**
     * A blocked upload reports itself the same way whether the bucket is absent or merely
     * misconfigured, because the browser will not say which to a page. So the *suite* is told
     * which to expect: CI runs the storage profile and sets this, and there a failure is a
     * failure. Without it — a checkout with no `--profile photos` — the test steps aside.
     *
     * This matters more than it looks. The bug this test was written to find was a CORS policy
     * that did not exist, and a skip-on-anything version of it would have gone quiet on
     * exactly that.
     */
    const required = process.env['E2E_EXPECT_PHOTOS'] === '1';
    await signInOnce(page, SELLER_EMAIL);
    const { cardId, variantId } = await firstVariant(page.request);

    await page.goto('/account/selling');
    // Over the $25 threshold on purpose: this listing cannot go on sale until a photograph
    // has been approved, so publishing it at the end is the proof that one was.
    const id = await createListing(page, variantId, '40.00');

    await page
      .getByTestId(`upload-${id}`)
      .setInputFiles(fileURLToPath(new URL('./fixtures/card-photo.jpg', import.meta.url)));

    const problem = page.getByTestId('selling-problem');
    const gallery = page.getByTestId(`photo-list-${id}`);
    await expect
      .poll(async () => (await gallery.count()) > 0 || (await problem.count()) > 0, {
        timeout: 60_000,
        message: 'the upload neither produced a gallery nor explained itself',
      })
      .toBe(true);

    if ((await problem.count()) > 0) {
      const said = await problem.innerText();
      if (required) throw new Error(`the upload failed and this run expects it to work: ${said}`);
      test.skip(true, `photo storage is not running for this suite: ${said}`);
    }

    // Approved means a picture, not a word. A pending or refused photo renders text instead.
    await expect(gallery.locator('img')).toBeVisible({ timeout: 60_000 });

    // And the threshold opens: what was refused before the photograph is allowed after it.
    await page.getByTestId(`publish-${id}`).click();
    await expect(page.getByTestId(`status-${id}`)).toHaveText('active');

    // Finally, the buyer's side of the same picture: a signed link on the public card page.
    await page.goto(`/cards/${cardId}`);
    const shown = page.getByTestId(`photo-${id}`);
    await expect(shown).toBeVisible();
    // Loaded, not merely present. A broken signature would render an empty box, and
    // `naturalWidth` is how the browser says it actually decoded an image.
    await expect
      .poll(async () => shown.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
  });
});

test.describe('buying', () => {
  test('shows a signed-in visitor a real buy button', async ({ page }) => {
    await signInOnce(page, SELLER_EMAIL);
    const { cardId, variantId } = await firstVariant(page.request);

    await page.goto('/account/selling');
    const id = await createListing(page, variantId, '5.25');
    await page.getByTestId(`publish-${id}`).click();
    await expect(page.getByTestId(`status-${id}`)).toHaveText('active');

    // A different person, so the seller's cookie has to go first: `signInOnce` adds a cached
    // session, it does not replace one, and the old cookie would otherwise win.
    await page.context().clearCookies();
    await signInOnce(page, BUYER_EMAIL);
    await page.goto(`/cards/${cardId}`);

    const row = page.getByTestId(`listing-${id}`);
    const buy = row.getByRole('button', { name: 'Buy' });
    await expect(buy).toBeVisible();

    /**
     * Pressed, and the refusal read.
     *
     * Where Stripe is not configured the checkout route is not registered at all, and the
     * answer is Fastify's own 404 — which must not be reported as "that listing is gone".
     * Where it *is* configured this reaches Stripe and navigates away. Both are acceptable;
     * what is not acceptable is the button silently doing nothing, which is what an untested
     * error path looks like from the outside.
     */
    await buy.click();
    const problem = page.getByTestId(`buy-problem-${id}`);
    await expect
      .poll(async () => (await problem.count()) > 0 || !page.url().includes('/cards/'), {
        message: 'the buy button neither navigated to a checkout nor explained why it could not',
      })
      .toBe(true);

    if ((await problem.count()) > 0) {
      /**
       * No checkout on this deployment, or the listing went in between. The API makes those
       * two indistinguishable on purpose (SR-3.3), so what is asserted is that the refusal
       * says something true of both — and specifically that it does not claim the listing is
       * gone, which is the one reading that would be wrong half the time.
       */
      await expect(problem).toContainText(/cannot be bought|payments yet|just gone|sign in/i);
    }
  });
});
