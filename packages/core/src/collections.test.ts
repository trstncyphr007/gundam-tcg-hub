import { describe, expect, it } from 'vitest';
import {
  collectionCsvRowSchema,
  formatCentsAsAmount,
  parseMoneyToCents,
  validateCollectionCsvHeader,
} from './collections.js';

describe('money parsing (FR-3.5)', () => {
  it.each([
    ['12.50', 1250],
    ['12.5', 1250],
    ['12', 1200],
    ['0.01', 1],
    ['0', 0],
    ['$12.50', 1250],
    ['1,299.99', 129999],
  ])('reads %j as %i cents', (input, expected) => {
    expect(parseMoneyToCents(input)).toBe(expected);
  });

  it('never goes through a float', () => {
    // 12.50 * 100 is 1250.0000000000002 in IEEE 754. A cost basis off by a hundredth of a
    // cent is a cost basis that will not reconcile against a receipt.
    expect(parseMoneyToCents('12.50')).toBe(1250);
    expect(Number.isInteger(parseMoneyToCents('0.29'))).toBe(true);
    expect(parseMoneyToCents('1.15')).toBe(115);
  });

  it.each([['', 'abc', '1.234', '-5', '1e3', '12.', '.5', '1 2']])(
    'refuses what it cannot read: %j',
    (input) => {
      expect(parseMoneyToCents(input)).toBeNull();
    },
  );

  it('round-trips through the formatter', () => {
    for (const cents of [0, 1, 99, 100, 1250, 129999]) {
      expect(parseMoneyToCents(formatCentsAsAmount(cents))).toBe(cents);
    }
  });

  it('pads the cents so 1.5 is not fifteen cents', () => {
    expect(formatCentsAsAmount(1250)).toBe('12.50');
    expect(formatCentsAsAmount(5)).toBe('0.05');
  });
});

describe('the CSV header (FR-3.5)', () => {
  it('accepts the documented columns', () => {
    expect(validateCollectionCsvHeader(['set', 'number', 'quantity'])).toEqual([]);
    expect(
      validateCollectionCsvHeader(['set', 'number', 'quantity', 'condition', 'acquired_price']),
    ).toEqual([]);
  });

  it('names a missing required column', () => {
    expect(validateCollectionCsvHeader(['set', 'number'])).toEqual([
      'missing required column "quantity"',
    ]);
  });

  it('rejects an unknown column rather than ignoring it', () => {
    // "qty" silently ignored would import every card as quantity 1.
    const problems = validateCollectionCsvHeader(['set', 'number', 'qty']);
    expect(problems).toContain('unknown column "qty"');
    expect(problems).toContain('missing required column "quantity"');
  });

  it('rejects a duplicated column', () => {
    expect(validateCollectionCsvHeader(['set', 'number', 'quantity', 'quantity'])).toEqual([
      'duplicate column "quantity"',
    ]);
  });
});

describe('the CSV row schema (SR-3.4)', () => {
  const minimal = { set: 'SAMPLE-01', number: '001', quantity: '2' };

  it('accepts a minimal row and leaves the optional fields undefined', () => {
    const parsed = collectionCsvRowSchema.parse(minimal);
    expect(parsed.quantity).toBe(2);
    expect(parsed.condition).toBeUndefined();
    expect(parsed.acquired_price).toBeUndefined();
  });

  it('treats an empty cell as "not given", not as zero', () => {
    // The difference matters: a cost basis of zero reports the card as pure profit.
    const parsed = collectionCsvRowSchema.parse({ ...minimal, acquired_price: '' });
    expect(parsed.acquired_price).toBeUndefined();
  });

  it('converts a written price to cents', () => {
    expect(
      collectionCsvRowSchema.parse({ ...minimal, acquired_price: '12.50' }).acquired_price,
    ).toBe(1250);
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc'], ['']])('rejects quantity %j', (quantity) => {
    expect(collectionCsvRowSchema.safeParse({ ...minimal, quantity }).success).toBe(false);
  });

  it('rejects an unknown column on the row too, not only in the header', () => {
    expect(collectionCsvRowSchema.safeParse({ ...minimal, sneaky: 'x' }).success).toBe(false);
  });

  it('rejects a condition that is not a grade', () => {
    expect(collectionCsvRowSchema.safeParse({ ...minimal, condition: 'mint' }).success).toBe(false);
    expect(collectionCsvRowSchema.parse({ ...minimal, condition: 'lp' }).condition).toBe('lp');
  });

  it('normalises a currency to upper case and rejects a non-code', () => {
    expect(collectionCsvRowSchema.parse({ ...minimal, currency: 'usd' }).currency).toBe('USD');
    expect(collectionCsvRowSchema.safeParse({ ...minimal, currency: 'dollars' }).success).toBe(
      false,
    );
  });

  it('reads a date as UTC midnight, so a timezone cannot move it a day', () => {
    const parsed = collectionCsvRowSchema.parse({ ...minimal, acquired_at: '2026-03-04' });
    expect(parsed.acquired_at?.toISOString()).toBe('2026-03-04T00:00:00.000Z');
  });

  it('keeps a formula payload as text, because neutralising happens on export', () => {
    const payload = `=cmd|'/c calc'!A1`;
    expect(collectionCsvRowSchema.parse({ ...minimal, notes: payload }).notes).toBe(payload);
  });

  it('caps notes rather than truncating them silently', () => {
    expect(collectionCsvRowSchema.safeParse({ ...minimal, notes: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });
});
