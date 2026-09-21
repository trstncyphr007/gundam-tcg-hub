/**
 * Live-sale logging rules (FR-4.1, SR-4.4, SR-4.5).
 *
 * A seller logs each sale as it happens on stream. The entries become price observations at
 * the highest weight the index gives anything, because we watched them — which is exactly
 * why the rules about what may be entered, and what happens to it afterwards, live here with
 * tests rather than being scattered through a form and a route.
 */

/**
 * How long a buyer handle is kept (SR-4.5).
 *
 * A buyer handle is somebody's name on another platform, entered by a third party who never
 * agreed to anything with us. It exists for one reason — the seller has to know who to post
 * the card to — and that reason expires. Ninety days covers a dispute window comfortably and
 * nothing beyond it.
 */
export const BUYER_HANDLE_RETENTION_DAYS = 90;

/** Per-seller daily cap on entries (SR-4.4). Far above a real stream; bounds a runaway client. */
export const MAX_LIVE_SALES_PER_DAY = 500;

/** A live sale is a single card changing hands; anything larger is a different transaction. */
export const MAX_LIVE_SALE_PRICE_CENTS = 100_000_000;

export class BuyerHandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuyerHandleError';
  }
}

/**
 * Clean up a buyer handle before it is stored.
 *
 * Strips a single leading `@`, because sellers type it half the time and `@alice` and `alice`
 * being two different people in our records helps nobody. Collapses internal whitespace for
 * the same reason.
 *
 * Returns `null` for an empty handle, which is a supported answer: FR-4.1 makes the handle
 * optional, and a seller who does not need it should not be storing someone's name.
 */
export function normaliseBuyerHandle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const collapsed = raw.trim().replace(/\s+/gu, ' ');
  if (collapsed.length === 0) return null;

  const withoutSigil = collapsed.startsWith('@') ? collapsed.slice(1).trim() : collapsed;
  if (withoutSigil.length === 0) return null;
  if (withoutSigil.length > 64) {
    throw new BuyerHandleError('a buyer handle must be 64 characters or fewer');
  }
  // Control characters would survive into a CSV export and a log line, and no platform's
  // handle contains one.
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/u.test(withoutSigil)) {
    throw new BuyerHandleError('a buyer handle cannot contain control characters');
  }
  return withoutSigil;
}

/** When a handle entered now stops being kept. */
export function buyerHandleExpiryFrom(soldAt: Date): Date {
  return new Date(soldAt.getTime() + BUYER_HANDLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** Has this handle outlived its purpose? */
export function buyerHandleExpired(soldAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= buyerHandleExpiryFrom(soldAt).getTime();
}
