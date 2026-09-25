import { type ListingDraft, photosRequiredFor, validateListing } from '@gth/core';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { cardVariants, cards, sets } from '../schema/catalog.js';
import { listings } from '../schema/market.js';
import { MissingReferenceError, isForeignKeyViolation } from './pg-errors.js';
import { reputationOf } from './ratings.js';
import { asUser } from './watches.js';

/**
 * Marketplace listings (FR-5.2).
 *
 * Every write goes through `asUser`, because these tables FORCE row-level security and a
 * connection that has not said who it is writes nothing — silently. The policies are the real
 * access control; this module's job is to declare the user so they can do their work, and to
 * turn a refusal into something a route can explain.
 *
 * The *other* kind of listing — a shop's URL for a sealed product — lives in `listings.ts`.
 */

export type ListingStatus = 'draft' | 'active' | 'sold' | 'withdrawn';

export interface Listing {
  id: string;
  sellerId: string;
  cardVariantId: string;
  condition: string;
  priceCents: number;
  currency: string;
  quantity: number;
  status: ListingStatus;
  photoRequired: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateListingInput extends ListingDraft {
  cardVariantId: string;
  condition: 'nm' | 'lp' | 'mp' | 'hp' | 'dmg';
  currency?: string | undefined;
}

/** Raised when a listing exists but is not this seller's to touch. */
export class ListingNotFoundError extends Error {
  constructor() {
    super('no such listing');
    this.name = 'ListingNotFoundError';
  }
}

/**
 * Start a listing. It begins as a draft and goes on sale separately.
 *
 * `photo_required` is decided here, once, from the price at the moment of creation — the
 * threshold is a policy that will change, and a listing should keep the promise it was made
 * under rather than whatever the rule happens to be when somebody reads it later.
 */
export async function createListing(
  db: Database,
  sellerId: string,
  input: CreateListingInput,
): Promise<Listing> {
  validateListing(input);
  return asUser(db, sellerId, async (tx) => {
    try {
      const [row] = await tx
        .insert(listings)
        .values({
          sellerId,
          cardVariantId: input.cardVariantId,
          condition: input.condition,
          priceCents: input.priceCents,
          quantity: input.quantity,
          ...(input.currency === undefined ? {} : { currency: input.currency }),
          ...(input.notes === undefined || input.notes === null ? {} : { notes: input.notes }),
          photoRequired: photosRequiredFor(input.priceCents),
        })
        .returning();
      if (!row) throw new Error('listing insert returned nothing');
      return row;
    } catch (error) {
      // A card variant id that is well-formed and names nothing. The route comment claimed
      // this already answered 404 "the same way every other missing reference does"; the
      // no-5xx sweep disagreed and was right — without this it is a foreign key violation
      // that reaches the error handler as 500 (#64's exact shape, found by #64's gate).
      if (isForeignKeyViolation(error)) throw new MissingReferenceError('card');
      throw error;
    }
  });
}

/** Everything this seller has, whatever state it is in. */
export async function listMyListings(db: Database, sellerId: string): Promise<Listing[]> {
  return asUser(db, sellerId, async (tx) => {
    const rows = await tx
      .select()
      .from(listings)
      .where(eq(listings.sellerId, sellerId))
      .orderBy(sql`${listings.createdAt} desc`);
    return rows;
  });
}

/**
 * What is actually for sale for one card, cheapest first.
 *
 * No `asUser`: the policy for a session already shows active listings to everyone, and the
 * public API reads this on the read-only role where the only policy is "active". A browse
 * that had to know who was asking would be a browse that cannot be cached.
 */
export async function listActiveForVariant(
  db: Database,
  cardVariantId: string,
  limit = 50,
): Promise<Listing[]> {
  const rows = await db
    .select()
    .from(listings)
    .where(and(eq(listings.cardVariantId, cardVariantId), eq(listings.status, 'active')))
    .orderBy(listings.priceCents)
    .limit(limit);
  return rows;
}

/**
 * One listing on a browse page: enough to choose it, and nothing that names its seller.
 *
 * `sellerId` is deliberately absent. It is a user id, and this route is public — CORS `*`, no
 * session — so publishing it would hand every scraper a list of everyone selling anything,
 * keyed by an identifier that also appears in URLs elsewhere. A buyer choosing between two
 * listings needs the price, the condition and whether the seller can be trusted; none of that
 * requires knowing *which* seller it is.
 *
 * What replaces it is the standing, inline. When sellers eventually have a public display name
 * they have chosen (SR-3.8), that is what goes here — not the id.
 */
export interface ListingForSale {
  id: string;
  cardVariantId: string;
  finish: string;
  language: string;
  condition: string;
  priceCents: number;
  currency: string;
  quantity: number;
  /** Null average, never zero, when nobody has rated them. See `getReputation`. */
  seller: { average: number | null; count: number };
}

/**
 * Everything for sale for one card, cheapest first (FR-5.2, FR-5.7).
 *
 * The entry point to buying anything. Until this existed the marketplace had a checkout with
 * no way to reach it: `POST /v1/listings/:id/buy` works only if you already know a listing id,
 * and nobody did.
 *
 * Per **card**, not per variant, because that is the question a buyer asks. A card has several
 * printings and they are all the same card to somebody who wants one; the printing is a column
 * in the answer rather than a thing to pick first. `listActiveForVariant` remains for the
 * narrower question.
 *
 * No `asUser`, and none is possible: this runs on the read-only role, where the only policy on
 * `listings` is `status = 'active'`. A draft cannot be returned by this function however it is
 * called, because the role it runs as cannot see one. The partial index
 * `listings_variant_active_idx (card_variant_id, price_cents) WHERE status = 'active'` covers
 * the ordering.
 */
export async function browseListingsForCard(
  db: Database,
  cardId: string,
  limit = 50,
): Promise<ListingForSale[]> {
  const rows = await db
    .select({
      id: listings.id,
      sellerId: listings.sellerId,
      cardVariantId: listings.cardVariantId,
      finish: cardVariants.finish,
      language: cardVariants.language,
      condition: listings.condition,
      priceCents: listings.priceCents,
      currency: listings.currency,
      quantity: listings.quantity,
    })
    .from(listings)
    .innerJoin(cardVariants, eq(cardVariants.id, listings.cardVariantId))
    .where(and(eq(cardVariants.cardId, cardId), eq(listings.status, 'active')))
    .orderBy(listings.priceCents)
    .limit(limit);

  // One query for every seller on the page rather than one per listing. Twenty listings from
  // twenty sellers would otherwise be twenty round trips to compute a number each.
  const standing = await reputationOf(
    db,
    rows.map((row) => row.sellerId),
  );

  return rows.map(({ sellerId, ...listing }) => ({
    ...listing,
    seller: standing.get(sellerId) ?? { average: null, count: 0 },
  }));
}

/** One listing, if this viewer may see it. A draft is visible only to its seller. */
export async function getListing(
  db: Database,
  viewerId: string | null,
  id: string,
): Promise<Listing | null> {
  const read = async (tx: Database): Promise<Listing | null> => {
    const [row] = await tx.select().from(listings).where(eq(listings.id, id)).limit(1);
    return (row as Listing | undefined) ?? null;
  };
  return viewerId === null ? read(db) : asUser(db, viewerId, read);
}

/**
 * What to call this card on somebody else's checkout page.
 *
 * The line item on Stripe's hosted page is the last thing a buyer reads before they pay, and
 * a UUID there is how a legitimate purchase comes to look like a scam. No `asUser`: the
 * catalog is public, and which card a listing names is not a secret from the person buying it.
 */
export async function describeCardVariant(
  db: Database,
  cardVariantId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      name: cards.name,
      number: cards.number,
      setCode: sets.code,
      finish: cardVariants.finish,
    })
    .from(cardVariants)
    .innerJoin(cards, eq(cards.id, cardVariants.cardId))
    .innerJoin(sets, eq(sets.id, cards.setId))
    .where(eq(cardVariants.id, cardVariantId))
    .limit(1);
  if (!row) return null;

  const finish = row.finish === 'normal' ? '' : ` (${row.finish.replace('_', ' ')})`;
  return `${row.name} — ${row.setCode}-${row.number}${finish}`;
}

