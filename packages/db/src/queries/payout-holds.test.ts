import { HOLD_RELEASE_AFTER_ORDERS, canReleaseHold } from '@gth/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { createListing, setListingStatus } from './market.js';
import {
  completeOrder,
  createOrder,
  markOrderDelivered,
  markOrderPaid,
  shipOrder,
} from './orders.js';
import { heldSellers, holdSellerPayouts, releaseSellerPayouts } from './sellers.js';
import { asUser } from './watches.js';

/**
 * Holding a new seller's money (FR-5.6).
 *
 * This closes what the Phase 5 security review named as the largest open risk: with a
 * destination charge Stripe transfers at payment, so without a hold a seller is paid before the
 * buyer has any chance to complain — the empty-envelope trade.
 *
 * What is under test here is the counting. The decision is a pure function with its own tests;
 * what this file asks is whether the numbers fed to it are the right numbers, and whether a
 * session can touch them.
 */
let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
let workerDb: TestDatabase['db'];

const SELLER = 'hold-seller';
const BUYER = 'hold-buyer';
/** `acct_` then alphanumerics, which is what `seller_accounts_stripe_id_format` wants. */
const ACCOUNT = 'acct_holdseller';
let variantId = '';
let counter = 0;

/** A sale carried to a chosen status, so the counting can be checked against each one. */
async function orderAt(status: 'paid' | 'completed' | 'refunded'): Promise<string> {
  counter += 1;
  const listing = await createListing(web, SELLER, {
    cardVariantId: variantId,
    condition: 'nm',
    priceCents: 2000,
    quantity: 1,
  });
  await setListingStatus(web, SELLER, listing.id, 'active');
  const order = await createOrder(web, BUYER, {
    sellerId: SELLER,
    listingId: listing.id,
    cardVariantId: variantId,
    condition: 'nm',
    quantity: 1,
    amountCents: 2000,
    feeCents: 100,
    currency: 'USD',
  });
  await markOrderPaid(workerDb, {
    orderId: order.id,
    paymentIntentId: `pi_hold_${String(counter)}`,
    checkoutSessionId: `cs_hold_${String(counter)}`,
  });
  if (status === 'paid') return order.id;

  if (status === 'refunded') {
    await workerDb.execute(`update app.orders set status = 'refunded' where id = '${order.id}'`);
    return order.id;
  }

  await shipOrder(web, SELLER, order.id, {
    carrier: 'RM',
    trackingNumber: `TH${String(counter)}`,
  });
  await markOrderDelivered(workerDb, order.id, { actor: 'system' });
  await completeOrder(workerDb, order.id, { actor: 'system' });
  return order.id;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  web = webPool.db;
  workerDb = workerPool.db;

  for (const id of [SELLER, BUYER]) {
    await tdb.db.execute(
      `insert into app.users (id, name, email) values ('${id}', '${id}', '${id}@example.invalid')`,
    );
  }
  const [variant] = await tdb.db.execute<{ id: string }>(
    `select id from app.card_variants limit 1`,
  );
  variantId = String(variant?.id);
}, 180_000);

afterAll(async () => {
  await webPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(
    `truncate app.orders, app.listings, app.seller_accounts, app.audit_log cascade`,
  );
  await workerPool.db.execute(
    `insert into app.seller_accounts (user_id, stripe_account_id) values ('${SELLER}', '${ACCOUNT}')`,
  );
});

