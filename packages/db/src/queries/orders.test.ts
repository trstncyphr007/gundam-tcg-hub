import { IllegalTransitionError } from '@gth/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { createListing, setListingStatus } from './market.js';
import {
  ListingUnavailableError,
  attachCheckoutSession,
  createOrder,
  getOrder,
  markOrderPaid,
} from './orders.js';
import { asUser } from './watches.js';

/**
 * Buying (FR-5.3, FR-5.4, AC-5.4).
 *
 * The question this file asks is not "does the buy route refuse that" — a route can be changed
 * in an afternoon. It is **what can a session do to an order if it gets past every line of our
 * code**, which is the only version of the question that survives a bug in the layer above.
 *
 * So the writes below are raw SQL on the `app_web` pool with the buyer's identity declared:
 * no query helper, no validation, nothing of ours in the way. What refuses them is Postgres.
 */
let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
let workerDb: TestDatabase['db'];

const SELLER = 'order-seller';
const BUYER = 'order-buyer';
const RIVAL = 'order-rival';
const STRANGER = 'order-stranger';
let variantId = '';

/** A listing on sale, which is the only kind that can be bought. */
async function activeListing(priceCents = 2000): Promise<string> {
  const listing = await createListing(web, SELLER, {
    cardVariantId: variantId,
    condition: 'nm',
    priceCents,
    quantity: 1,
  });
  await setListingStatus(web, SELLER, listing.id, 'active');
  return listing.id;
}

async function openOrder(buyerId = BUYER, listingId?: string) {
  const id = listingId ?? (await activeListing());
  return createOrder(web, buyerId, {
    sellerId: SELLER,
    listingId: id,
    cardVariantId: variantId,
    condition: 'nm',
    quantity: 1,
    amountCents: 2000,
    feeCents: 100,
    currency: 'USD',
  });
}

/** A statement run on the web pool as this user, with nothing of ours between it and Postgres. */
async function asWeb(userId: string, statement: string): Promise<unknown> {
  return asUser(web, userId, async (tx) => tx.execute(statement));
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  web = webPool.db;
  workerDb = workerPool.db;

  for (const id of [SELLER, BUYER, RIVAL, STRANGER]) {
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
  // TRUNCATE rather than DELETE: these tables FORCE row-level security, and a DELETE from the
  // owner matches nothing at all — silently. That cost an afternoon once already.
  await tdb.db.execute(`truncate app.orders, app.listings, app.audit_log cascade`);
});

describe('opening an order', () => {
  it('starts as created, with what was bought copied onto it', async () => {
    const order = await openOrder();

    expect(order.status).toBe('created');
    expect(order.buyerId).toBe(BUYER);
    expect(order.sellerId).toBe(SELLER);
    expect(order.amountCents).toBe(2000);
    expect(order.feeCents).toBe(100);
    // Nothing about a payment yet, because nothing has been paid.
    expect(order.stripePaymentIntentId).toBeNull();
    expect(order.paidAt).toBeNull();
  });

  it('is visible to both parties and to nobody else', async () => {
    const order = await openOrder();

    expect(await getOrder(web, BUYER, order.id)).not.toBeNull();
    expect(await getOrder(web, SELLER, order.id)).not.toBeNull();
    // Not "forbidden" — invisible. A stranger cannot tell the order exists at all, which is
    // the same answer they would get for an id that never existed (SR-3.3).
    expect(await getOrder(web, STRANGER, order.id)).toBeNull();
  });

  it('refuses to let anybody buy their own card', async () => {
    // Wash trading is how a marketplace's numbers stop meaning anything. The CHECK
    // `orders_not_self_dealing` is one line and does not care what the route forgot.
    const listingId = await activeListing();
    await expectDbError(openOrder(SELLER, listingId), /orders_not_self_dealing/);
  });

  it('lets only one buyer have an open order on a listing at a time', async () => {
    // The marketplace's most obvious race: two buyers open the same listing, both pay, and one
    // card owes two people. `orders_one_open_per_listing` is enforced below row-level security,
    // so it sees the rival's order even though the rival cannot.
    const listingId = await activeListing();
    await openOrder(BUYER, listingId);

    await expect(openOrder(RIVAL, listingId)).rejects.toThrow(ListingUnavailableError);
  });

  it('frees the listing again when the first order is cancelled', async () => {
    // A held listing that is never released is an abandoned checkout taking a card off the
    // market forever. `cancelled` is outside the index's predicate precisely so it does not.
    const listingId = await activeListing();
    const first = await openOrder(BUYER, listingId);
    await asWeb(BUYER, `update app.orders set status = 'cancelled' where id = '${first.id}'`);

    const second = await openOrder(RIVAL, listingId);
    expect(second.status).toBe('created');
  });
});

