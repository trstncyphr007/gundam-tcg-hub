import { describe, expect, it } from 'vitest';
import { centsFromInput, dollars, signedDollars, totalsByCurrency } from './money';

/**
 * The one place money becomes a string (FR-2.1, FR-4.1).
 *
 * This module's own opening line is "one function, shared, because two places formatting money
 * slightly differently is how a total stops matching the rows it is a total of" — and five
 * pages had their own copy anyway, none of which knew what a currency was. It also had no
 * tests, which is how a formatter with a currency argument nobody passed went unnoticed.
 */
describe('showing an amount', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [99, '$0.99'],
    [100, '$1.00'],
    [1250, '$12.50'],
    [100_000_000, '$1000000.00'],
  ])('%d cents is %s', (cents, expected) => {
    expect(dollars(cents)).toBe(expected);
  });

  it('puts the sign before the symbol, not inside the number', () => {
    expect(dollars(-1250)).toBe('-$12.50');
    expect(dollars(-5)).toBe('-$0.05');
  });

  it('does not pretend another currency is dollars', () => {
    // The whole reason this argument exists, and the bug the local copies had: `live_sales`
    // stores a currency and five pages printed a dollar sign over whatever it said.
    expect(dollars(1250, 'CAD')).toBe('12.50 CAD');
    expect(dollars(-1250, 'EUR')).toBe('-12.50 EUR');
  });

  it('stays readable if a fractional value ever reaches it', () => {
    // Integer cents is the contract. Without the rounding this returns "$0.12.5", because the
    // remainder is pasted on as text rather than divided.
    expect(dollars(12.5)).toBe('$0.13');
    expect(dollars(1250.4)).toBe('$12.50');
  });
});

describe('showing a gain or a loss', () => {
  it('marks a gain, because the sign is the point', () => {
    expect(signedDollars(1250)).toBe('+$12.50');
    expect(signedDollars(-1250)).toBe('-$12.50');
  });

  it('leaves nothing unmarked', () => {
    // "+$0.00" reads as a gain that rounded away; "$0.00" reads as no change, which is true.
    expect(signedDollars(0)).toBe('$0.00');
  });

  it('carries the currency through', () => {
    expect(signedDollars(1250, 'CAD')).toBe('+12.50 CAD');
  });
});

describe('adding up what sold', () => {
  it('keeps each currency to itself', () => {
    // Adding CAD to USD gives a number that is not money. The live-sale logger did exactly
    // that and printed the result with a dollar sign.
    expect(
      totalsByCurrency([
        { priceCents: 1000, currency: 'USD' },
        { priceCents: 500, currency: 'CAD' },
        { priceCents: 250, currency: 'USD' },
      ]),
    ).toEqual([
      { currency: 'USD', cents: 1250 },
      { currency: 'CAD', cents: 500 },
    ]);
  });

  it('is one row in the ordinary case', () => {
    expect(
      totalsByCurrency([
        { priceCents: 1000, currency: 'USD' },
        { priceCents: 250, currency: 'USD' },
      ]),
    ).toEqual([{ currency: 'USD', cents: 1250 }]);
  });

  it('has nothing to say about nothing', () => {
    expect(totalsByCurrency([])).toEqual([]);
  });
});

describe('reading an amount somebody typed', () => {
  it.each([
    ['12.50', 1250],
    ['12.5', 1250],
    ['12', 1200],
    ['0.05', 5],
    ['$1,234.56', 123_456],
    ['  12.50  ', 1250],
    ['0012', 1200],
  ])('reads %s as %d cents', (input, expected) => {
    expect(centsFromInput(input)).toBe(expected);
  });

  it('never lets a float hold the amount', () => {
    // `Math.round(Number('12.50') * 100)` is the usual shortcut and it is wrong:
    // 12.50 * 100 is 1250.0000000000002. This reads the digits instead.
    expect(centsFromInput('12.50')).toBe(1250);
    expect(centsFromInput('1.15')).toBe(115);
    expect(centsFromInput('8.005'.slice(0, 4))).toBe(800);
  });

  it.each([
    ['', 'empty'],
    ['abc', 'not a number'],
    ['1.2.3', 'two points'],
    ['12.', 'a point with nothing after it'],
    ['.50', 'no whole part'],
    ['-5', 'negative'],
    ['1e3', 'exponent'],
    ['12.345', 'more than cents'],
    ['1234567890', 'ten digits'],
  ])('refuses %s (%s)', (input) => {
    // null rather than 0, so the caller can say which field was wrong instead of quietly
    // storing nothing.
    expect(centsFromInput(input)).toBeNull();
  });
});
