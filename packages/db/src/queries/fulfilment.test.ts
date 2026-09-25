import { AUTO_COMPLETE_AFTER_DAYS, IllegalTransitionError } from '@gth/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { completeDeliveredJob } from '../jobs.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { createListing, setListingStatus } from './market.js';
import {
  OrderNotFoundError,
  WrongPartyError,
  cancelOrder,
  completeOrder,
  createOrder,
  disputeOrder,
  getOrder,
  listOrderEvents,
  markOrderDelivered,
  markOrderPaid,
  ordersReadyToComplete,
  shipOrder,
} from './orders.js';
import { asUser } from './watches.js';

/**
 * What happens to an order after the money moves (FR-5.4, FR-5.6, AC-5.4).
 *
 * The state machine is proved exhaustively in `@gth/core` with no database at all. What this
 * file asks is the other half: that the code driving it declares the right actor, that the
 * database refuses the transitions the state machine refuses **and** the ones it has no
 * opinion about, and that neither party can finish their own sale.
 *
 * As everywhere in Phase 5, the attempts that matter are raw SQL on the web pool with a user
 * declared — no helper, nothing of ours in the way. What refuses them is Postgres.
 */
let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
let workerDb: TestDatabase['db'];

const SELLER = 'ship-seller';
const BUYER = 'ship-buyer';
const STRANGER = 'ship-stranger';
let variantId = '';

const TRACKING = { carrier: 'Royal Mail', trackingNumber: 'AB123456789GB' };

async function newOrder(): Promise<string> {
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
  return order.id;
}

/** An order that has been paid for, which is where most of this file starts. */
async function paidOrder(): Promise<string> {
  const id = await newOrder();
  await markOrderPaid(workerDb, {
    orderId: id,
    paymentIntentId: `pi_${id.slice(0, 8)}`,
    checkoutSessionId: `cs_${id.slice(0, 8)}`,
  });
  return id;
}

async function shippedOrder(): Promise<string> {
  const id = await paidOrder();
  await shipOrder(web, SELLER, id, TRACKING);
  return id;
}