describe('what a buyer can do to their own order', () => {
  it('cannot change the price', async () => {
    // AC-5.4, and the reason migration 0043 exists. The RLS policy constrains the status and
    // the parties and says nothing about `amount_cents`; the column grant is what refuses this.
    const order = await openOrder();
    await expectDbError(
      asWeb(BUYER, `update app.orders set amount_cents = 1 where id = '${order.id}'`),
      /permission denied/i,
    );
  });

  it('cannot change what we keep', async () => {
    const order = await openOrder();
    await expectDbError(
      asWeb(BUYER, `update app.orders set fee_cents = 0 where id = '${order.id}'`),
      /permission denied/i,
    );
  });

  it('cannot claim a payment', async () => {
    // A payment intent is Stripe's fact about money. Inventing one here would satisfy the
    // `orders_paid_has_payment` CHECK and make a fabricated `paid` row look well-formed.
    const order = await openOrder();
    await expectDbError(
      asWeb(
        BUYER,
        `update app.orders set stripe_payment_intent_id = 'pi_x' where id = '${order.id}'`,
      ),
      /permission denied/i,
    );
  });

  it('cannot mark it paid', async () => {
    // Two locks, and this test would pass on either alone. The policy's WITH CHECK does not
    // list `paid`, and the column grant does not include the payment columns it would need.
    const order = await openOrder();
    await expectDbError(
      asWeb(BUYER, `update app.orders set status = 'paid' where id = '${order.id}'`),
      /row-level security|permission denied/i,
    );
  });

  it('cannot mark it completed, which is what releases the payout', async () => {
    // AC-5.4's other half. Neither party moves their own money.
    const order = await openOrder();
    await expectDbError(
      asWeb(BUYER, `update app.orders set status = 'completed' where id = '${order.id}'`),
      /row-level security|permission denied/i,
    );
  });

  it('cannot delete it', async () => {
    // An order is a financial record. It ends in a terminal status, not in nothing, and no
    // role has DELETE on this table at all.
    const order = await openOrder();
    await expectDbError(
      asWeb(BUYER, `delete from app.orders where id = '${order.id}'`),
      /permission denied/i,
    );
  });

  it('can attach the Checkout session, which is the one thing the buy route needs', async () => {
    const order = await openOrder();
    await attachCheckoutSession(web, BUYER, order.id, 'cs_test_123');

    const after = await getOrder(web, BUYER, order.id);
    expect(after?.stripeCheckoutId).toBe('cs_test_123');
  });
});

describe('what a stranger can do to somebody else’s order', () => {
  it('not even find it to change it', async () => {
    const order = await openOrder();
    // No error: the UPDATE runs and matches nothing, because the policy filtered the row out
    // before the update was considered. Silence is the right answer — an error would confirm
    // the order exists.
    await asWeb(STRANGER, `update app.orders set status = 'cancelled' where id = '${order.id}'`);

    const after = await getOrder(web, BUYER, order.id);
    expect(after?.status).toBe('created');
  });
});

