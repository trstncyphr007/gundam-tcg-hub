/**
 * Holding a new seller's money until the buyer has had a chance to complain (FR-5.6).
 *
 * ## The problem this exists for
 *
 * With Stripe destination charges the transfer to the seller's connected account happens **at
 * payment**. By the time a buyer notices the envelope was empty, the money is already theirs.
 * That is the empty-envelope trade, and it is the cheapest fraud a card marketplace supports.
 *
 * ## What a hold actually is
 *
 * Not a delayed transfer — Stripe has already made it. A hold is a **manual payout schedule**
 * on the connected account: the funds sit in the seller's Stripe balance, visible to them, and
 * are not paid out to their bank until somebody says so.
 *
 * That distinction matters for what we can promise. A held seller can see their money. If they
 * disappear with an unposted card, the refund comes out of a balance that has not left Stripe,
 * which is the whole point. It does **not** make a refund impossible to lose — a seller who has
 * already spent a released payout is a seller we chase — it makes the first few sales safe.
 *
 * ## When the hold lifts
 *
 * Two conditions, both required: enough completed orders, and enough time since the first of
 * them completed. Either alone is gameable. Orders alone lets somebody run three instant
 * self-completing sales; time alone lets an account sit idle for a week and then take one large
 * payment with no history at all.
 *
 * Counted from **completion** rather than from signing up, because a completed order is the
 * thing that means a real buyer received a real card and did not complain within the window.
 */

/** How many completed orders a seller needs before their payouts run themselves. */
export const HOLD_RELEASE_AFTER_ORDERS = 3;

/**
 * And how long since the first of those completed.
 *
 * Seven days is the plan's number and matches the auto-completion window, which is deliberate:
 * an order completes seven days after delivery, so a seller's first completed order is already
 * a week past the buyer receiving it. The hold is therefore about a *fortnight* of real elapsed
 * time from the first sale, which is long enough for a chargeback to start appearing.
 */
export const HOLD_RELEASE_AFTER_DAYS = 7;

export interface HoldStatus {
  /** Completed orders this seller has, ever. */
  completedOrders: number;
  /** When the earliest of them completed, or null if there are none. */
  firstCompletedAt: Date | null;
}

export type HoldDecision =
  | { release: true }
  | { release: false; reason: 'no_completed_orders' | 'too_few_orders' | 'too_soon' };

/**
 * May this seller's payouts start running themselves?
 *
 * Pure, so the rule can be read and proved without Stripe or a database — which matters more
 * here than usual, because getting it wrong in the generous direction means somebody's money
 * leaves before the person who sent it can ask for it back.
 */
export function canReleaseHold(status: HoldStatus, now: Date = new Date()): HoldDecision {
  if (status.firstCompletedAt === null || status.completedOrders === 0) {
    return { release: false, reason: 'no_completed_orders' };
  }
  if (status.completedOrders < HOLD_RELEASE_AFTER_ORDERS) {
    return { release: false, reason: 'too_few_orders' };
  }

  const elapsedMs = now.getTime() - status.firstCompletedAt.getTime();
  if (elapsedMs < HOLD_RELEASE_AFTER_DAYS * 24 * 60 * 60 * 1000) {
    return { release: false, reason: 'too_soon' };
  }
  return { release: true };
}

/**
 * When a seller's hold can next be reconsidered, for showing them something honest.
 *
 * Null when the answer does not depend on time — they simply need more completed sales, and a
 * date would imply the wait is what stands in the way.
 */
export function holdReviewableAt(status: HoldStatus): Date | null {
  if (status.firstCompletedAt === null) return null;
  if (status.completedOrders < HOLD_RELEASE_AFTER_ORDERS) return null;
  return new Date(
    status.firstCompletedAt.getTime() + HOLD_RELEASE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  );
}
