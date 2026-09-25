import { describe, expect, it } from 'vitest';
import {
  MAX_LISTINGS_PER_HOUR,
  MAX_ORDERS_PER_HOUR,
  NEW_ACCOUNT_HOURS,
  NEW_ACCOUNT_MAX_ORDER_CENTS,
  NEW_ACCOUNT_MAX_ORDERS_PER_DAY,
  checkListing,
  checkPurchase,
  explainRefusal,
} from './fraud.js';

/**
 * The rules that decide whether somebody may spend money (SR-5.6).
 *
 * Pure, so they can be proved exhaustively without a database — which is the whole reason they
 * live here rather than inside a route. A rule about fraud that can only be exercised by
 * standing up Postgres is a rule nobody re-reads.
 */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const established = { accountAgeMs: 30 * DAY, ordersLastDay: 0, ordersLastHour: 0 };

describe('an ordinary purchase', () => {
  it('is allowed', () => {
    expect(checkPurchase({ ...established, amountCents: 2000 })).toBeNull();
  });

  it('is allowed even when it is expensive, for an established account', () => {
    // The cap is about *new* accounts. Somebody who has been here a month buying a $400 card
    // is the customer this marketplace exists for.
    expect(checkPurchase({ ...established, amountCents: 40_000 })).toBeNull();
  });
});

describe('a new account', () => {
  const fresh = { accountAgeMs: 10 * 60 * 1000, ordersLastDay: 0, ordersLastHour: 0 };

  it('may buy something small', () => {
    expect(checkPurchase({ ...fresh, amountCents: 2000 })).toBeNull();
  });

  it('may not buy something large', () => {
    /**
     * The pattern this exists for: an account created minutes ago going straight for the most
     * expensive thing it can find. No per-minute rate limit notices that, because one purchase
     * is not fast.
     */
    expect(checkPurchase({ ...fresh, amountCents: NEW_ACCOUNT_MAX_ORDER_CENTS + 1 })).toBe(
      'new_account_order_too_large',
    );
  });

  it('may buy exactly the limit', () => {
    // The boundary, so nobody has to guess whether the comparison is strict.
    expect(checkPurchase({ ...fresh, amountCents: NEW_ACCOUNT_MAX_ORDER_CENTS })).toBeNull();
  });

  it('may not open a fourth order on its first day', () => {
    expect(
      checkPurchase({
        ...fresh,
        amountCents: 1000,
        ordersLastDay: NEW_ACCOUNT_MAX_ORDERS_PER_DAY,
      }),
    ).toBe('new_account_daily_limit');
  });

  it('may open its third', () => {
    expect(
      checkPurchase({
        ...fresh,
        amountCents: 1000,
        ordersLastDay: NEW_ACCOUNT_MAX_ORDERS_PER_DAY - 1,
      }),
    ).toBeNull();
  });

  it('stops being new after a day', () => {
    const justOld = {
      accountAgeMs: NEW_ACCOUNT_HOURS * HOUR + 1,
      ordersLastDay: NEW_ACCOUNT_MAX_ORDERS_PER_DAY,
      ordersLastHour: 0,
      amountCents: NEW_ACCOUNT_MAX_ORDER_CENTS + 1,
    };
    // Both new-account rules stop applying at once, which is what "new" meaning one thing gets
    // you.
    expect(checkPurchase(justOld)).toBeNull();
  });

  it('is still new one millisecond before the day is up', () => {
    expect(
      checkPurchase({
        accountAgeMs: NEW_ACCOUNT_HOURS * HOUR - 1,
        ordersLastDay: 0,
        ordersLastHour: 0,
        amountCents: NEW_ACCOUNT_MAX_ORDER_CENTS + 1,
      }),
    ).toBe('new_account_order_too_large');
  });

  it('reports the size problem before the count problem', () => {
    // The more specific refusal is the more useful one: "that is too much for a new account"
    // tells somebody what to do, where "you have bought enough today" does not.
    expect(
      checkPurchase({
        ...fresh,
        amountCents: NEW_ACCOUNT_MAX_ORDER_CENTS + 1,
        ordersLastDay: NEW_ACCOUNT_MAX_ORDERS_PER_DAY,
      }),
    ).toBe('new_account_order_too_large');
  });
});

describe('velocity, for anybody', () => {
  it('allows a busy afternoon', () => {
    expect(
      checkPurchase({ ...established, amountCents: 2000, ordersLastHour: MAX_ORDERS_PER_HOUR - 1 }),
    ).toBeNull();
  });

  it('refuses the eleventh order in an hour', () => {
    expect(
      checkPurchase({ ...established, amountCents: 2000, ordersLastHour: MAX_ORDERS_PER_HOUR }),
    ).toBe('order_velocity');
  });

  it('applies to established accounts too', () => {
    // Velocity is about the behaviour, not the account. A long-standing account that starts
    // buying forty things an hour has either been taken over or is a script.
    expect(
      checkPurchase({
        accountAgeMs: 5 * 365 * DAY,
        amountCents: 100,
        ordersLastDay: 40,
        ordersLastHour: 40,
      }),
    ).toBe('order_velocity');
  });

  it('bounds listings more generously than orders', () => {
    /**
     * Listing is the thing a real seller does in bulk — photographing and posting thirty cards
     * after a break is an ordinary evening. This bounds a scraper republishing somebody else's
     * inventory, not a seller at work.
     */
    expect(checkListing({ listingsLastHour: MAX_LISTINGS_PER_HOUR - 1 })).toBeNull();
    expect(checkListing({ listingsLastHour: MAX_LISTINGS_PER_HOUR })).toBe('listing_velocity');
    expect(MAX_LISTINGS_PER_HOUR).toBeGreaterThan(MAX_ORDERS_PER_HOUR);
  });
});

describe('what a refused person is told', () => {
  it('never names the threshold', () => {
    /**
     * A refusal that names the limit tells a fraudster exactly how to stay under it. The
     * number belongs in the audit entry, where the people who set it can read it.
     */
    const thresholds = [
      String(NEW_ACCOUNT_MAX_ORDER_CENTS),
      String(NEW_ACCOUNT_MAX_ORDERS_PER_DAY),
      String(MAX_ORDERS_PER_HOUR),
      String(MAX_LISTINGS_PER_HOUR),
      String(NEW_ACCOUNT_HOURS),
    ];

    for (const reason of [
      'new_account_order_too_large',
      'new_account_daily_limit',
      'order_velocity',
      'listing_velocity',
    ] as const) {
      const message = explainRefusal(reason);
      expect(message.length).toBeGreaterThan(0);
      for (const threshold of thresholds) {
        expect(message, `"${message}" names ${threshold}`).not.toContain(threshold);
      }
    }
  });

  it('says something for every reason there is', () => {
    // A refusal with no message is a 403 with an empty body, which tells somebody nothing and
    // generates a support email.
    for (const reason of [
      'new_account_order_too_large',
      'new_account_daily_limit',
      'order_velocity',
      'listing_velocity',
    ] as const) {
      expect(explainRefusal(reason)).toMatch(/[a-z]/u);
    }
  });
});