describe('a payment, on the role a webhook runs as', () => {
  it('moves the order to paid and sells the listing', async () => {
    const listingId = await activeListing();
    const order = await openOrder(BUYER, listingId);

    const result = await markOrderPaid(workerDb, {
      orderId: order.id,
      paymentIntentId: 'pi_paid_1',
      checkoutSessionId: 'cs_paid_1',
      taxCents: 0,
    });

    expect(result.applied).toBe(true);
    const after = await getOrder(web, BUYER, order.id);
    expect(after?.status).toBe('paid');
    expect(after?.stripePaymentIntentId).toBe('pi_paid_1');
    expect(after?.paidAt).not.toBeNull();

    const [listing] = await workerDb.execute<{ status: string }>(
      `select status from app.listings where id = '${listingId}'`,
    );
    expect(listing?.status).toBe('sold');
  });

  it('records the transition in a table nobody can edit afterwards', async () => {
    const order = await openOrder();
    await markOrderPaid(workerDb, {
      orderId: order.id,
      paymentIntentId: 'pi_paid_2',
      checkoutSessionId: 'cs_paid_2',
    });

    const [event] = await workerDb.execute<{
      from_status: string;
      to_status: string;
      actor: string;
      actor_id: string | null;
    }>(`select from_status, to_status, actor, actor_id from app.order_events
          where order_id = '${order.id}'`);
    expect(event).toMatchObject({ from_status: 'created', to_status: 'paid', actor: 'stripe' });
    // `stripe` is not a person, and the CHECK refuses to let it pretend to be one.
    expect(event?.actor_id).toBeNull();

    // Not even the worker that wrote it can change its mind. A history the application can
    // rewrite is not evidence (SR-4.1's reasoning, applied to money).
    await expectDbError(
      workerDb.execute(
        `update app.order_events set actor = 'admin' where order_id = '${order.id}'`,
      ),
      /permission denied/i,
    );
  });

  it('is a no-op the second time', async () => {
    // A retried webhook that got past the idempotency claim — a redelivery after a restart,
    // say. Charging once and shipping twice is the failure this prevents.
    const order = await openOrder();
    const input = {
      orderId: order.id,
      paymentIntentId: 'pi_paid_3',
      checkoutSessionId: 'cs_paid_3',
    };
    await markOrderPaid(workerDb, input);
    const again = await markOrderPaid(workerDb, input);

    expect(again).toEqual({ applied: false, reason: 'already_paid' });
    const events = await workerDb.execute(
      `select id from app.order_events where order_id = '${order.id}'`,
    );
    expect(events, 'the second delivery wrote a second transition').toHaveLength(1);
  });

  it('says so when the metadata names an order we do not have', async () => {
    const result = await markOrderPaid(workerDb, {
      orderId: '00000000-0000-4000-8000-000000000000',
      paymentIntentId: 'pi_ghost',
      checkoutSessionId: 'cs_ghost',
    });
    expect(result).toEqual({ applied: false, reason: 'unknown_order' });
  });

  it('refuses a payment for an order that was cancelled', async () => {
    // The state machine, not the database, catches this one: `cancelled` is terminal, so
    // there is no move to `paid` for anybody to make. It is a real anomaly — money moved for
    // something nobody should have been able to pay for — and it throws rather than
    // pretending, so the caller can record it.
    const order = await openOrder();
    await asWeb(BUYER, `update app.orders set status = 'cancelled' where id = '${order.id}'`);

    await expect(
      markOrderPaid(workerDb, {
        orderId: order.id,
        paymentIntentId: 'pi_late',
        checkoutSessionId: 'cs_late',
      }),
    ).rejects.toThrow(IllegalTransitionError);
  });

  it('finds nothing to pay when it is called on a session pool', async () => {
    /**
     * Not an error — something better.
     *
     * `orders` FORCEs row-level security, and this pool has not declared a user, so the row is
     * filtered out before the update is even considered and the order reports as absent. Wiring
     * this function to the web pool by mistake would not quietly mark orders paid on the wrong
     * role; it would visibly fail to find any of them.
     *
     * The refusal of the write itself is proved above, where the buyer *is* declared and the
     * update is refused outright.
     */
    const order = await openOrder();
    const result = await markOrderPaid(web, {
      orderId: order.id,
      paymentIntentId: 'pi_web',
      checkoutSessionId: 'cs_web',
    });
    expect(result).toEqual({ applied: false, reason: 'unknown_order' });
  });
});
