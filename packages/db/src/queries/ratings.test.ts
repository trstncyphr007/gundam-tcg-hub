import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { browseListingsForCard, createListing, setListingStatus } from './market.js';
import {
  completeOrder,
  createOrder,
  markOrderDelivered,
  markOrderPaid,
  shipOrder,
} from './orders.js';
import {
  AlreadyRatedError,
  NotRatableError,
  getMyRating,
  getReputation,
  listSellerRatings,
  rateOrder,
  reputationOf,
  updateRating,
} from './ratings.js';
import { asUser } from './watches.js';

/**
 * Seller reputation (FR-5.7).
 *
 * Migration 0045's insert policy requires four things at once, and each one is a way a
 * reputation system gets gamed when it is left to application code:
 *
 *   * the order is yours        — or competitors review each other
 *   * you are the buyer         — or sellers rate themselves
 *   * the order is completed    — or a rating is a threat to be withdrawn mid-sale
 *   * the seller matches        — or a good order is used to rate a different account
 *
 * There is a test for each, and none of them goes through a helper that could be enforcing the
 * rule instead. What refuses them is Postgres.
 */
let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let readonlyPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
let workerDb: TestDatabase['db'];
let anonymous: TestDatabase['db'];

const SELLER = 'rate-seller';
const OTHER_SELLER = 'rate-seller-2';
const BUYER = 'rate-buyer';
const STRANGER = 'rate-stranger';
let variantId = '';
let cardId = '';
let counter = 0;

/** An order carried all the way to `completed`, which is the only kind that can be rated. */
async function completedOrder(sellerId = SELLER, buyerId = BUYER): Promise<string> {
  counter += 1;
  const listing = await createListing(web, sellerId, {
    cardVariantId: variantId,
    condition: 'nm',
    priceCents: 2000,
    quantity: 1,
  });
  await setListingStatus(web, sellerId, listing.id, 'active');
  const order = await createOrder(web, buyerId, {
    sellerId,
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
    paymentIntentId: `pi_rate_${String(counter)}`,
    checkoutSessionId: `cs_rate_${String(counter)}`,
  });
  await shipOrder(web, sellerId, order.id, {
    carrier: 'RM',
    trackingNumber: `TR${String(counter)}`,
  });
  await markOrderDelivered(workerDb, order.id, { actor: 'system' });
  await completeOrder(workerDb, order.id, { actor: 'system' });
  return order.id;
}

/** An order that stops short of completion, for the tests about when rating is allowed. */
async function paidOrder(): Promise<string> {
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
    paymentIntentId: `pi_rate_${String(counter)}`,
    checkoutSessionId: `cs_rate_${String(counter)}`,
  });
  return order.id;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  readonlyPool = createDb({ url: tdb.urlFor('readonly'), max: 2 });
  web = webPool.db;
  workerDb = workerPool.db;
  anonymous = readonlyPool.db;

  for (const id of [SELLER, OTHER_SELLER, BUYER, STRANGER]) {
    await tdb.db.execute(
      `insert into app.users (id, name, email) values ('${id}', '${id}', '${id}@example.invalid')`,
    );
  }
  const [variant] = await tdb.db.execute<{ id: string; card_id: string }>(
    `select id, card_id from app.card_variants limit 1`,
  );
  variantId = String(variant?.id);
  // The card the browse page is *for*: listings are per printing, a buyer asks per card.
  cardId = String(variant?.card_id);
}, 180_000);

afterAll(async () => {
  await webPool.close();
  await workerPool.close();
  await readonlyPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(
    `truncate app.order_ratings, app.orders, app.listings, app.audit_log cascade`,
  );
});

describe('rating a sale that happened', () => {
  it('lets the buyer rate a completed order', async () => {
    const orderId = await completedOrder();
    const rating = await rateOrder(web, BUYER, { orderId, stars: 5, comment: 'well packed' });

    expect(rating).toMatchObject({ stars: 5, comment: 'well packed', sellerId: SELLER });
    expect(rating.raterId).toBe(BUYER);
  });

  it('takes the seller from the order, not from the caller', async () => {
    // There is no `sellerId` to pass. A field for it would be an invitation to rate one
    // account for another's sale — the policy refuses that, but there is no reason to accept
    // the field in the first place.
    const orderId = await completedOrder();
    expect((await rateOrder(web, BUYER, { orderId, stars: 4 })).sellerId).toBe(SELLER);
  });

  it('lets the buyer change their mind', async () => {
    const orderId = await completedOrder();
    const rating = await rateOrder(web, BUYER, { orderId, stars: 2, comment: 'slow' });
    const revised = await updateRating(web, BUYER, rating.id, {
      stars: 4,
      comment: 'they fixed it',
    });

    expect(revised).toMatchObject({ stars: 4, comment: 'they fixed it' });
    expect(revised.orderId, 'the rating moved to another order').toBe(orderId);
  });

  it('refuses a second rating of the same sale', async () => {
    // One per order. A buyer who buys ten times rates ten times; nobody pads a score by
    // re-rating the same transaction.
    const orderId = await completedOrder();
    await rateOrder(web, BUYER, { orderId, stars: 5 });
    await expect(rateOrder(web, BUYER, { orderId, stars: 5 })).rejects.toThrow(AlreadyRatedError);
  });

  it('remembers what this buyer said, for showing the form filled in', async () => {
    const orderId = await completedOrder();
    await rateOrder(web, BUYER, { orderId, stars: 3, comment: 'fine' });
    expect(await getMyRating(web, BUYER, orderId)).toMatchObject({ stars: 3, comment: 'fine' });
  });

  it('has nothing to show before they have said anything', async () => {
    expect(await getMyRating(web, BUYER, await completedOrder())).toBeNull();
  });
});

