import { describe, expect, it } from 'vitest';
import {
  MIN_OBSERVATIONS,
  SOURCE_WEIGHTS,
  applySourceWeights,
  isOutlier,
  percentileCents,
  summarisePrices,
  trimCount,
} from './pricing.js';

/** Assert a summary was produced, and narrow the type while doing it. */
function summaryOf(cents: readonly number[]): NonNullable<ReturnType<typeof summarisePrices>> {
  const summary = summarisePrices(cents);
  if (summary === null) throw new Error(`expected a summary for ${JSON.stringify(cents)}`);
  return summary;
}

describe('the minimum-n threshold (FR-3.2, AC-3.1)', () => {
  it('publishes nothing below the threshold', () => {
    expect(summarisePrices([])).toBeNull();
    expect(summarisePrices([1000])).toBeNull();
    expect(summarisePrices([1000, 2000])).toBeNull();
  });

  it('publishes at exactly the threshold', () => {
    expect(summarisePrices([1000, 2000, 3000])?.medianCents).toBe(2000);
  });

  it('the threshold is configurable, for callers that need a stricter bar', () => {
    expect(summarisePrices([1000, 2000, 3000], { minObservations: 5 })).toBeNull();
    expect(MIN_OBSERVATIONS).toBe(3);
  });
});

describe('trimming (FR-3.2)', () => {
  it('does not trim a small sample away', () => {
    // 10% of 3 is 0.3. Dropping one from each end would leave a single value being called
    // a median, which is a different statistic wearing the same name.
    expect(trimCount(3)).toBe(0);
    expect(trimCount(5)).toBe(0);
    expect(trimCount(9)).toBe(0);
  });

  it('starts trimming once the sample can afford it', () => {
    expect(trimCount(10)).toBe(1);
    expect(trimCount(20)).toBe(2);
    expect(trimCount(100)).toBe(10);
  });

  it('never trims everything away', () => {
    for (let n = 3; n < 40; n += 1) {
      expect(n - 2 * trimCount(n)).toBeGreaterThanOrEqual(1);
    }
  });

  it('drops the extremes, so one absurd sale cannot move the index', () => {
    // Same sample size in both, so the only difference is the value itself: replace the
    // top sale with one 500x higher and the median must not care.
    const sane = [900, 950, 980, 1000, 1000, 1010, 1020, 1050, 1080, 1100];
    const withSpike = [...sane.slice(0, 9), 500_000];

    const before = summarisePrices(sane);
    const after = summarisePrices(withSpike);
    expect(after?.medianCents).toBe(before?.medianCents);
    expect(after?.p25Cents).toBe(before?.p25Cents);

    // ...but the spike is still visible in the range, not silently erased.
    expect(after?.highCents).toBe(500_000);
    expect(after?.trimmedCount).toBe(2);
  });

  it('a single absurd sale barely moves the median even when it grows the sample', () => {
    const sane = [900, 950, 980, 1000, 1000, 1010, 1020, 1050, 1100];
    const withSpike = [...sane, 500_000];

    const before = summaryOf(sane).medianCents;
    const after = summaryOf(withSpike).medianCents;
    // It shifts a little, because a tenth observation genuinely changes which values are
    // central. What matters is that it shifts by cents, not toward the spike.
    expect(Math.abs(after - before)).toBeLessThan(50);
    expect(after).toBeLessThan(2000);
  });

  it('counts the full sample, not the trimmed one', () => {
    const summary = summarisePrices(Array.from({ length: 20 }, (_, i) => 1000 + i));
    expect(summary?.count).toBe(20);
    expect(summary?.trimmedCount).toBe(4);
  });
});

