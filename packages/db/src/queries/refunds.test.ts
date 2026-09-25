import { IllegalTransitionError } from '@gth/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { createListing, setListingStatus } from './market.js';
import {
  cancelOrder,
  createOrder,
  getOrderById,
  getOrderByPaymentIntent,
  listOrderEvents,
  markOrderChargedBack,
  markOrderDelivered,
  markOrderPaid,
  markOrderRefunded,
  shipOrder,
} from './orders.js';
import { asUser } from './watches.js';

/**
 * Giving the money back, and what happens when a bank takes it (FR-5.5, T11).
 *
 * The rule under test is the same one `paid` obeys: **`refunded` belongs to Stripe alone.** An
 * admin can ask Stripe to refund; what moves the order is the webhook that follows. An admin
 * who could write the status directly could mark an order refunded with no money moving, and
 * the row would be indistinguishable from one where it had.
 */
let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
let workerDb: TestDatabase['db'];

const SELLER = 'refund-seller';
const BUYER = 'refund-buyer';
let variantId = '';
let counter = 0;

async function paidOrder(): Promise<{ id: string; paymentIntentId: string }> {
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
  const paymentIntentId = `pi_refund_${String(counter)}`;
  await markOrderPaid(workerDb, {
    orderId: order.id,
    paymentIntentId,
    checkoutSessionId: `cs_refund_${String(counter)}`,
  });
  return { id: order.id, paymentIntentId };
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
  await tdb.db.execute(`truncate app.orders, app.listings, app.audit_log cascade`);
});