describe('the four conditions, each refused', () => {
  it('refuses an order that is not completed yet', async () => {
    /**
     * The one that makes a rating a receipt rather than a threat. A buyer who can rate before
     * the sale finishes can hold a one-star review over a seller mid-transaction.
     */
    const orderId = await paidOrder();
    await expect(rateOrder(web, BUYER, { orderId, stars: 1 })).rejects.toThrow(NotRatableError);
  });

  it('refuses the seller rating their own sale', async () => {
    const orderId = await completedOrder();
    await expect(rateOrder(web, SELLER, { orderId, stars: 5 })).rejects.toThrow(NotRatableError);
  });

  it('refuses somebody who was not party to the order', async () => {
    // Invisible to them, so this is the ownership check and the existence check at once.
    const orderId = await completedOrder();
    await expect(rateOrder(web, STRANGER, { orderId, stars: 1 })).rejects.toThrow(NotRatableError);
  });

  it('refuses a rating pointed at a seller who was not on the order', async () => {
    /**
     * Raw SQL, because the query layer reads the seller from the order and so cannot express
     * this. The policy is what stops a completed order being used to rate a different account
     * — which is how a competitor's score gets buried.
     */
    const orderId = await completedOrder();
    await expectDbError(
      asUser(web, BUYER, async (tx) =>
        tx.execute(
          `insert into app.order_ratings (order_id, seller_id, rater_id, stars)
           values ('${orderId}', '${OTHER_SELLER}', '${BUYER}', 1)`,
        ),
      ),
      /row-level security/i,
    );
  });

  it('refuses a rating signed with somebody else’s name', async () => {
    const orderId = await completedOrder();
    await expectDbError(
      asUser(web, BUYER, async (tx) =>
        tx.execute(
          `insert into app.order_ratings (order_id, seller_id, rater_id, stars)
           values ('${orderId}', '${SELLER}', '${STRANGER}', 5)`,
        ),
      ),
      /row-level security/i,
    );
  });
});

describe('what the database refuses regardless', () => {
  it('refuses a score outside one to five', async () => {
    const orderId = await completedOrder();
    for (const stars of [0, 6, -1]) {
      await expectDbError(rateOrder(web, BUYER, { orderId, stars }), /order_ratings_stars_range/);
    }
  });

  it('refuses an essay', async () => {
    const orderId = await completedOrder();
    await expectDbError(
      rateOrder(web, BUYER, { orderId, stars: 5, comment: 'x'.repeat(501) }),
      /order_ratings_comment_length/,
    );
  });

  it('lets nobody delete a rating, not even the person who left it', async () => {
    /**
     * A seller cannot make a bad review disappear, and neither can a buyer who was talked into
     * removing one. No role has DELETE. Moderating a review is a separate, audited action and
     * not something a session does.
     */
    const orderId = await completedOrder();
    const rating = await rateOrder(web, BUYER, { orderId, stars: 1 });
    await expectDbError(
      asUser(web, BUYER, async (tx) =>
        tx.execute(`delete from app.order_ratings where id = '${rating.id}'`),
      ),
      /permission denied/i,
    );
  });

  it('lets nobody reassign a rating to another order', async () => {
    // `order_id` is absent from the UPDATE grant, so a rating stays attached to the sale it
    // was a receipt for.
    const first = await completedOrder();
    const second = await completedOrder();
    const rating = await rateOrder(web, BUYER, { orderId: first, stars: 1 });

    await expectDbError(
      asUser(web, BUYER, async (tx) =>
        tx.execute(`update app.order_ratings set order_id = '${second}' where id = '${rating.id}'`),
      ),
      /permission denied/i,
    );
  });
});