export interface UpdateListingInput extends ListingDraft {
  condition?: 'nm' | 'lp' | 'mp' | 'hp' | 'dmg' | undefined;
}

/**
 * Change a listing the seller owns.
 *
 * The price moving recomputes `photo_required`: a seller who lists at $10 and then raises it
 * to $80 has to show the card, and the alternative — the flag frozen at creation — is the
 * obvious way round the requirement.
 */
export async function updateListing(
  db: Database,
  sellerId: string,
  id: string,
  input: UpdateListingInput,
): Promise<Listing> {
  validateListing(input);
  return asUser(db, sellerId, async (tx) => {
    const [row] = await tx
      .update(listings)
      .set({
        priceCents: input.priceCents,
        quantity: input.quantity,
        notes: input.notes ?? null,
        ...(input.condition === undefined ? {} : { condition: input.condition }),
        photoRequired: photosRequiredFor(input.priceCents),
        updatedAt: new Date(),
      })
      .where(and(eq(listings.id, id), eq(listings.sellerId, sellerId)))
      .returning();
    if (!row) throw new ListingNotFoundError();
    return row;
  });
}

/**
 * Move a listing between states.
 *
 * `sold` is absent from the type, and — since migration 0042 — from what the database will
 * accept on this role. The type alone was not enough: the first version of this function
 * refused `'sold'` at compile time and set it happily at runtime, which a test caught. A
 * listing becomes sold because an order was paid for, on the worker, after a verified
 * webhook. Same reasoning as an order's `paid`: nobody moves their own money.
 */
export async function setListingStatus(
  db: Database,
  sellerId: string,
  id: string,
  status: 'draft' | 'active' | 'withdrawn',
): Promise<Listing> {
  return asUser(db, sellerId, async (tx) => {
    const [row] = await tx
      .update(listings)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(listings.id, id), eq(listings.sellerId, sellerId)))
      .returning();
    if (!row) throw new ListingNotFoundError();
    return row;
  });
}

/** Only a draft can be removed outright; anything that has been live is withdrawn instead. */
export async function deleteDraftListing(
  db: Database,
  sellerId: string,
  id: string,
): Promise<boolean> {
  return asUser(db, sellerId, async (tx) => {
    const rows = await tx
      .delete(listings)
      .where(
        and(eq(listings.id, id), eq(listings.sellerId, sellerId), eq(listings.status, 'draft')),
      )
      .returning();
    return rows.length > 0;
  });
}

/** How many listings this seller has created since a moment (SR-5.6). */
export async function countSellerListingsSince(
  db: Database,
  sellerId: string,
  since: Date,
): Promise<number> {
  return asUser(db, sellerId, async (tx) => {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(listings)
      .where(and(eq(listings.sellerId, sellerId), gte(listings.createdAt, since)));
    return rows[0]?.n ?? 0;
  });
}