describe('refunding', () => {
  it('moves a paid order to refunded', async () => {
    const { id } = await paidOrder();
    const result = await markOrderRefunded(workerDb, { orderId: id, reason: 'never arrived' });

    expect(result.applied).toBe(true);
    expect((await getOrderById(workerDb, id))?.status).toBe('refunded');
  });

  it('refunds an order that was already delivered', async () => {
    // A sale can go wrong after it arrives. `delivered → refunded` is in the table for exactly
    // this, and so is `completed → refunded`.
    const { id } = await paidOrder();
    await shipOrder(web, SELLER, id, { carrier: 'RM', trackingNumber: 'AB1' });
    await markOrderDelivered(workerDb, id, { actor: 'admin', actorId: SELLER });

    expect((await markOrderRefunded(workerDb, { orderId: id })).applied).toBe(true);
  });

  it('is a no-op the second time', async () => {
    // Stripe sends `charge.refunded` per refund, and a partly refunded charge later refunded
    // in full sends it twice.
    const { id } = await paidOrder();
    await markOrderRefunded(workerDb, { orderId: id });

    expect((await markOrderRefunded(workerDb, { orderId: id })).applied).toBe(false);
    expect(await listOrderEvents(web, BUYER, id)).toHaveLength(2); // paid, refunded
  });

  it('refuses to refund an order nobody paid for', async () => {
    // `created → refunded` is not a move for anyone. Cancelling is the thing to do with an
    // unpaid order, and it is a different transition.
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

    await expect(markOrderRefunded(workerDb, { orderId: order.id })).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it('records Stripe as the actor, not a person', async () => {
    const { id } = await paidOrder();
    await markOrderRefunded(workerDb, { orderId: id, reason: 'refunded by Stripe' });

    const last = (await listOrderEvents(web, BUYER, id)).at(-1);
    // `order_events_actor_identified` refuses to let a machine claim to be a person.
    expect(last).toMatchObject({ toStatus: 'refunded', actor: 'stripe', actorId: null });
  });

  it('shrugs at a payment intent we have never seen', async () => {
    expect(await getOrderByPaymentIntent(workerDb, 'pi_not_ours')).toBeNull();
  });
});

describe('what a session can do about a refund', () => {
  it('nothing: it cannot write the status', async () => {
    /**
     * The control, stated as an assertion. Migration 0041's policy permits four statuses on
     * this role and `refunded` is not among them — so an admin console compromised tomorrow
     * still cannot mark an order refunded without money moving.
     */
    const { id } = await paidOrder();
    await expectDbError(
      asUser(web, BUYER, async (tx) =>
        tx.execute(`update app.orders set status = 'refunded' where id = '${id}'`),
      ),
      /row-level security|permission denied/i,
    );
  });

  it('and the seller cannot either', async () => {
    const { id } = await paidOrder();
    await expectDbError(
      asUser(web, SELLER, async (tx) =>
        tx.execute(`update app.orders set status = 'refunded' where id = '${id}'`),
      ),
      /row-level security|permission denied/i,
    );
  });
});

describe('a chargeback', () => {
  it('moves the order to disputed, not refunded', async () => {
    /**
     * Nothing has been decided. The bank will take weeks and the money may come back, so the
     * order goes to `disputed` — which is where an admin can see it and respond with evidence.
     */
    const { id, paymentIntentId } = await paidOrder();
    const result = await markOrderChargedBack(workerDb, {
      paymentIntentId,
      reason: 'chargeback:product_not_received',
    });

    expect(result.applied).toBe(true);
    expect((await getOrderById(workerDb, id))?.status).toBe('disputed');
  });

  it('reaches an order that was already completed', async () => {
    // The dispute window outlives completion, and a chargeback arrives whenever it arrives.
    // `completed → disputed` lists `stripe` among its actors precisely for this.
    const { id, paymentIntentId } = await paidOrder();
    await shipOrder(web, SELLER, id, { carrier: 'RM', trackingNumber: 'AB2' });
    await markOrderDelivered(workerDb, id, { actor: 'admin', actorId: SELLER });
    await workerDb.execute(`update app.orders set status = 'completed' where id = '${id}'`);

    expect((await markOrderChargedBack(workerDb, { paymentIntentId })).applied).toBe(true);
  });

  it('does not fight a dispute the buyer already opened here', async () => {
    // A buyer who complained to us and then went to their bank anyway is the common case, not
    // a contradiction.
    const { id, paymentIntentId } = await paidOrder();
    await workerDb.execute(`update app.orders set status = 'disputed' where id = '${id}'`);

    expect((await markOrderChargedBack(workerDb, { paymentIntentId })).applied).toBe(false);
  });

  it('shrugs at a payment we have no order for', async () => {
    expect((await markOrderChargedBack(workerDb, { paymentIntentId: 'pi_ghost' })).applied).toBe(
      false,
    );
  });

  it('cannot reach an order that was cancelled before payment', async () => {
    const { id, paymentIntentId } = await paidOrder();
    // Force it somewhere terminal the machine cannot leave.
    await workerDb.execute(`update app.orders set status = 'refunded' where id = '${id}'`);
    expect((await markOrderChargedBack(workerDb, { paymentIntentId })).applied).toBe(false);
  });
});

describe('finding an order without a viewer', () => {
  it('works on the worker, which has no user to declare', async () => {
    const { id } = await paidOrder();
    expect((await getOrderById(workerDb, id))?.id).toBe(id);
  });

  it('finds nothing on a session pool, which is the safe way to be wrong', async () => {
    /**
     * `orders` FORCEs row-level security, so a connection that has not said who it is matches
     * no rows. Wiring this helper to the web pool by mistake does not quietly widen what a
     * session can see — it returns nothing at all.
     */
    const { id } = await paidOrder();
    expect(await getOrderById(web, id)).toBeNull();
  });
});

describe('cancelling is not refunding', () => {
  it('leaves a cancelled order out of the refund path entirely', async () => {
    // `moneyHasMoved()` in @gth/core exists for this distinction: cancelling an unpaid order
    // is bookkeeping, and cancelling a paid one owes somebody their money back.
    counter += 1;
    const listing = await createListing(web, SELLER, {
      cardVariantId: variantId,
      condition: 'nm',
      priceCents: 1500,
      quantity: 1,
    });
    await setListingStatus(web, SELLER, listing.id, 'active');
    const order = await createOrder(web, BUYER, {
      sellerId: SELLER,
      listingId: listing.id,
      cardVariantId: variantId,
      condition: 'nm',
      quantity: 1,
      amountCents: 1500,
      feeCents: 75,
      currency: 'USD',
    });
    await cancelOrder(web, BUYER, order.id, 'changed my mind');

    const cancelled = await getOrderById(workerDb, order.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.stripePaymentIntentId, 'a cancelled order was charged').toBeNull();
  });
});
