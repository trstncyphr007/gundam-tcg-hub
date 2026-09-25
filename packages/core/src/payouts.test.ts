import { describe, expect, it } from 'vitest';
import {
  HOLD_RELEASE_AFTER_DAYS,
  HOLD_RELEASE_AFTER_ORDERS,
  canReleaseHold,
  holdReviewableAt,
} from './payouts.js';

/**
 * When a new seller's money stops being held (FR-5.6).
 *
 * Pure, and that matters more here than usual: getting this wrong in the generous direction
 * means somebody's money leaves before the person who sent it can ask for it back.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-25T12:00:00Z');
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

describe('a seller who has not sold anything', () => {
  it('stays held', () => {
    expect(canReleaseHold({ completedOrders: 0, firstCompletedAt: null }, NOW)).toEqual({
      release: false,
      reason: 'no_completed_orders',
    });
  });

  it('stays held even if a date somehow arrives without a count', () => {
    // Defensive, and reachable: a completed order that was later refunded leaves a date behind
    // and takes the count with it.
    expect(canReleaseHold({ completedOrders: 0, firstCompletedAt: ago(90) }, NOW).release).toBe(
      false,
    );
  });
});

describe('the two conditions, each alone', () => {
  it('refuses enough orders too recently', () => {
    /**
     * Orders alone would let somebody run three instant self-completing sales and walk away
     * with the balance.
     */
    expect(
      canReleaseHold({ completedOrders: HOLD_RELEASE_AFTER_ORDERS, firstCompletedAt: ago(1) }, NOW),
    ).toEqual({ release: false, reason: 'too_soon' });
  });

  it('refuses enough time with too few orders', () => {
    // Time alone would let an account sit idle for a week and then take one large payment with
    // no history at all.
    expect(
      canReleaseHold(
        { completedOrders: HOLD_RELEASE_AFTER_ORDERS - 1, firstCompletedAt: ago(365) },
        NOW,
      ),
    ).toEqual({ release: false, reason: 'too_few_orders' });
  });

  it('releases when both are satisfied', () => {
    expect(
      canReleaseHold(
        {
          completedOrders: HOLD_RELEASE_AFTER_ORDERS,
          firstCompletedAt: ago(HOLD_RELEASE_AFTER_DAYS + 1),
        },
        NOW,
      ),
    ).toEqual({ release: true });
  });
});

describe('the boundary', () => {
  it('releases at exactly the window', () => {
    expect(
      canReleaseHold(
        {
          completedOrders: HOLD_RELEASE_AFTER_ORDERS,
          firstCompletedAt: ago(HOLD_RELEASE_AFTER_DAYS),
        },
        NOW,
      ).release,
    ).toBe(true);
  });

  it('does not release one millisecond early', () => {
    const justShort = new Date(NOW.getTime() - HOLD_RELEASE_AFTER_DAYS * DAY + 1);
    expect(
      canReleaseHold(
        { completedOrders: HOLD_RELEASE_AFTER_ORDERS, firstCompletedAt: justShort },
        NOW,
      ).release,
    ).toBe(false);
  });

  it('reports the count problem before the time problem', () => {
    // More useful: "you need another sale" is something a seller can act on, where "wait" when
    // waiting is not the obstacle is misleading.
    expect(canReleaseHold({ completedOrders: 1, firstCompletedAt: ago(1) }, NOW).release).toBe(
      false,
    );
    expect(canReleaseHold({ completedOrders: 1, firstCompletedAt: ago(1) }, NOW)).toEqual({
      release: false,
      reason: 'too_few_orders',
    });
  });
});

describe('what a held seller can be told', () => {
  it('gives a date once waiting is the only thing left', () => {
    const first = ago(2);
    expect(
      holdReviewableAt({ completedOrders: HOLD_RELEASE_AFTER_ORDERS, firstCompletedAt: first }),
    ).toEqual(new Date(first.getTime() + HOLD_RELEASE_AFTER_DAYS * DAY));
  });

  it('gives no date when the obstacle is the number of sales', () => {
    /**
     * A date here would imply the wait is what stands in the way, and a seller who waits will
     * find nothing has changed. "You need more completed sales" is the honest answer, and the
     * absence of a date is how the caller knows to say it.
     */
    expect(holdReviewableAt({ completedOrders: 1, firstCompletedAt: ago(1) })).toBeNull();
    expect(holdReviewableAt({ completedOrders: 0, firstCompletedAt: null })).toBeNull();
  });
});

describe('the numbers themselves', () => {
  it('waits at least as long as an order takes to complete', () => {
    /**
     * An order auto-completes seven days after delivery, so a seller's first completed order is
     * already a week past the buyer receiving it. Holding for the same window again means the
     * real elapsed time from the first sale is a fortnight — long enough for a chargeback to
     * start appearing.
     *
     * If somebody shortens the auto-completion window without thinking about this, the hold
     * silently becomes shorter too. This assertion is where they find out.
     */
    expect(HOLD_RELEASE_AFTER_DAYS).toBeGreaterThanOrEqual(7);
    expect(HOLD_RELEASE_AFTER_ORDERS).toBeGreaterThan(1);
  });
});
