/**
 * Velocity and new-account limits (SR-5.6, T11).
 *
 * ## What these are, and what they are not
 *
 * They are **not** rate limits. The API already has those: sixty listing edits a minute, ten
 * purchases a minute, per account. Those exist so one client cannot exhaust a server, and they
 * are measured in seconds because that is the timescale of abuse-by-script.
 *
 * These are measured in hours and days, and they exist for a different reason: **a stolen card
 * is worth the most in the first hour of an account's life.** The pattern is an account created
 * minutes ago buying the three most expensive things it can find. No per-minute limit notices
 * that, because three purchases in ten minutes is not fast.
 *
 * ## Why they refuse rather than flag
 *
 * The plan lists "new-account purchase caps" among the fraud rules and "mismatched-geo flags"
 * among the things to flag, and the difference is deliberate. A cap that only flags is a cap
 * that lets the money leave while somebody reads a queue. A refusal costs a legitimate new
 * buyer a wait; a flag costs a seller their card.
 *
 * Geo mismatch is not implemented here and is not pretended to be: it needs the buyer's address
 * from Stripe, which arrives on the payment and therefore after the decision this module makes.
 * It belongs in a review queue on the paid order, which is slice 7's business.
 *
 * ## Every number here is a guess
 *
 * There is no data yet — the marketplace has never taken a real payment. These are starting
 * points chosen to be *generous to an ordinary buyer and awkward for a scripted one*, and they
 * are constants in one file precisely so that the first month of real orders can move them
 * without anybody hunting through routes.
 */

/** How long an account counts as new. A day is long enough to matter and short enough to pass. */
export const NEW_ACCOUNT_HOURS = 24;

/**
 * Most a new account may spend on one order.
 *
 * $150 buys a decent single. It does not buy the kind of card somebody steals a card number
 * for, and a genuine buyer whose first purchase is larger can wait a day or say hello first.
 */
export const NEW_ACCOUNT_MAX_ORDER_CENTS = 15_000;

/** And how many orders it may open in its first day at all. */
export const NEW_ACCOUNT_MAX_ORDERS_PER_DAY = 3;

/**
 * Most orders anybody may open in an hour.
 *
 * Above a per-minute rate limit and below what a person does: buying ten cards in an hour is a
 * good afternoon, and buying an eleventh is a script or a very unusual afternoon. The refusal
 * is temporary and says so.
 */
export const MAX_ORDERS_PER_HOUR = 10;

/**
 * Most listings anybody may create in an hour.
 *
 * Higher, because listing is the thing a real seller does in bulk — photographing and posting
 * thirty cards after a break is an ordinary evening. This is here to bound a scraper
 * republishing somebody else's inventory, not to pace a seller.
 */
export const MAX_LISTINGS_PER_HOUR = 60;

export type FraudRefusal =
  /** A new account trying to spend more than a new account may. */
  | 'new_account_order_too_large'
  /** A new account on its fourth order of the day. */
  | 'new_account_daily_limit'
  /** Anybody, too many orders in an hour. */
  | 'order_velocity'
  /** Anybody, too many listings in an hour. */
  | 'listing_velocity';

export interface PurchaseAttempt {
  /** How long the account has existed, in milliseconds. */
  accountAgeMs: number;
  amountCents: number;
  /** Orders this buyer opened in the last 24 hours, not counting this one. */
  ordersLastDay: number;
  /** And in the last hour. */
  ordersLastHour: number;
}

/**
 * May this purchase go ahead?
 *
 * Returns the reason it may not, or null. Pure and exhaustively testable, which is the point of
 * keeping it out of the route: the rules that decide whether somebody may spend money should be
 * readable in one sitting and provable without a database.
 *
 * Order matters only for which refusal is reported first, and the order chosen reports the most
 * specific thing: "that is too much for a new account" is more useful than "you have bought
 * enough today".
 */
export function checkPurchase(attempt: PurchaseAttempt): FraudRefusal | null {
  const isNew = attempt.accountAgeMs < NEW_ACCOUNT_HOURS * 60 * 60 * 1000;

  if (isNew && attempt.amountCents > NEW_ACCOUNT_MAX_ORDER_CENTS) {
    return 'new_account_order_too_large';
  }
  if (isNew && attempt.ordersLastDay >= NEW_ACCOUNT_MAX_ORDERS_PER_DAY) {
    return 'new_account_daily_limit';
  }
  if (attempt.ordersLastHour >= MAX_ORDERS_PER_HOUR) {
    return 'order_velocity';
  }
  return null;
}

/** May this listing be created? The one rule, kept here so both live together. */
export function checkListing(attempt: { listingsLastHour: number }): FraudRefusal | null {
  return attempt.listingsLastHour >= MAX_LISTINGS_PER_HOUR ? 'listing_velocity' : null;
}

/**
 * What to tell somebody, without telling them where the line is.
 *
 * A refusal that names the threshold is a refusal that tells a fraudster exactly how to stay
 * under it. These say what happened and roughly what to do, and the number is in the audit
 * entry rather than the response.
 */
export function explainRefusal(reason: FraudRefusal): string {
  switch (reason) {
    case 'new_account_order_too_large':
      return 'new accounts are limited to smaller purchases for their first day';
    case 'new_account_daily_limit':
      return 'new accounts are limited to a few purchases on their first day';
    case 'order_velocity':
      return 'that is a lot of purchases in a short time; please try again shortly';
    case 'listing_velocity':
      return 'that is a lot of listings in a short time; please try again shortly';
  }
}
