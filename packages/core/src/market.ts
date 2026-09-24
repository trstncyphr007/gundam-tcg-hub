/**
 * The rules a listing has to satisfy before anybody can buy it (FR-5.2).
 *
 * Here rather than in the database layer because three places need the same answers: the form
 * that tells a seller "photos are required above $25", the query that records whether they
 * were, and the check that refuses to publish without them. The last time this project had one
 * number in two places with a comment claiming they matched, they had not matched for weeks.
 */

/**
 * Above this, a listing must carry real photos of the actual card before it can go live.
 *
 * $25 is the plan's default (§14, FR-5.2) and it is a trust decision rather than a technical
 * one: below it the postage is a large fraction of the price and a scam is barely worth
 * running; above it, a buyer is entitled to see the thing they are buying rather than a
 * catalog image of a different copy.
 */
export const PHOTO_REQUIRED_ABOVE_CENTS = 2500;

/** Whether a listing at this price has to show the card itself. */
export function photosRequiredFor(priceCents: number): boolean {
  return priceCents > PHOTO_REQUIRED_ABOVE_CENTS;
}

/**
 * The ceiling, shared with live sales.
 *
 * A typo that adds three zeroes should be refused while it is still a form field, not become
 * a checkout session for a million dollars.
 */
export const MAX_LISTING_PRICE_CENTS = 100_000_000;

/** Most of one card a single listing may offer. */
export const MAX_LISTING_QUANTITY = 999;

export class ListingError extends Error {
  constructor(
    readonly code:
      'price_out_of_range' | 'quantity_out_of_range' | 'notes_too_long' | 'photos_required',
    message: string,
  ) {
    super(message);
    this.name = 'ListingError';
  }
}

export interface ListingDraft {
  priceCents: number;
  quantity: number;
  notes?: string | null | undefined;
}

/**
 * Check a draft before it reaches the database.
 *
 * The database has CHECKs for all of this and they are the ones that matter — this exists so a
 * seller gets "that price is too high" instead of a constraint name, not because the database
 * needs help. Both, always: a message a person can act on, and a rule a bug cannot get past.
 */
export function validateListing(draft: ListingDraft): void {
  if (
    !Number.isInteger(draft.priceCents) ||
    draft.priceCents <= 0 ||
    draft.priceCents > MAX_LISTING_PRICE_CENTS
  ) {
    throw new ListingError('price_out_of_range', 'a price must be between 1 cent and $1,000,000');
  }
  if (
    !Number.isInteger(draft.quantity) ||
    draft.quantity < 1 ||
    draft.quantity > MAX_LISTING_QUANTITY
  ) {
    throw new ListingError(
      'quantity_out_of_range',
      `a listing may offer 1 to ${String(MAX_LISTING_QUANTITY)}`,
    );
  }
  if ((draft.notes ?? '').length > 500) {
    throw new ListingError('notes_too_long', 'notes are limited to 500 characters');
  }
}

/**
 * May this listing go on sale?
 *
 * Separate from `validateListing` because it is asked at a different moment and has a
 * different answer: a draft can be saved incomplete, and only going *live* requires the
 * photos. A seller who is still taking pictures should not be stopped from saving their work.
 */
export function canPublish(listing: {
  priceCents: number;
  photoCount: number;
}): { ok: true } | { ok: false; error: ListingError } {
  if (photosRequiredFor(listing.priceCents) && listing.photoCount === 0) {
    return {
      ok: false,
      error: new ListingError(
        'photos_required',
        `a listing over $${String(PHOTO_REQUIRED_ABOVE_CENTS / 100)} needs at least one photo of the card`,
      ),
    };
  }
  return { ok: true };
}
