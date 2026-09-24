import { PHOTO_REQUIRED_ABOVE_CENTS } from '@gth/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  ListingNotFoundError,
  createListing,
  deleteDraftListing,
  getListing,
  listActiveForVariant,
  listMyListings,
  setListingStatus,
  updateListing,
} from './market.js';

/**
 * Selling a card (FR-5.2).
 *
 * The policies were proved in `market.test.ts` by talking to the database directly. This file
 * is about the layer above: that the functions a route will call declare the right user, set
 * the right flags, and refuse the right things — through the same policies, rather than around
 * them.
 */
let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let readonlyPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
let anonymous: TestDatabase['db'];
/** The role a paid order runs on, and the only one that may write `sold`. */
let workerDb: TestDatabase['db'];

const SELLER = 'listing-seller';
const OTHER = 'listing-other';
let variantId = '';

const draft = { priceCents: 1000, quantity: 1, condition: 'nm' as const };

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  readonlyPool = createDb({ url: tdb.urlFor('readonly'), max: 2 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  web = webPool.db;
  anonymous = readonlyPool.db;
  workerDb = workerPool.db;

  for (const id of [SELLER, OTHER]) {
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
  await readonlyPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(`truncate app.orders, app.listings cascade`);
});

describe('starting a listing', () => {
  it('begins as a draft, not on sale', async () => {
    // Saving is not publishing. A seller filling in a form has not agreed to sell anything
    // yet, and a listing that went live on first save would be a surprise.
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    expect(listing.status).toBe('draft');
    expect(listing.sellerId).toBe(SELLER);
  });

  it('records whether photos were required, at the price it was created at', async () => {
    const cheap = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    const dear = await createListing(web, SELLER, {
      ...draft,
      cardVariantId: variantId,
      priceCents: PHOTO_REQUIRED_ABOVE_CENTS + 1,
    });
    expect(cheap.photoRequired).toBe(false);
    expect(dear.photoRequired).toBe(true);
  });

  it('refuses a price the database would refuse anyway, with a sentence instead', async () => {
    await expect(
      createListing(web, SELLER, { ...draft, cardVariantId: variantId, priceCents: 0 }),
    ).rejects.toThrow(/price/i);
  });
});

describe('changing one', () => {
  it('re-decides the photo requirement when the price moves', async () => {
    // The obvious way round the requirement: list at $10, publish, then raise it to $80. The
    // flag has to follow the price rather than stay at whatever it was on the first save.
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    expect(listing.photoRequired).toBe(false);

    const raised = await updateListing(web, SELLER, listing.id, {
      priceCents: PHOTO_REQUIRED_ABOVE_CENTS + 5000,
      quantity: 1,
    });
    expect(raised.photoRequired).toBe(true);
  });

  it('is not something another seller can do', async () => {
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    await expect(
      updateListing(web, OTHER, listing.id, { priceCents: 1, quantity: 1 }),
    ).rejects.toThrow(ListingNotFoundError);

    // And the row is untouched, not merely the request refused.
    const after = await getListing(web, SELLER, listing.id);
    expect(after?.priceCents).toBe(1000);
  });

  it('cannot be marked sold by its seller', async () => {
    // A listing becomes sold because an order was paid for, on the worker, after a verified
    // webhook. The same reasoning as an order's `paid`: nobody moves their own money.
    //
    // The first version of this passed the type check and failed this test: `'sold'` was
    // outside the function's type and the update went straight through, because a type is not
    // something the database can feel. Migration 0042 put the rule where it holds.
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    // @ts-expect-error -- 'sold' is deliberately outside the type this function accepts.
    await expectDbError(setListingStatus(web, SELLER, listing.id, 'sold'), /row-level security/i);

    const after = await getListing(web, SELLER, listing.id);
    expect(after?.status).toBe('draft');
  });

  it('cannot be edited at all once it is sold', async () => {
    // The same WITH CHECK, seen from the other side: an update to a sold listing would have
    // to leave it sold, and the check refuses that. A sold listing is what somebody bought.
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    await workerDb.execute(`update app.listings set status = 'sold' where id = '${listing.id}'`);

    await expectDbError(
      updateListing(web, SELLER, listing.id, { priceCents: 1, quantity: 1 }),
      /row-level security/i,
    );
  });
});

describe('who can see what', () => {
  it('keeps a draft to its seller', async () => {
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });

    expect((await getListing(web, SELLER, listing.id))?.id).toBe(listing.id);
    expect(await getListing(web, OTHER, listing.id)).toBeNull();
    // No session at all — the public API's role.
    expect(await getListing(anonymous, null, listing.id)).toBeNull();
  });

  it('shows an active one to everyone', async () => {
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    await setListingStatus(web, SELLER, listing.id, 'active');

    expect((await getListing(web, OTHER, listing.id))?.id).toBe(listing.id);
    expect((await getListing(anonymous, null, listing.id))?.id).toBe(listing.id);
  });

  it('lists what is for sale for a card, cheapest first', async () => {
    for (const priceCents of [3000, 1000, 2000]) {
      const l = await createListing(web, SELLER, {
        ...draft,
        cardVariantId: variantId,
        priceCents,
      });
      await setListingStatus(web, SELLER, l.id, 'active');
    }
    // One left as a draft, which must not appear.
    await createListing(web, SELLER, { ...draft, cardVariantId: variantId, priceCents: 1 });

    const forSale = await listActiveForVariant(anonymous, variantId);
    expect(forSale.map((l) => l.priceCents)).toEqual([1000, 2000, 3000]);
  });

  it('shows a seller all of their own, in any state', async () => {
    await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    await createListing(web, OTHER, { ...draft, cardVariantId: variantId });

    const mine = await listMyListings(web, SELLER);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.sellerId).toBe(SELLER);
  });
});

describe('removing one', () => {
  it('deletes a draft', async () => {
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    expect(await deleteDraftListing(web, SELLER, listing.id)).toBe(true);
    expect(await getListing(web, SELLER, listing.id)).toBeNull();
  });

  it('will not delete one that has been on sale', async () => {
    // Withdrawn, not deleted: an order may point at it, and "the listing you bought from no
    // longer exists" is not an answer anybody wants during a dispute.
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    await setListingStatus(web, SELLER, listing.id, 'active');

    expect(await deleteDraftListing(web, SELLER, listing.id)).toBe(false);
    expect((await getListing(web, SELLER, listing.id))?.id).toBe(listing.id);
  });

  it('will not let one seller delete anotherseller’s draft', async () => {
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    expect(await deleteDraftListing(web, OTHER, listing.id)).toBe(false);
    expect((await getListing(web, SELLER, listing.id))?.id).toBe(listing.id);
  });
});