describe('percentiles', () => {
  it('interpolates rather than jumping between ranks', () => {
    // Nearest-rank would give 2000 here and lurch as observations arrive.
    expect(percentileCents([1000, 2000, 3000, 4000], 0.25)).toBe(1750);
    expect(percentileCents([1000, 2000, 3000, 4000], 0.5)).toBe(2500);
    expect(percentileCents([1000, 2000, 3000, 4000], 0.75)).toBe(3250);
  });

  it('handles the ends and a single value', () => {
    expect(percentileCents([1000, 2000, 3000], 0)).toBe(1000);
    expect(percentileCents([1000, 2000, 3000], 1)).toBe(3000);
    expect(percentileCents([4200], 0.5)).toBe(4200);
  });

  it('always returns whole cents', () => {
    const result = percentileCents([1, 2], 0.5);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('refuses an empty set or a nonsense percentile', () => {
    expect(() => percentileCents([], 0.5)).toThrow(RangeError);
    expect(() => percentileCents([1], 1.5)).toThrow(RangeError);
    expect(() => percentileCents([1], -0.1)).toThrow(RangeError);
  });

  it('orders p25 <= median <= p75, whatever the input order', () => {
    const shuffled = [4200, 100, 999, 33, 7000, 1234, 88, 4321, 55, 620];
    const s = summaryOf(shuffled);
    expect(s.p25Cents).toBeLessThanOrEqual(s.medianCents);
    expect(s.medianCents).toBeLessThanOrEqual(s.p75Cents);
    expect(s.lowCents).toBe(33);
    expect(s.highCents).toBe(7000);
  });
});

describe('money is integer cents, and stays that way', () => {
  it('rejects a float', () => {
    expect(() => summarisePrices([10.5, 2000, 3000])).toThrow(TypeError);
  });

  it('rejects a negative price', () => {
    expect(() => summarisePrices([-1, 2000, 3000])).toThrow(RangeError);
  });

  it('accepts zero, which is a real price for a bulk common', () => {
    expect(summarisePrices([0, 0, 100])?.medianCents).toBe(0);
  });

  it('every field comes back an integer', () => {
    const s = summaryOf([333, 667, 1001, 1500]);
    for (const [key, value] of Object.entries(s)) {
      expect(Number.isInteger(value), key).toBe(true);
    }
  });
});

describe('outlier flagging (SR-4.4)', () => {
  const summary = { p25Cents: 1000, p75Cents: 2000 }; // IQR 1000

  it('leaves ordinary prices alone', () => {
    expect(isOutlier(1500, summary)).toBe(false);
    expect(isOutlier(900, summary)).toBe(false);
    expect(isOutlier(4000, summary)).toBe(false); // 2000 + 3*1000 -- exactly at the edge
  });

  it('flags a price far outside the spread', () => {
    expect(isOutlier(5001, summary)).toBe(true);
    expect(isOutlier(0, summary)).toBe(false); // 1000 - 3000 is negative; nothing is below
    expect(isOutlier(50_000, summary)).toBe(true);
  });

  it('when every observation agreed, anything different is notable', () => {
    const agreed = { p25Cents: 1000, p75Cents: 1000 };
    expect(isOutlier(1000, agreed)).toBe(false);
    expect(isOutlier(1001, agreed)).toBe(true);
  });

  it('uses the spread, not a mean, so one foil does not blind it', () => {
    // A set of commons with a single expensive card. A mean-and-sigma rule would widen so
    // far that nothing looks odd again; the IQR barely moves.
    const commons = [10, 12, 11, 13, 10, 12, 11, 14, 10, 50_000];
    expect(isOutlier(60_000, summaryOf(commons))).toBe(true);
  });
});

describe('source weighting (FR-3.1)', () => {
  it('trusts what we watched over what we were told', () => {
    expect(SOURCE_WEIGHTS.break_pull).toBeGreaterThan(SOURCE_WEIGHTS.ebay_api);
    expect(SOURCE_WEIGHTS.ebay_api).toBeGreaterThan(SOURCE_WEIGHTS.user_report);
  });

  it('expands to whole observations, so the median stays a real median', () => {
    const expanded = applySourceWeights([
      { cents: 100, source: 'break_pull' },
      { cents: 200, source: 'user_report' },
    ]);
    expect(expanded).toHaveLength(SOURCE_WEIGHTS.break_pull + SOURCE_WEIGHTS.user_report);
    expect(expanded.filter((c) => c === 100)).toHaveLength(3);
    expect(expanded.filter((c) => c === 200)).toHaveLength(1);
  });

  it('a crowd of unverified reports cannot outvote our own logs outright', () => {
    // Three user reports claiming a card is worth a fortune, against two we recorded.
    const weighted = applySourceWeights([
      { cents: 1000, source: 'break_pull' },
      { cents: 1000, source: 'break_pull' },
      { cents: 99_000, source: 'user_report' },
      { cents: 99_000, source: 'user_report' },
      { cents: 99_000, source: 'user_report' },
    ]);
    // 6 observations at 1000 vs 3 at 99000: the median stays honest.
    expect(summarisePrices(weighted)?.medianCents).toBe(1000);
  });

  it('every source has a weight, so none is silently ignored', () => {
    for (const [source, weight] of Object.entries(SOURCE_WEIGHTS)) {
      expect(weight, source).toBeGreaterThan(0);
      expect(Number.isInteger(weight), source).toBe(true);
    }
  });
});
