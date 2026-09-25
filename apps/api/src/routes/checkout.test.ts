import { createAuth } from '@gth/auth';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import {
  type CheckoutInput,
  type RefundInput,
  type StripeClient,
  createStripeClient,
} from '../payments/stripe.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * A purchase, end to end (FR-5.3, AC-5.1).
 *
 * Two halves, faked differently on purpose.
 *
 * **Creating the Checkout session is a stub**, because what is under test there is our half:
 * that the amount comes from the listing rather than the request, that the fee is computed
 * from that amount, that the destination is the seller's connected account, and that our order
 * id travels in the metadata. A real network call would prove none of it.
 *
 * **The webhook that follows is signed for real** — Stripe's own header generator, Stripe's own
 * `constructEvent`, local HMAC, no network. Nothing is faked on the half that decides whether
 * to believe a claim that money moved, because a stub there would prove only that a stub
 * returns what it was told to.
 */
const WEBHOOK_SECRET = 'whsec_checkout_test_secret_for_signatures';
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const ORIGIN = 'http://127.0.0.1:3000';
/** No underscore after the prefix: `seller_accounts_stripe_id_format` refuses one, as Stripe
 *  never issues one. The first version of this fixture did, and the CHECK said so. */
const SELLER_ACCOUNT = 'acct_checkoutseller';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;

let buyerCookie = '';
let sellerCookie = '';
let sellerId = '';
let variantId = '';
const sentLinks: { email: string; url: string }[] = [];

/** Every Checkout session the route asked for, so a test can read what Stripe was told. */
const sessions: CheckoutInput[] = [];
/** And every refund, for the same reason. */
const refunds: RefundInput[] = [];

const fakeStripe: StripeClient = {
  createConnectedAccount: ({ userId }) =>
    Promise.resolve({ accountId: `acct_${userId.replace(/[^A-Za-z0-9]/gu, '')}` }),
  createOnboardingLink: () => Promise.resolve({ url: 'https://connect.stripe.test/setup' }),
  getAccountStatus: () =>
    Promise.resolve({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }),
  constructEvent: () => {
    throw new Error('the webhook uses a real client');
  },
  setPayoutSchedule: () => Promise.resolve(),
  refundPayment: (input) => {
    refunds.push(input);
    return Promise.resolve({ id: `re_test_${String(refunds.length)}`, status: 'succeeded' });
  },
  createCheckoutSession: (input) => {
    sessions.push(input);
    return Promise.resolve({
      id: `cs_test_${String(sessions.length)}`,
      url: `https://checkout.stripe.test/${input.orderId}`,
    });
  },
};

let ipCounter = 0;
async function signIn(email: string): Promise<string> {
  ipCounter += 1;
  const ip = `198.51.103.${String(ipCounter % 250)}`;
  const before = sentLinks.length;
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: ORIGIN, 'x-forwarded-for': ip },
    payload: { email, callbackURL: '/' },
  });
  const url = new URL(String(sentLinks.at(before)?.url));
  const verified = await app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    headers: { 'x-forwarded-for': ip },
  });
  const raw = verified.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('\n') : String(raw);
  return String(/gth\.session_token=[^;\s]+/.exec(joined)?.[0]);
}

/**
 * A buyer nobody has used before.
 *
 * One per test, because buying is limited to ten a minute **per account** and a file that
 * shares one buyer across seventeen tests spends that allowance on itself. The first version
 * did exactly that, and six tests failed on a 429 from a limiter working correctly — the same
 * way `seller.test.ts` found its own onboarding limit.
 */
let buyerCounter = 0;
async function newBuyer(): Promise<string> {
  buyerCounter += 1;
  return signIn(`checkout-buyer-${String(buyerCounter)}@example.com`);
}

/**
 * A listing on sale, by a seller Stripe has cleared.
 *
 * Keep the price at or below `PHOTO_REQUIRED_ABOVE_CENTS`. Above it a listing cannot go active
 * without photos, which slice 4 has not built yet — so publishing quietly fails and every later
 * assertion blames the wrong thing. It cost two confusing failures here, hence the assertion
 * below: this helper says *why* rather than handing back a draft nobody can buy.
 */