describe('the number under a seller’s name', () => {
  it('is null before anybody has rated them, not zero', async () => {
    /**
     * Zero is a score — the worst one — and showing it to a new seller's first customer would
     * be a lie that costs them the sale. "No ratings yet" reads as neutral, which is the truth.
     */
    const reputation = await getReputation(web, SELLER);
    expect(reputation.average).toBeNull();
    expect(reputation.count).toBe(0);
  });

  it('averages what it has, to one decimal', async () => {
    for (const stars of [5, 4, 4]) {
      await rateOrder(web, BUYER, { orderId: await completedOrder(), stars });
    }
    const reputation = await getReputation(web, SELLER);
    // 13 / 3 = 4.333…; publishing more decimals implies a precision three ratings do not have.
    expect(reputation).toMatchObject({ average: 4.3, count: 3 });
    expect(reputation.distribution).toMatchObject({ 4: 2, 5: 1 });
  });

  it('counts only that seller', async () => {
    await rateOrder(web, BUYER, { orderId: await completedOrder(SELLER), stars: 1 });
    await rateOrder(web, BUYER, { orderId: await completedOrder(OTHER_SELLER), stars: 5 });

    expect((await getReputation(web, SELLER)).average).toBe(1);
    expect((await getReputation(web, OTHER_SELLER)).average).toBe(5);
  });
});

describe('several sellers at once, for a browse page', () => {
  it('gives the same answer as asking one at a time', async () => {
    // The whole risk of a second implementation: a card page showing 4.3 and the seller's own
    // page showing 4.33 is a bug somebody writes in to report. Asserted against the original
    // rather than against a hard-coded number, so the two cannot drift apart later.
    for (const stars of [5, 4, 4]) {
      await rateOrder(web, BUYER, { orderId: await completedOrder(SELLER), stars });
    }
    await rateOrder(web, BUYER, { orderId: await completedOrder(OTHER_SELLER), stars: 2 });

    const batched = await reputationOf(anonymous, [SELLER, OTHER_SELLER]);
    for (const sellerId of [SELLER, OTHER_SELLER]) {
      const one = await getReputation(anonymous, sellerId);
      expect(batched.get(sellerId)).toEqual({ average: one.average, count: one.count });
    }
  });

  it('leaves out a seller nobody has rated, rather than scoring them zero', async () => {
    // Absent, so the caller has to decide what to show. Present-with-zero would let a browse
    // page render "0.0" under a new seller's first listing, which is the worst score there is.
    const standing = await reputationOf(anonymous, [SELLER]);
    expect(standing.has(SELLER)).toBe(false);
  });

  it('asks nothing at all for an empty list', async () => {
    expect(await reputationOf(anonymous, [])).toEqual(new Map());
  });

  it('is readable by the role the public API runs as', async () => {
    // Migration 0045 grants SELECT on order_ratings to app_readonly with USING (true), because
    // reputation is public. If that ever changes, the card page loses its seller column.
    await rateOrder(web, BUYER, { orderId: await completedOrder(SELLER), stars: 5 });
    expect((await reputationOf(anonymous, [SELLER])).get(SELLER)).toEqual({
      average: 5,
      count: 1,
    });
  });
});

describe('what a browse page shows about a seller', () => {
  it('carries the real reputation onto the listing', async () => {
    await rateOrder(web, BUYER, { orderId: await completedOrder(SELLER), stars: 4 });

    const listing = await createListing(web, SELLER, {
      cardVariantId: variantId,
      condition: 'nm',
      priceCents: 4200,
      quantity: 1,
    });
    await setListingStatus(web, SELLER, listing.id, 'active');

    const [forSale] = await browseListingsForCard(anonymous, cardId);
    // No name: these sellers have no connected account, so there is nowhere for one to live.
    expect(forSale?.seller).toEqual({ name: null, average: 4, count: 1 });
  });

  it('never names the seller', async () => {
    // The reason the browse response has no sellerId: this route is public, with CORS `*` and
    // no session, and a user id there is a list of everyone selling anything.
    await rateOrder(web, BUYER, { orderId: await completedOrder(SELLER), stars: 4 });
    const listing = await createListing(web, SELLER, {
      cardVariantId: variantId,
      condition: 'nm',
      priceCents: 4200,
      quantity: 1,
    });
    await setListingStatus(web, SELLER, listing.id, 'active');

    const forSale = await browseListingsForCard(anonymous, cardId);
    expect(JSON.stringify(forSale)).not.toContain(SELLER);
  });
});

describe('who can read a rating', () => {
  it('shows them to anybody, because that is what reputation is for', async () => {
    // The person deciding whether to buy is by definition not a party to the order being
    // rated, so an ownership test here would make the feature useless.
    await rateOrder(web, BUYER, { orderId: await completedOrder(), stars: 5, comment: 'great' });

    expect(await listSellerRatings(web, SELLER)).toHaveLength(1);
    expect(await listSellerRatings(anonymous, SELLER)).toHaveLength(1);
  });

  it('never publishes who left one', async () => {
    // SR-3.8, the rule public collections follow: what somebody bought is not public.
    await rateOrder(web, BUYER, { orderId: await completedOrder(), stars: 5 });
    const [published] = await listSellerRatings(anonymous, SELLER);

    expect(published).not.toHaveProperty('raterId');
    expect(JSON.stringify(published)).not.toContain(BUYER);
  });
});
