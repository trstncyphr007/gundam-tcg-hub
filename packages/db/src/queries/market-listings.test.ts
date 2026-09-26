import { PHOTO_REQUIRED_ABOVE_CENTS } from '@gth/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DisplayNameTakenError, clearSellerDisplayName, setSellerDisplayName } from './sellers.js';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  ListingNotFoundError,
  browseListingsForCard,
  coverPhotoKeys,
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
let cardId = '';

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
  const [variant] = await tdb.db.execute<{ id: string; card_id: string }>(
    `select id, card_id from app.card_variants limit 1`,
  );
  variantId = String(variant?.id);
  // Listings are per printing; a buyer browses per card.
  cardId = String(variant?.card_id);
}, 180_000);

afterAll(async () => {
  await webPool.close();
  await readonlyPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  // `seller_accounts` too: a display name set by one test is visible to the next one's browse
  // query otherwise, which is how two unrelated assertions here started failing at once.
  await tdb.db.execute(`truncate app.orders, app.listings, app.seller_accounts cascade`);
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

  /**
   * The browse page, which is how anybody finds anything to buy.
   *
   * Read on the read-only role throughout, because that is the role the public route runs as
   * and the only one whose policy on `listings` is `status = 'active'` alone. A draft hidden
   * here is hidden by Postgres, not by a `where` clause somebody could remove.
   */
  it('shows every printing of a card, cheapest first', async () => {
    for (const priceCents of [3000, 1000, 2000]) {
      const l = await createListing(web, SELLER, {
        ...draft,
        cardVariantId: variantId,
        priceCents,
      });
      await setListingStatus(web, SELLER, l.id, 'active');
    }

    const forSale = await browseListingsForCard(anonymous, cardId);
    expect(forSale.map((l) => l.priceCents)).toEqual([1000, 2000, 3000]);
    // The printing is a column in the answer rather than something to choose first.
    expect(forSale[0]?.cardVariantId).toBe(variantId);
    expect(typeof forSale[0]?.finish).toBe('string');
    expect(typeof forSale[0]?.language).toBe('string');
  });

  it('cannot return a draft, because the role cannot see one', async () => {
    await createListing(web, SELLER, { ...draft, cardVariantId: variantId, priceCents: 1 });
    const live = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    await setListingStatus(web, SELLER, live.id, 'active');

    const forSale = await browseListingsForCard(anonymous, cardId);
    expect(forSale).toHaveLength(1);
    expect(forSale[0]?.id).toBe(live.id);
  });

  it('drops one that has been taken off sale', async () => {
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    await setListingStatus(web, SELLER, listing.id, 'active');
    expect(await browseListingsForCard(anonymous, cardId)).toHaveLength(1);

    await setListingStatus(web, SELLER, listing.id, 'withdrawn');
    expect(await browseListingsForCard(anonymous, cardId)).toEqual([]);
  });

  it('says nothing about a card that does not exist', async () => {
    // An empty list rather than a 404. Which cards exist is answered by GET /v1/cards/{id},
    // and making this route answer it twice would be a second thing to keep in agreement.
    expect(await browseListingsForCard(anonymous, '00000000-0000-7000-8000-000000000000')).toEqual(
      [],
    );
  });

  it('has no picture for a listing whose photographs are not approved', async () => {
    /**
     * The read-only role cannot see a pending photograph at all — migration 0044's policy for
     * it is `status = 'approved' AND the listing is active`. So a file nobody has inspected
     * cannot reach a shop window, and this asserts the absence rather than assuming it.
     *
     * The approved case is covered end to end, where a real image goes through the real
     * pipeline; fabricating an "approved" row here would prove only that the query can read
     * one, and the CHECK `listing_photos_approved_is_complete` refuses a fabricated one anyway.
     */
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    await setListingStatus(web, SELLER, listing.id, 'active');
    await workerDb.execute(
      `insert into app.listing_photos (listing_id, upload_key, content_type)
       values ('${listing.id}', 'uploads/pending-${listing.id}', 'image/jpeg')`,
    );

    const [forSale] = await browseListingsForCard(anonymous, cardId);
    expect(forSale?.photoKey).toBeNull();
  });

  it('asks for nothing when there are no listings to decorate', async () => {
    // The empty-list guard on both helper queries: `inArray` with no values is not a query
    // worth sending, and some drivers make it an error rather than an empty result.
    expect(await coverPhotoKeys(anonymous, [])).toEqual(new Map());
    expect(await browseListingsForCard(anonymous, cardId)).toEqual([]);
  });

  /**
   * A seller's chosen name (FR-5.7, SR-3.8).
   *
   * The interesting assertions are not "the name comes back" but the two next to it: the
   * read-only role can read the name and **cannot read the Stripe account id**, because
   * migration 0046 grants SELECT on two columns rather than on the table. A grant is not
   * something a query can argue with.
   */
  describe('the name a seller chose', () => {
    async function onboard(sellerId: string, name: string | null): Promise<void> {
      await workerDb.execute(
        `insert into app.seller_accounts (user_id, stripe_account_id)
         values ('${sellerId}', 'acct_${sellerId.replaceAll('-', '')}')
         on conflict (user_id) do nothing`,
      );
      if (name !== null) await setSellerDisplayName(web, sellerId, name);
    }

    it('shows it on the listing once chosen, and nothing before', async () => {
      const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
      await setListingStatus(web, SELLER, listing.id, 'active');

      const [before] = await browseListingsForCard(anonymous, cardId);
      expect(before?.seller.name).toBeNull();

      await onboard(SELLER, 'Aggressive Duelist');
      const [after] = await browseListingsForCard(anonymous, cardId);
      expect(after?.seller.name).toBe('Aggressive Duelist');
    });

    it('never lets the public role read the Stripe account id', async () => {
      await onboard(SELLER, 'Aggressive Duelist');
      // The column is outside the grant, so this is refused rather than filtered.
      await expectDbError(
        anonymous.execute(`select stripe_account_id from app.seller_accounts`),
        /permission denied/i,
      );
      // And the two it may read, it may read.
      const rows = await anonymous.execute(`select user_id, display_name from app.seller_accounts`);
      expect(rows).toHaveLength(1);
    });

    it('hides a seller who chose no name from the public role entirely', async () => {
      await onboard(SELLER, null);
      const rows = await anonymous.execute(`select user_id from app.seller_accounts`);
      expect(rows).toEqual([]);
    });

    it('refuses a name another seller already has, whatever the case', async () => {
      await onboard(SELLER, 'Aggressive Duelist');
      await onboard(OTHER, null);
      await expect(setSellerDisplayName(web, OTHER, 'aggressive duelist')).rejects.toBeInstanceOf(
        DisplayNameTakenError,
      );
    });

    it('refuses a name the CHECK does not like', async () => {
      await onboard(SELLER, null);
      // Padded to sort first, and made of punctuation. Both refused by the constraint rather
      // than by any code that could be skipped.
      for (const bad of ['  padded', '...', 'a', 'x'.repeat(41)]) {
        await expectDbError(setSellerDisplayName(web, SELLER, bad), /seller_accounts_display/i);
      }
    });

    it('is the seller’s to write, and nobody else’s', async () => {
      await onboard(SELLER, 'Aggressive Duelist');
      await onboard(OTHER, null);
      // The UPDATE policy matches on user_id, so this changes nothing at all.
      await setSellerDisplayName(web, OTHER, 'Someone Else');
      const [row] = await workerDb.execute<{ display_name: string }>(
        `select display_name from app.seller_accounts where user_id = '${SELLER}'`,
      );
      expect(row?.display_name).toBe('Aggressive Duelist');
    });

    it('cannot be used to switch on a seller’s own payouts', async () => {
      // The whole point of the column-level grant: the row is now writable by its owner, and
      // the two booleans that decide whether somebody may take money still are not.
      await onboard(SELLER, null);
      await expectDbError(
        web.execute(
          `set local app.user_id = '${SELLER}'; update app.seller_accounts set payouts_enabled = true`,
        ),
        /permission denied|denied for/i,
      );
    });

    it('can be taken away by an admin, and chosen again afterwards', async () => {
      await onboard(SELLER, 'Aggressive Duelist');
      expect(await clearSellerDisplayName(workerDb, SELLER)).toBe(true);

      const [gone] = await browseListingsForCard(anonymous, cardId);
      expect(gone?.seller.name ?? null).toBeNull();

      // The name is free again, for them or anybody.
      await setSellerDisplayName(web, SELLER, 'Aggressive Duelist');
    });
  });

  it('shows an unrated seller as unrated rather than as bad', async () => {
    const listing = await createListing(web, SELLER, { ...draft, cardVariantId: variantId });
    await setListingStatus(web, SELLER, listing.id, 'active');

    const [forSale] = await browseListingsForCard(anonymous, cardId);
    // Null, never 0. Zero is a score — the worst one — and a new seller's first customer
    // reading it would be reading a lie that costs them the sale.
    expect(forSale?.seller).toEqual({ name: null, average: null, count: 0 });
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