async function listForSale(priceCents = 2000): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: { cookie: sellerCookie, origin: ORIGIN },
    payload: { cardVariantId: variantId, condition: 'nm', priceCents, quantity: 1 },
  });
  const id = created.json<{ id: string }>().id;
  const published = await app.inject({
    method: 'POST',
    url: `/v1/listings/${id}/status`,
    headers: { cookie: sellerCookie, origin: ORIGIN },
    payload: { status: 'active' },
  });
  expect(published.statusCode, `could not put ${String(priceCents)}c on sale`).toBe(200);
  return id;
}

function buy(listingId: string, cookie = buyerCookie) {
  return app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/buy`,
    headers: { cookie, origin: ORIGIN },
  });
}

/** A signed delivery, exactly as Stripe would send it. */
function deliver(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    payload,
  });
}

function sessionCompleted(orderId: string, sessionId: string, eventId: string, extra = {}) {
  return {
    id: eventId,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: `pi_for_${orderId}`,
        metadata: { orderId },
        total_details: { amount_tax: 0 },
        ...extra,
      },
    },
  };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });

  const auth = createAuth(tdb.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: ['http://127.0.0.1:4000', ORIGIN],
    production: false,
    trustProxyHeaders: true,
    passkey: TEST_PASSKEY,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
  });

  app = await buildApp(config, {
    db: tdb.db,
    writeDb: webPool.db,
    auth,
    seller: { db: webPool.db, stripe: fakeStripe, appBaseUrl: ORIGIN },
    checkout: { db: webPool.db, stripe: fakeStripe, appBaseUrl: ORIGIN, feeBps: 500 },
    stripeWebhook: {
      workerDb: workerPool.db,
      // A real client. Only `constructEvent` is exercised, and it never calls out.
      stripe: createStripeClient({ secretKey: 'sk_test_unused', webhookSecret: WEBHOOK_SECRET }),
    },
  });

  sellerCookie = await signIn('checkout-seller@example.com');
  const [seller] = await tdb.db.execute<{ id: string }>(
    `select id from app.users where email = 'checkout-seller@example.com'`,
  );
  sellerId = String(seller?.id);

  const [variant] = await tdb.db.execute<{ id: string }>(
    `select id from app.card_variants limit 1`,
  );
  variantId = String(variant?.id);
}, 180_000);

afterAll(async () => {
  await app.close();
  await webPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(
    `truncate app.orders, app.listings, app.seller_accounts, app.webhook_events, app.audit_log cascade`,
  );
  sessions.length = 0;
  buyerCookie = await newBuyer();
  // Stripe has cleared this seller. Written on the worker because the two capability columns
  // are outside what a session may write at all (migration 0041) — which is the point.
  await workerPool.db.execute(
    `insert into app.seller_accounts (user_id, stripe_account_id, charges_enabled, payouts_enabled)
     values ('${sellerId}', '${SELLER_ACCOUNT}', true, true)`,
  );
});

describe('starting a purchase', () => {
  it('opens an order and hands back Stripe’s hosted page', async () => {
    const listingId = await listForSale(2500);
    const res = await buy(listingId);

    expect(res.statusCode).toBe(201);
    expect(res.json<{ orderId: string }>().orderId).toBeTruthy();
    const body = res.json<{ orderId: string; checkoutUrl: string }>();
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//u);

    const [order] = await workerPool.db.execute<{ status: string; amount_cents: number }>(
      `select status, amount_cents from app.orders where id = '${body.orderId}'`,
    );
    // Created, not paid. Nothing on this path can write `paid`, and the buyer has not yet been
    // anywhere near a card.
    expect(order).toMatchObject({ status: 'created', amount_cents: 2500 });
  });

  it('takes the amount from the listing and the fee from the amount', async () => {
    const listingId = await listForSale(2400);
    await buy(listingId);

    const asked = sessions.at(-1);
    // 500bps of $24.00 is $1.20. Nothing in the request body said so, because the request body
    // was empty — there is no field a buyer could have used to say otherwise.
    expect(asked).toMatchObject({ amountCents: 2400, quantity: 1, applicationFeeCents: 120 });
    // The money goes to the seller's connected account, less that fee.
    expect(asked?.destinationAccountId).toBe(SELLER_ACCOUNT);
  });

  it('puts our order id in the metadata, which is how the payment finds its way back', async () => {
    const listingId = await listForSale();
    const res = await buy(listingId);
    expect(sessions.at(-1)?.orderId).toBe(res.json<{ orderId: string }>().orderId);
  });

  it('names the card, rather than showing a buyer a UUID at the moment they pay', async () => {
    const listingId = await listForSale();
    await buy(listingId);
    // The line item is the last thing somebody reads before handing over a card number.
    expect(sessions.at(-1)?.description).toMatch(/ — .+-.+ · NM$/u);
  });

  it('sends the buyer back to a URL of ours, never one from the request', async () => {
    const listingId = await listForSale();
    await buy(listingId);
    expect(sessions.at(-1)?.successUrl.startsWith(ORIGIN)).toBe(true);
    expect(sessions.at(-1)?.cancelUrl.startsWith(ORIGIN)).toBe(true);
  });
});

describe('purchases that are refused', () => {
  it('refuses a listing that is not on sale', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { cardVariantId: variantId, condition: 'nm', priceCents: 1500, quantity: 1 },
    });
    // A draft, never published. Its seller can see it; nobody can buy it.
    const res = await buy(created.json<{ id: string }>().id);
    expect(res.statusCode).toBe(404);
    expect(sessions).toHaveLength(0);
  });

  it('refuses to let a seller buy their own card', async () => {
    const listingId = await listForSale();
    const res = await buy(listingId, sellerCookie);

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('cannot_buy_own_listing');
    // Answered before Stripe was asked for anything. The database CHECK would have refused it
    // too, but only after a session had been created and paid for.
    expect(sessions).toHaveLength(0);
  });

  it('refuses when Stripe has not cleared the seller to take money', async () => {
    const listingId = await listForSale();
    await workerPool.db.execute(
      `update app.seller_accounts set charges_enabled = false where user_id = '${sellerId}'`,
    );

    const res = await buy(listingId);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('seller_not_ready');
  });

  it('refuses when the seller has no connected account at all', async () => {
    const listingId = await listForSale();
    await tdb.db.execute(`truncate app.seller_accounts cascade`);

    const res = await buy(listingId);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('seller_not_ready');
  });

  it('refuses a second buyer while the first is still at the checkout', async () => {
    const listingId = await listForSale();
    const rival = await newBuyer();

    expect((await buy(listingId)).statusCode).toBe(201);
    const second = await buy(listingId, rival);

    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toBe('listing_unavailable');
    // One session asked for, not two. Two would be two charges for one card.
    expect(sessions).toHaveLength(1);
  });

  it('refuses an anonymous caller', async () => {
    const listingId = await listForSale();
    const res = await app.inject({ method: 'POST', url: `/v1/listings/${listingId}/buy` });
    expect(res.statusCode).toBe(401);
  });
});

describe('the payment arriving', () => {
  it('marks the order paid and the listing sold', async () => {
    const listingId = await listForSale(2000);
    const { orderId } = (await buy(listingId)).json<{ orderId: string }>();

    const res = await deliver(sessionCompleted(orderId, 'cs_test_1', 'evt_paid_1'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    const [order] = await workerPool.db.execute<{
      status: string;
      stripe_payment_intent_id: string;
      paid_at: string | null;
    }>(`select status, stripe_payment_intent_id, paid_at from app.orders where id = '${orderId}'`);
    expect(order?.status).toBe('paid');
    expect(order?.stripe_payment_intent_id).toBe(`pi_for_${orderId}`);
    expect(order?.paid_at).not.toBeNull();

    const [listing] = await workerPool.db.execute<{ status: string }>(
      `select status from app.listings where id = '${listingId}'`,
    );
    expect(listing?.status).toBe('sold');
  });

  it('lets the buyer see their own order become paid', async () => {
    const listingId = await listForSale();
    const { orderId } = (await buy(listingId)).json<{ orderId: string }>();
    await deliver(sessionCompleted(orderId, 'cs_test_1', 'evt_paid_2'));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
      headers: { cookie: buyerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('paid');
  });

  it('does not believe a session that completed without being paid', async () => {
    // A delayed payment method leaves the session complete and `unpaid` until it clears, on a
    // different event. Believing the wrong one ships a card for nothing.
    const listingId = await listForSale();
    const { orderId } = (await buy(listingId)).json<{ orderId: string }>();

    const event = sessionCompleted(orderId, 'cs_test_1', 'evt_unpaid', {
      payment_status: 'unpaid',
    });
    expect((await deliver(event)).statusCode).toBe(200);

    const [order] = await workerPool.db.execute<{ status: string }>(
      `select status from app.orders where id = '${orderId}'`,
    );
    expect(order?.status).toBe('created');
  });

  it('is a no-op when the same event is delivered twice', async () => {
    // AC-5.2. Stripe retries anything that is not a prompt 2xx, so this is normal traffic.
    const listingId = await listForSale();
    const { orderId } = (await buy(listingId)).json<{ orderId: string }>();
    const event = sessionCompleted(orderId, 'cs_test_1', 'evt_twice');

    await deliver(event);
    const second = await deliver(event);

    expect(second.json()).toEqual({ received: true, duplicate: true });
    const events = await workerPool.db.execute(
      `select id from app.order_events where order_id = '${orderId}'`,
    );
    expect(events, 'the replay recorded a second transition').toHaveLength(1);
  });

  it('shrugs at a payment for an order it has never heard of', async () => {
    const event = sessionCompleted('00000000-0000-4000-8000-000000000000', 'cs_ghost', 'evt_ghost');
    // 200, and logged. Not a 500: Stripe would retry this for days and the answer would not
    // change, and a permanent retry loop is not how anybody finds out about it.
    expect((await deliver(event)).statusCode).toBe(200);
  });

  it('is refused outright when the signature is wrong, and nothing moves', async () => {
    const listingId = await listForSale();
    const { orderId } = (await buy(listingId)).json<{ orderId: string }>();

    const payload = JSON.stringify(sessionCompleted(orderId, 'cs_test_1', 'evt_forged'));
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_somebody_elses_secret',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const [order] = await workerPool.db.execute<{ status: string }>(
      `select status from app.orders where id = '${orderId}'`,
    );
    // The whole marketplace in one assertion: anybody can POST here, and only the signature
    // makes it mean anything.
    expect(order?.status).toBe('created');
  });
});

describe('velocity and new-account limits (SR-5.6)', () => {
  /**
   * An expensive listing, put on sale through the worker.
   *
   * Above $25 a listing needs photos before it can go live, and this file has no pipeline to
   * approve any. The worker may set the status directly, which is the shortest honest route to
   * the starting position these tests need — the photo rule is exercised properly in
   * `photos.test.ts`.
   */
  async function expensiveListing(priceCents: number): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { cardVariantId: variantId, condition: 'nm', priceCents, quantity: 1 },
    });
    const id = created.json<{ id: string }>().id;
    await workerPool.db.execute(`update app.listings set status = 'active' where id = '${id}'`);
    return id;
  }

  it('refuses a brand new account something expensive', async () => {
    /**
     * The pattern this exists for: an account created minutes ago going straight for the most
     * expensive thing it can find. Every buyer in this file is minutes old, which makes it the
     * right place to check.
     */
    const listingId = await expensiveListing(40_000);
    const refused = await buy(listingId);

    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toBe('new_account_order_too_large');
    // Refused before Stripe was asked for anything, and before an order row existed.
    expect(sessions).toHaveLength(0);
  });

  it('never tells them where the line is', async () => {
    // A refusal that names the threshold tells a fraudster exactly how to stay under it.
    const listingId = await expensiveListing(40_000);
    const body = (await buy(listingId)).body;

    expect(body).not.toContain('15000');
    expect(body).not.toContain('150');
  });

  it('records the numbers in the audit log, where they belong', async () => {
    const listingId = await expensiveListing(40_000);
    await buy(listingId);

    const [entry] = await workerPool.db.execute<{ diff: Record<string, unknown> }>(
      `select diff from app.audit_log where action = 'order.refused'`,
    );
    expect(entry?.diff).toMatchObject({
      reason: 'new_account_order_too_large',
      amountCents: 40_000,
    });
  });

  it('lets the same new account buy something ordinary', async () => {
    // The rule is about size, not about being new. A new buyer spending $25 is the customer
    // this marketplace exists for.
    expect((await buy(await listForSale(2500))).statusCode).toBe(201);
  });

  it('stops a new account after its third order of the day', async () => {
    /**
     * Each purchase needs its own listing, because one open order per listing is enforced by a
     * unique index. Three succeed; the fourth is refused for the count rather than the size.
     */
    for (let i = 0; i < 3; i += 1) {
      expect((await buy(await listForSale(1000))).statusCode).toBe(201);
    }
    const fourth = await buy(await listForSale(1000));

    expect(fourth.statusCode).toBe(403);
    expect(fourth.json<{ error: string }>().error).toBe('new_account_daily_limit');
  });
});
