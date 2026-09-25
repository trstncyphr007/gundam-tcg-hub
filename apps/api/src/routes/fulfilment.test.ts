import { createAuth } from '@gth/auth';
import {
  createDb,
  createListing,
  createOrder,
  markOrderPaid,
  seedSample,
  setListingStatus,
} from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * Shipping, cancelling and disputing over HTTP (FR-5.4, FR-5.5, AC-5.4).
 *
 * `fulfilment.test.ts` in `packages/db` proves the database refuses what it should. This file
 * asks the question one layer up: does a request get the answer a client can act on?
 *
 * The distinction that matters here is between **404 and 403**. A stranger gets 404, because
 * the order is invisible to them and pretending otherwise would confirm it exists. A buyer
 * trying to ship gets 403, because they *can* see the order — telling them it does not exist
 * would be a lie they could check.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const ORIGIN = 'http://127.0.0.1:3000';
const TRACKING = { carrier: 'Royal Mail', trackingNumber: 'AB123456789GB' };

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;

let sellerCookie = '';
let buyerCookie = '';
let sellerId = '';
let buyerId = '';
let variantId = '';
const sentLinks: { email: string; url: string }[] = [];

let ipCounter = 0;
async function signIn(email: string): Promise<string> {
  ipCounter += 1;
  const ip = `198.51.105.${String(ipCounter % 250)}`;
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

async function userId(email: string): Promise<string> {
  const [row] = await tdb.db.execute<{ id: string }>(
    `select id from app.users where email = '${email}'`,
  );
  return String(row?.id);
}

/**
 * An order, created directly rather than through checkout.
 *
 * Deliberately not through `POST /listings/:id/buy`: that route needs Stripe configured and a
 * connected account, and this file is about what happens *after* a purchase. Reaching the
 * starting position through the shortest honest route keeps these tests about one thing.
 */
async function anOrder(paid = true): Promise<string> {
  /**
   * Through the real query helpers, on the roles that are actually allowed to do this.
   *
   * The first version inserted the rows directly on the worker pool and was refused:
   * `permission denied for table listings`. The worker has SELECT and UPDATE there and no
   * INSERT, which is right — it has no business creating listings — and the fixture was the
   * thing in the wrong.
   */
  const listing = await createListing(webPool.db, sellerId, {
    cardVariantId: variantId,
    condition: 'nm',
    priceCents: 2000,
    quantity: 1,
  });
  await setListingStatus(webPool.db, sellerId, listing.id, 'active');

  const order = await createOrder(webPool.db, buyerId, {
    sellerId,
    listingId: listing.id,
    cardVariantId: variantId,
    condition: 'nm',
    quantity: 1,
    amountCents: 2000,
    feeCents: 100,
    currency: 'USD',
  });

  if (paid) {
    // On the worker, because that is the only role that can write `paid` at all.
    await markOrderPaid(workerPool.db, {
      orderId: order.id,
      paymentIntentId: `pi_${order.id.slice(0, 8)}`,
      checkoutSessionId: `cs_${order.id.slice(0, 8)}`,
    });
  }
  return order.id;
}

/**
 * Always sends a body, even an empty one.
 *
 * Spreading the payload conditionally produced a union Fastify's `inject` overloads could not
 * resolve, and the resulting `void & Promise<Response> & Chain` swallowed the type of every
 * assertion downstream. An empty object is what a client with nothing to say sends anyway.
 */
function post(url: string, cookie: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie, origin: ORIGIN },
    payload,
  });
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

  app = await buildApp(config, { db: tdb.db, writeDb: webPool.db, auth });

  sellerCookie = await signIn('fulfil-seller@example.com');
  buyerCookie = await signIn('fulfil-buyer@example.com');
  sellerId = await userId('fulfil-seller@example.com');
  buyerId = await userId('fulfil-buyer@example.com');

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
  await tdb.db.execute(`truncate app.orders, app.listings, app.audit_log cascade`);
});