async function deliveredOrder(): Promise<string> {
  const id = await shippedOrder();
  await markOrderDelivered(workerDb, id, { actor: 'admin', actorId: 'admin-1' });
  return id;
}

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

  for (const id of [SELLER, BUYER, STRANGER, 'admin-1']) {
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

describe('the seller posting the parcel', () => {
  it('records the tracking and when it went', async () => {
    const id = await paidOrder();
    const order = await shipOrder(web, SELLER, id, TRACKING);

    expect(order.status).toBe('shipped');
    expect(order.trackingCarrier).toBe(TRACKING.carrier);
    expect(order.trackingNumber).toBe(TRACKING.trackingNumber);
    expect(order.shippedAt).not.toBeNull();
  });

  it('refuses a buyer pretending to be the seller', async () => {
    /**
     * Row-level security lets **either** party update the row, because both of them can see
     * it. "You are a party to this" and "you are the party who may do this" are different
     * questions, and only the first has a policy.
     */
    const id = await paidOrder();
    await expect(shipOrder(web, BUYER, id, TRACKING)).rejects.toThrow(WrongPartyError);
  });

  it('refuses a stranger, who cannot see the order at all', async () => {
    const id = await paidOrder();
    await expect(shipOrder(web, STRANGER, id, TRACKING)).rejects.toThrow(OrderNotFoundError);
  });

  it('refuses to ship an order nobody has paid for', async () => {
    // `created → shipped` is not a move for anyone. Posting a card before being paid is the
    // seller's own business, but it is not a thing this system will record.
    const id = await newOrder();
    await expect(shipOrder(web, SELLER, id, TRACKING)).rejects.toThrow(IllegalTransitionError);
  });

  it('refuses to ship twice', async () => {
    const id = await shippedOrder();
    // The second call finds `shipped`, and `shipped → shipped` is not in the table.
    await expect(shipOrder(web, SELLER, id, TRACKING)).rejects.toThrow(IllegalTransitionError);
  });

  it('cannot be shipped without tracking, whatever the code does', async () => {
    /**
     * The database's own version of "posted means posted". Tracking is required for every
     * shipped order, not only above a threshold — an untracked parcel is a dispute with no
     * evidence in it, and the person who loses that argument is the seller.
     */
    const id = await paidOrder();
    await expectDbError(
      asWeb(SELLER, `update app.orders set status = 'shipped' where id = '${id}'`),
      /orders_shipped_has_tracking/,
    );
  });
});

describe('cancelling', () => {
  it('lets either side walk away before anything was paid', async () => {
    const id = await newOrder();
    const order = await cancelOrder(web, BUYER, id, 'changed my mind');
    expect(order.status).toBe('cancelled');
  });

  it('lets the seller walk away too', async () => {
    const id = await newOrder();
    expect((await cancelOrder(web, SELLER, id)).status).toBe('cancelled');
  });

  it('refuses once the money has moved', async () => {
    // `paid → cancelled` is an admin's move only, and the refund has to come back through
    // Stripe rather than through a status change.
    const id = await paidOrder();
    await expect(cancelOrder(web, BUYER, id)).rejects.toThrow(IllegalTransitionError);
  });

  it('names the party who actually did it', async () => {
    // The actor is derived from the order, not taken from the caller: there is no field in
    // which a buyer could claim to be cancelling as the seller.
    const id = await newOrder();
    await cancelOrder(web, SELLER, id);
    const [event] = await listOrderEvents(web, SELLER, id);
    expect(event).toMatchObject({ actor: 'seller', actorId: SELLER, toStatus: 'cancelled' });
  });
});

describe('disputing', () => {
  it('is the buyer’s to open', async () => {
    const id = await shippedOrder();
    const order = await disputeOrder(web, BUYER, id, 'the card arrived creased');
    expect(order.status).toBe('disputed');
  });

  it('is not the seller’s', async () => {
    // A seller disputing their own sale is not a thing. They can see the order, so this is a
    // refusal rather than a pretence that it does not exist.
    const id = await shippedOrder();
    await expect(disputeOrder(web, SELLER, id, 'I changed my mind')).rejects.toThrow(
      WrongPartyError,
    );
  });

  it('keeps the reason where both parties can read it', async () => {
    const id = await shippedOrder();
    await disputeOrder(web, BUYER, id, 'the card arrived creased');

    const events = await listOrderEvents(web, SELLER, id);
    expect(events.at(-1)?.reason).toBe('the card arrived creased');
  });
});

describe('the two transitions neither party may make', () => {
  it('refuses a seller marking their own sale delivered', async () => {
    /**
     * AC-5.4's shape, one step earlier than `completed`. `delivered` starts the clock that
     * releases the payout, so the seller does not get to start it. The policy from migration
     * 0041 does not list `delivered` among the statuses a session may write at all.
     */
    const id = await shippedOrder();
    await expectDbError(
      asWeb(SELLER, `update app.orders set status = 'delivered' where id = '${id}'`),
      /row-level security|permission denied/i,
    );
  });

  it('refuses a buyer marking an order completed', async () => {
    const id = await deliveredOrder();
    await expectDbError(
      asWeb(BUYER, `update app.orders set status = 'completed' where id = '${id}'`),
      /row-level security|permission denied/i,
    );
  });

  it('refuses a seller writing the delivery date, even without the status', async () => {
    // The column is outside the web role's UPDATE grant (migration 0043), so a seller cannot
    // set the clock going by the back door either.
    const id = await shippedOrder();
    await expectDbError(
      asWeb(SELLER, `update app.orders set delivered_at = now() where id = '${id}'`),
      /permission denied/i,
    );
  });

  it('lets an admin confirm delivery, on the worker role', async () => {
    const id = await shippedOrder();
    const order = await markOrderDelivered(workerDb, id, {
      actor: 'admin',
      actorId: 'admin-1',
      reason: 'carrier confirmed',
    });
    expect(order.status).toBe('delivered');
    expect(order.deliveredAt).not.toBeNull();
  });

  it('lets an admin complete a delivered order', async () => {
    const id = await deliveredOrder();
    const order = await completeOrder(workerDb, id, {
      actor: 'admin',
      actorId: 'admin-1',
      reason: 'dispute window closed early by agreement',
    });
    expect(order.status).toBe('completed');
    expect(order.completedAt).not.toBeNull();
  });

  it('refuses an admin a move that is not a move', async () => {
    // Powerful, not exempt. There is no path from `cancelled` to `delivered` for anybody.
    const id = await newOrder();
    await cancelOrder(web, BUYER, id);
    await expect(
      markOrderDelivered(workerDb, id, { actor: 'admin', actorId: 'admin-1' }),
    ).rejects.toThrow(IllegalTransitionError);
  });
});

describe('the clock', () => {
  it('ignores an order that has only just arrived', async () => {
    await deliveredOrder();
    expect(await ordersReadyToComplete(workerDb)).toHaveLength(0);
  });

  it('picks one up once the hold window has passed', async () => {
    const id = await deliveredOrder();
    // Counted from delivery rather than from payment: a parcel that took three weeks should
    // not arrive with its dispute window already spent.
    await workerDb.execute(
      `update app.orders set delivered_at = now() - interval '${String(AUTO_COMPLETE_AFTER_DAYS + 1)} days' where id = '${id}'`,
    );
    expect((await ordersReadyToComplete(workerDb)).map((o) => o.id)).toEqual([id]);
  });

  it('completes it as the system, which is not a person', async () => {
    const id = await deliveredOrder();
    await workerDb.execute(
      `update app.orders set delivered_at = now() - interval '30 days' where id = '${id}'`,
    );

    const lines = await completeDeliveredJob(workerDb);
    expect(lines.join(' ')).toContain('completed 1');

    expect((await getOrder(web, BUYER, id))?.status).toBe('completed');
    const events = await listOrderEvents(web, BUYER, id);
    // `order_events_actor_identified` refuses to let a machine claim to be a person.
    expect(events.at(-1)).toMatchObject({ actor: 'system', actorId: null, toStatus: 'completed' });
  });

  it('says so when there is nothing to do', async () => {
    expect((await completeDeliveredJob(workerDb)).join(' ')).toContain('no delivered orders');
  });

  it('leaves a disputed order alone and completes the rest', async () => {
    /**
     * A buyer who has complained is not waiting on a clock. The dispute takes the order out of
     * `delivered`, so it is never listed — and the order beside it still completes, because a
     * job that stops at the first awkward row is a job that quietly stops paying sellers.
     *
     * The `try`/`catch` inside the job covers the narrower race this test cannot stage: an
     * order that *is* `delivered` when listed and has moved by the time it is completed, a
     * few milliseconds later. That window is real and the handling is deliberate; staging it
     * deterministically would need a hook in the job whose only caller would be this test.
     */
    const disputed = await deliveredOrder();
    const fine = await deliveredOrder();
    await workerDb.execute(
      `update app.orders set delivered_at = now() - interval '30 days'
        where id in ('${disputed}', '${fine}')`,
    );
    await disputeOrder(web, BUYER, disputed, 'never arrived');

    const lines = (await completeDeliveredJob(workerDb)).join(' ');
    expect(lines).toContain('completed 1 of 1');
    expect((await getOrder(web, BUYER, fine))?.status).toBe('completed');
    expect((await getOrder(web, BUYER, disputed))?.status).toBe('disputed');
  });
});

describe('the history', () => {
  it('records every step, in order, with who did it', async () => {
    const id = await deliveredOrder();
    const events = await listOrderEvents(web, BUYER, id);

    expect(events.map((e) => `${e.fromStatus}->${e.toStatus}:${e.actor}`)).toEqual([
      'created->paid:stripe',
      'paid->shipped:seller',
      'shipped->delivered:admin',
    ]);
  });

  it('is visible to both parties and nobody else', async () => {
    const id = await shippedOrder();
    expect(await listOrderEvents(web, BUYER, id)).toHaveLength(2);
    expect(await listOrderEvents(web, SELLER, id)).toHaveLength(2);
    // The subquery reads `orders`, which has its own policies — so this cannot be used to look
    // at somebody else's history sideways.
    expect(await listOrderEvents(web, STRANGER, id)).toHaveLength(0);
  });

  it('cannot be rewritten afterwards, by anybody', async () => {
    const id = await shippedOrder();
    for (const [role, db] of [
      ['web', web],
      ['worker', workerDb],
    ] as const) {
      await expectDbError(
        role === 'web'
          ? asWeb(SELLER, `update app.order_events set actor = 'admin' where order_id = '${id}'`)
          : db.execute(`update app.order_events set actor = 'admin' where order_id = '${id}'`),
        /permission denied/i,
      );
    }
  });
});
