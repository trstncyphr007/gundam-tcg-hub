import { describe, expect, it } from 'vitest';
import {
  ListingError,
  MAX_LISTING_PRICE_CENTS,
  MAX_LISTING_QUANTITY,
  PHOTO_REQUIRED_ABOVE_CENTS,
  canPublish,
  photosRequiredFor,
  validateListing,
} from './market.js';

/**
 * The rules a listing satisfies before anybody can buy it (FR-5.2).
 *
 * The database has CHECKs for all of this and those are the ones that matter. These tests are
 * about the half that produces a sentence a seller can act on rather than a constraint name.
 */
describe('when photos are required', () => {
  it('is above the threshold, not at it', () => {
    // Exactly $25 does not need photos; a cent more does. Stated as a test because "above"
    // and "at least" differ by one listing and somebody will have to answer for which.
    expect(photosRequiredFor(PHOTO_REQUIRED_ABOVE_CENTS)).toBe(false);
    expect(photosRequiredFor(PHOTO_REQUIRED_ABOVE_CENTS + 1)).toBe(true);
    expect(photosRequiredFor(1)).toBe(false);
  });

  it('is the number the plan asked for', () => {
    // $25 (§14). Pinned so raising it is a deliberate act with a test to update, not a
    // constant somebody nudged.
    expect(PHOTO_REQUIRED_ABOVE_CENTS).toBe(2500);
  });
});

describe('saving a draft', () => {
  const ok = { priceCents: 1000, quantity: 1 };

  it('accepts an ordinary listing', () => {
    expect(() => {
      validateListing(ok);
    }).not.toThrow();
  });

  it.each([
    [0, 'free'],
    [-1, 'negative'],
    [MAX_LISTING_PRICE_CENTS + 1, 'over the ceiling'],
    [10.5, 'fractional cents'],
  ])('refuses a price of %d (%s)', (priceCents) => {
    expect(() => {
      validateListing({ ...ok, priceCents });
    }).toThrow(ListingError);
  });

  it.each([
    [0, 'none'],
    [MAX_LISTING_QUANTITY + 1, 'more than anyone has'],
    [1.5, 'half a card'],
  ])('refuses a quantity of %d (%s)', (quantity) => {
    expect(() => {
      validateListing({ ...ok, quantity });
    }).toThrow(ListingError);
  });

  it('refuses notes longer than the column allows', () => {
    // The database would refuse this too. Getting there first is the difference between a
    // message and a stack trace.
    expect(() => {
      validateListing({ ...ok, notes: 'x'.repeat(501) });
    }).toThrow(ListingError);
    expect(() => {
      validateListing({ ...ok, notes: 'x'.repeat(500) });
    }).not.toThrow();
  });

  it('says which rule was broken, not just that one was', () => {
    try {
      validateListing({ ...ok, priceCents: 0 });
    } catch (error) {
      expect((error as ListingError).code).toBe('price_out_of_range');
    }
  });
});

describe('going on sale', () => {
  it('lets a cheap listing go live with no photos', () => {
    expect(canPublish({ priceCents: 500, photoCount: 0 }).ok).toBe(true);
  });

  it('will not publish an expensive one without a photo of the card', () => {
    const result = canPublish({ priceCents: 5000, photoCount: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('photos_required');
  });

  it('publishes it once there is one', () => {
    expect(canPublish({ priceCents: 5000, photoCount: 1 }).ok).toBe(true);
  });

  it('is a separate question from whether the draft is valid', () => {
    // A seller still taking pictures should be able to save their work. Only going live
    // requires the photos, which is why this is not part of validateListing.
    expect(() => {
      validateListing({ priceCents: 5000, quantity: 1 });
    }).not.toThrow();
    expect(canPublish({ priceCents: 5000, photoCount: 0 }).ok).toBe(false);
  });
});