describe('who is on hold', () => {
  it('lists nobody when nobody is held', async () => {
    // A seller with no `hold_until` is not held, which is how an account created before this
    // feature existed behaves: it is not swept up retroactively.
    expect(await heldSellers(workerDb)).toHaveLength(0);
  });

  it('lists a held seller with nothing sold yet', async () => {
    await holdSellerPayouts(workerDb, ACCOUNT, new Date());

    const [held] = await heldSellers(workerDb);
    expect(held).toMatchObject({ stripeAccountId: ACCOUNT, completedOrders: 0 });
    expect(held?.firstCompletedAt).toBeNull();
    // And the pure rule refuses them, for the reason a seller can act on.
    expect(canReleaseHold({ completedOrders: 0, firstCompletedAt: null })).toEqual({
      release: false,
      reason: 'no_completed_orders',
    });
  });

  it('counts completed orders and remembers the first', async () => {
    await holdSellerPayouts(workerDb, ACCOUNT, new Date());
    await orderAt('completed');
    await orderAt('completed');

    const [held] = await heldSellers(workerDb);
    expect(held?.completedOrders).toBe(2);
    expect(held?.firstCompletedAt).toBeInstanceOf(Date);
  });

  it('does not count a sale that was only paid for', async () => {
    /**
     * A completed order is the unit because it means a real buyer received a real card and did
     * not complain within the window. A paid one means nothing of the sort — it is the state a
     * fraudulent sale sits in.
     */
    await holdSellerPayouts(workerDb, ACCOUNT, new Date());
    await orderAt('paid');

    expect((await heldSellers(workerDb))[0]?.completedOrders).toBe(0);
  });

  it('does not count a refunded order', async () => {
    // The opposite of the evidence this is looking for.
    await holdSellerPayouts(workerDb, ACCOUNT, new Date());
    await orderAt('refunded');

    expect((await heldSellers(workerDb))[0]?.completedOrders).toBe(0);
  });

  it('drops a seller off the list once released', async () => {
    await holdSellerPayouts(workerDb, ACCOUNT, new Date());
    expect(await heldSellers(workerDb)).toHaveLength(1);

    await releaseSellerPayouts(workerDb, ACCOUNT);
    expect(await heldSellers(workerDb)).toHaveLength(0);
  });
});

describe('the counting feeds the rule', () => {
  it('releases a seller with enough completed orders, long enough ago', async () => {
    await holdSellerPayouts(workerDb, ACCOUNT, new Date());
    for (let i = 0; i < HOLD_RELEASE_AFTER_ORDERS; i += 1) await orderAt('completed');
    // Age them, since a test cannot wait a week.
    await workerDb.execute(
      `update app.orders set completed_at = now() - interval '30 days' where status = 'completed'`,
    );

    const [held] = await heldSellers(workerDb);
    expect(held).toBeDefined();
    if (held) expect(canReleaseHold(held)).toEqual({ release: true });
  });

  it('holds one whose sales are all from this morning', async () => {
    await holdSellerPayouts(workerDb, ACCOUNT, new Date());
    for (let i = 0; i < HOLD_RELEASE_AFTER_ORDERS; i += 1) await orderAt('completed');

    const [held] = await heldSellers(workerDb);
    if (held) expect(canReleaseHold(held)).toEqual({ release: false, reason: 'too_soon' });
  });
});

describe('what a session can do about its own hold', () => {
  it('nothing: the column is outside its grant', async () => {
    /**
     * The control. A seller who could clear their own `hold_until` could pay themselves early,
     * which is the entire thing this feature exists to prevent — and it would be the most
     * obviously worthwhile row in the database to be able to write.
     */
    await holdSellerPayouts(workerDb, ACCOUNT, new Date());
    await expectDbError(
      asUser(web, SELLER, async (tx) =>
        tx.execute(`update app.seller_accounts set hold_until = null where user_id = '${SELLER}'`),
      ),
      /permission denied/i,
    );
  });

  it('and cannot set one on somebody else either', async () => {
    await expectDbError(
      asUser(web, BUYER, async (tx) =>
        tx.execute(`update app.seller_accounts set hold_until = now() where user_id = '${SELLER}'`),
      ),
      /permission denied/i,
    );
  });

  it('can still see that it is held, which is not a secret', async () => {
    // A seller is entitled to know their payouts are held and roughly why. The policy lets them
    // read their own row; it is writing it that they cannot do.
    const until = new Date();
    await holdSellerPayouts(workerDb, ACCOUNT, until);

    const rows = await asUser(web, SELLER, async (tx) =>
      tx.execute<{ hold_until: string | null }>(
        `select hold_until from app.seller_accounts where user_id = '${SELLER}'`,
      ),
    );
    expect(rows[0]?.hold_until).not.toBeNull();
  });
});
