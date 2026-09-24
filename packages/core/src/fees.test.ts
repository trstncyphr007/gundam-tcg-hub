import { describe, expect, it } from 'vitest';
import { FeeError, applicationFeeCents, sellerProceedsCents } from './fees.js';

/**
 * The platform's cut (FR-5.3).
 *
 * Money maths, so the tests are about the edges rather than the happy case: the rounding rule,
 * the impossible inputs, and the invariant that a seller is never worse off than zero.
 */
describe('what we keep', () => {
  it.each([
    [10_000, 500, 500], // $100 at 5% → $5
    [2500, 500, 125], // $25 at 5% → $1.25, exact
    [100, 500, 5],
    [0, 500, 0],
    [10_000, 0, 0], // a waived fee is just zero
  ])('takes %d cents at %d bps as %d', (amount, bps, expected) => {
    expect(applicationFeeCents(amount, bps)).toBe(expected);
  });

  it('rounds a half cent away from zero, on purpose', () => {
    // 150 cents at 5% is exactly 7.5. Rounding is a choice and this one favours us by half a
    // cent on ties; it is written down rather than discovered from a total.
    expect(applicationFeeCents(150, 500)).toBe(8);
    // And a hair under a half rounds down, so it really is nearest rather than always up.
    expect(applicationFeeCents(149, 500)).toBe(7);
  });

  it('multiplies before it divides', () => {
    // Dividing first rounds the rate itself and loses the pennies the rate describes: at 1
    // basis point, `round(1/10000) * amount` is zero for every amount there is.
    expect(applicationFeeCents(1_000_000, 1)).toBe(100);
  });

  it('never exceeds the sale, whatever it is asked', () => {
    // Belt and braces with the database CHECK. A fee larger than the sale is not a rounding
    // question, it is a sign error, and it takes money from a seller.
    expect(applicationFeeCents(1000, 10_000)).toBe(1000);
    expect(applicationFeeCents(1, 10_000)).toBe(1);
  });

  it.each([
    [-1, 500, 'a negative sale'],
    [10.5, 500, 'half a cent'],
    [1000, -1, 'a negative fee'],
    [1000, 10_001, 'more than the whole thing'],
    [1000, 5.5, 'fractional basis points'],
  ])('refuses %d at %d bps (%s)', (amount, bps) => {
    expect(() => applicationFeeCents(amount, bps)).toThrow(FeeError);
  });
});

describe('what the seller gets', () => {
  it('is the rest of it', () => {
    expect(sellerProceedsCents(10_000, 500)).toBe(9500);
  });

  it('is never negative, for any input the fee accepts', () => {
    // The property that matters: whatever rounding does, a seller is not left owing us money.
    for (const amount of [0, 1, 7, 99, 100, 2500, 999_999]) {
      for (const bps of [0, 1, 250, 500, 9999, 10_000]) {
        expect(
          sellerProceedsCents(amount, bps),
          `${String(amount)}@${String(bps)}`,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('plus the fee is always exactly the sale', () => {
    // No cent is invented and none goes missing. The two numbers have to add up, because
    // Stripe moves both of them.
    for (const amount of [1, 7, 99, 150, 2500, 33_333]) {
      for (const bps of [0, 1, 333, 500, 10_000]) {
        expect(
          applicationFeeCents(amount, bps) + sellerProceedsCents(amount, bps),
          `${String(amount)}@${String(bps)}`,
        ).toBe(amount);
      }
    }
  });
});