describe('the seller posting the parcel', () => {
  it('records it and hands the order back', async () => {
    const id = await anOrder();
    const shipped = await post(`/v1/orders/${id}/ship`, sellerCookie, TRACKING);

    expect(shipped.statusCode).toBe(200);
    expect(shipped.json<{ status: string; trackingNumber: string }>()).toMatchObject({
      status: 'shipped',
      trackingNumber: TRACKING.trackingNumber,
    });
  });

  it('audits the carrier and not the tracking number', async () => {
    /**
     * A tracking number identifies a parcel at somebody's address. The audit log is read by
     * people investigating something else entirely, and it does not need to know.
     */
    const id = await anOrder();
    await post(`/v1/orders/${id}/ship`, sellerCookie, TRACKING);

    const [entry] = await workerPool.db.execute<{ diff: Record<string, unknown> }>(
      `select diff from app.audit_log where action = 'order.shipped'`,
    );
    expect(entry?.diff).toEqual({ carrier: TRACKING.carrier });
    expect(JSON.stringify(entry?.diff)).not.toContain(TRACKING.trackingNumber);
  });

  it('refuses without tracking', async () => {
    const id = await anOrder();
    expect((await post(`/v1/orders/${id}/ship`, sellerCookie, {})).statusCode).toBe(400);
    expect(
      (await post(`/v1/orders/${id}/ship`, sellerCookie, { carrier: 'Royal Mail' })).statusCode,
    ).toBe(400);
  });

  it('tells a buyer they are the wrong party, rather than pretending it is missing', async () => {
    // 403, not 404: they can see this order, so "no such order" would be a lie they can check.
    const id = await anOrder();
    const attempt = await post(`/v1/orders/${id}/ship`, buyerCookie, TRACKING);

    expect(attempt.statusCode).toBe(403);
    expect(attempt.json<{ error: string; expected: string }>()).toEqual({
      error: 'wrong_party',
      expected: 'seller',
    });
  });

  it('tells a stranger nothing at all', async () => {
    const id = await anOrder();
    const stranger = await signIn('fulfil-stranger@example.com');
    expect((await post(`/v1/orders/${id}/ship`, stranger, TRACKING)).statusCode).toBe(404);
  });

  it('explains an illegal move instead of failing', async () => {
    // A 409 a client can act on — "that order has already shipped" — rather than a 500.
    const id = await anOrder();
    await post(`/v1/orders/${id}/ship`, sellerCookie, TRACKING);
    const again = await post(`/v1/orders/${id}/ship`, sellerCookie, TRACKING);

    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string; from: string; to: string }>()).toMatchObject({
      error: 'illegal_transition',
      from: 'shipped',
      to: 'shipped',
    });
  });

  it('refuses an anonymous caller', async () => {
    const id = await anOrder();
    const attempt = await app.inject({
      method: 'POST',
      url: `/v1/orders/${id}/ship`,
      payload: TRACKING,
    });
    expect(attempt.statusCode).toBe(401);
  });
});

describe('cancelling and disputing', () => {
  it('lets a buyer cancel before anything was paid', async () => {
    const id = await anOrder(false);
    const cancelled = await post(`/v1/orders/${id}/cancel`, buyerCookie, { reason: 'too slow' });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ status: string }>().status).toBe('cancelled');
  });

  it('refuses a cancellation once the money has moved', async () => {
    // An admin cancels a paid order, and the refund comes back through Stripe.
    const id = await anOrder();
    const attempt = await post(`/v1/orders/${id}/cancel`, buyerCookie, {});
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json<{ error: string }>().error).toBe('illegal_transition');
  });

  it('lets a buyer dispute a shipped order', async () => {
    const id = await anOrder();
    await post(`/v1/orders/${id}/ship`, sellerCookie, TRACKING);

    const disputed = await post(`/v1/orders/${id}/dispute`, buyerCookie, {
      reason: 'the card arrived creased',
    });
    expect(disputed.statusCode).toBe(200);
    expect(disputed.json<{ status: string }>().status).toBe('disputed');
  });

  it('refuses a seller disputing their own sale', async () => {
    const id = await anOrder();
    await post(`/v1/orders/${id}/ship`, sellerCookie, TRACKING);
    const attempt = await post(`/v1/orders/${id}/dispute`, sellerCookie, { reason: 'nope' });
    expect(attempt.statusCode).toBe(403);
  });

  it('requires a reason to dispute', async () => {
    const id = await anOrder();
    expect((await post(`/v1/orders/${id}/dispute`, buyerCookie, {})).statusCode).toBe(400);
    expect((await post(`/v1/orders/${id}/dispute`, buyerCookie, { reason: '' })).statusCode).toBe(
      400,
    );
  });

  it('keeps the dispute reason out of the audit log', async () => {
    // It lives on the order event, where the two parties and an admin resolving it can read
    // it. A second copy with a different audience and retention buys nothing.
    const id = await anOrder();
    await post(`/v1/orders/${id}/ship`, sellerCookie, TRACKING);
    await post(`/v1/orders/${id}/dispute`, buyerCookie, { reason: 'a very specific complaint' });

    const rows = await workerPool.db.execute<{ diff: unknown }>(
      `select diff from app.audit_log where action = 'order.disputed'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('a very specific complaint');
  });
});

describe('the history', () => {
  it('shows both parties what happened, in order', async () => {
    const id = await anOrder();
    await post(`/v1/orders/${id}/ship`, sellerCookie, TRACKING);

    const seen = await app.inject({
      method: 'GET',
      url: `/v1/orders/${id}/events`,
      headers: { cookie: buyerCookie },
    });
    expect(seen.statusCode).toBe(200);
    expect(
      seen.json<{ items: { toStatus: string; actor: string }[] }>().items.map((e) => e.toStatus),
    ).toEqual(['paid', 'shipped']);
  });

  it('shows a stranger an empty history rather than an error', async () => {
    // The policy filters the rows out. Nothing to see is the same answer as no such order,
    // which is the point.
    const id = await anOrder();
    const stranger = await signIn('fulfil-stranger-2@example.com');
    const seen = await app.inject({
      method: 'GET',
      url: `/v1/orders/${id}/events`,
      headers: { cookie: stranger },
    });
    expect(seen.statusCode).toBe(200);
    expect(seen.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('is never cached', async () => {
    const id = await anOrder();
    const seen = await app.inject({
      method: 'GET',
      url: `/v1/orders/${id}/events`,
      headers: { cookie: buyerCookie },
    });
    expect(seen.headers['cache-control']).toBe('no-store');
  });
});
