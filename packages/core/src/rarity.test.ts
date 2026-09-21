import { describe, expect, it } from 'vitest';
import {
  HANDLE_PATTERN,
  MIN_EXPECTED_HITS,
  MIN_PACKS_FOR_ODDS,
  compareRarities,
  compareToOdds,
  isValidHandle,
  normalQuantile,
  ratePerPack,
  wilsonInterval,
  zFor,
} from './rarity.js';

describe('normalQuantile', () => {
  // Known answers from standard tables. These pin the approximation: a coefficient typo
  // would move the confidence level silently, and every verdict on a profile page with it.
  it.each([
    [0.5, 0],
    [0.975, 1.959964],
    [0.995, 2.575829],
    [0.999, 3.090232],
    [0.9999, 3.719016],
    [0.025, -1.959964],
    [0.01, -2.326348],
  ])('z(%f) = %f', (p, expected) => {
    expect(normalQuantile(p)).toBeCloseTo(expected, 5);
  });

  it('is symmetric about the median', () => {
    for (const p of [0.6, 0.8, 0.9, 0.97, 0.999]) {
      expect(normalQuantile(p)).toBeCloseTo(-normalQuantile(1 - p), 8);
    }
  });

  it('rejects probabilities outside the open interval', () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
    expect(() => normalQuantile(-0.1)).toThrow(RangeError);
  });
});

describe('zFor', () => {
  it('is the familiar 1.96 for a single comparison at 95%', () => {
    expect(zFor(0.95, 1)).toBeCloseTo(1.959964, 5);
  });

  it('widens as more rarities are tested at once', () => {
    const one = zFor(0.95, 1);
    const six = zFor(0.95, 6);
    expect(six).toBeGreaterThan(one);
    // Šidák at k=6: per-test alpha 1 - 0.95^(1/6) = 0.008509, two-sided.
    expect(six).toBeCloseTo(2.631038, 5);
  });

  it('rejects a fractional number of comparisons', () => {
    expect(() => zFor(0.95, 1.5)).toThrow(RangeError);
    expect(() => zFor(0.95, 0)).toThrow(RangeError);
  });
});

describe('wilsonInterval', () => {
  it('matches the published worked example (52 of 100 at 95%)', () => {
    const { low, high } = wilsonInterval(52, 100, 1.959964);
    expect(low).toBeCloseTo(0.42317, 5);
    expect(high).toBeCloseTo(0.61535, 5);
  });

  it('gives a usable upper bound at zero successes, where Wald gives none', () => {
    const { low, high } = wilsonInterval(0, 30, 1.959964);
    expect(low).toBe(0);
    // The whole reason for choosing Wilson: 30 packs with no hits does not prove the rate
    // is zero, and the interval has to say so.
    expect(high).toBeCloseTo(0.11351, 5);
  });

  it('stays inside 0..1 at the extremes', () => {
    const all = wilsonInterval(40, 40, 2.6);
    expect(all.high).toBe(1);
    expect(all.low).toBeGreaterThan(0);
  });

  it('narrows as the sample grows', () => {
    const small = wilsonInterval(5, 50, 1.96);
    const large = wilsonInterval(50, 500, 1.96);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('refuses more successes than trials', () => {
    expect(() => wilsonInterval(11, 10, 1.96)).toThrow(RangeError);
  });
});

describe('ratePerPack', () => {
  it('keeps published odds exact', () => {
    expect(ratePerPack({ numerator: 1, denominator: 12 })).toBe(1 / 12);
    expect(ratePerPack(null)).toBeNull();
  });

  it('rejects a rate that is not a ratio of integers', () => {
    expect(() => ratePerPack({ numerator: 1.5, denominator: 12 })).toThrow(TypeError);
    expect(() => ratePerPack({ numerator: 1, denominator: 0 })).toThrow(RangeError);
  });
});

describe('compareToOdds', () => {
  const published = { numerator: 1, denominator: 12 };

  it('says nothing when no odds are published', () => {
    const result = compareToOdds({ rarity: 'SR', hits: 9, packs: 100, published: null });
    expect(result.verdict).toBe('unpublished');
    expect(result.lowRate).toBeNull();
    // The observed rate is still reported: it is a fact about the log either way.
    expect(result.observedRate).toBeCloseTo(0.09, 6);
  });

  it('refuses to judge below the pack floor', () => {
    const result = compareToOdds({
      rarity: 'SR',
      hits: 0,
      packs: MIN_PACKS_FOR_ODDS - 1,
      published,
    });
    expect(result.verdict).toBe('insufficient');
  });

  it('refuses to judge when too few hits were ever expected', () => {
    // 100 packs at 1-in-72 expects 1.4 hits. Enough packs, nowhere near enough evidence.
    const rare = { numerator: 1, denominator: 72 };
    const result = compareToOdds({ rarity: 'SEC', hits: 0, packs: 100, published: rare });
    expect(100 * (1 / 72)).toBeLessThan(MIN_EXPECTED_HITS);
    expect(result.verdict).toBe('insufficient');
  });

  it('calls an on-odds sample consistent', () => {
    const result = compareToOdds({ rarity: 'SR', hits: 10, packs: 120, published });
    expect(result.verdict).toBe('consistent');
    expect(result.publishedRate).toBeCloseTo(1 / 12, 6);
    expect(result.lowRate).not.toBeNull();
  });

  it('does not cry foul on an ordinary unlucky run', () => {
    // 120 packs, 6 hits against an expected 10. Visibly unlucky, nowhere near significant —
    // and this is the case that would otherwise put an accusation on someone's profile.
    const result = compareToOdds({ rarity: 'SR', hits: 6, packs: 120, published });
    expect(result.verdict).toBe('consistent');
  });

  it('reports below only when the published rate clears the interval', () => {
    const result = compareToOdds({ rarity: 'SR', hits: 2, packs: 600, published });
    expect(result.verdict).toBe('below');
    expect(result.highRate).toBeLessThan(1 / 12);
  });

  it('reports above for a sample well past the published rate', () => {
    const result = compareToOdds({ rarity: 'SR', hits: 120, packs: 600, published });
    expect(result.verdict).toBe('above');
    expect(result.lowRate).toBeGreaterThan(1 / 12);
  });

  it('declines when a pack can evidently hold more than one hit', () => {
    const result = compareToOdds({ rarity: 'C', hits: 500, packs: 100, published });
    expect(result.verdict).toBe('not_comparable');
    expect(result.lowRate).toBeNull();
  });

  it('is harder to trip with more comparisons in play', () => {
    // 33 hits in 600 packs against an expected 50. Significant on its own; not once you
    // remember that seven other rarities were checked on the same page.
    const alone = compareToOdds({ rarity: 'SR', hits: 33, packs: 600, published, comparisons: 1 });
    const among = compareToOdds({ rarity: 'SR', hits: 33, packs: 600, published, comparisons: 8 });
    expect(alone.verdict).toBe('below');
    expect(among.verdict).toBe('consistent');
  });
});

describe('compareRarities', () => {
  it('counts only comparable rarities towards the adjustment', () => {
    const rows = [
      { rarity: 'SR', hits: 33, packs: 600, published: { numerator: 1, denominator: 12 } },
      { rarity: 'R', hits: 40, packs: 600, published: null },
      { rarity: 'U', hits: 40, packs: 600, published: null },
    ];
    // One real test, so the adjustment must not weaken it towards three.
    const [sr] = compareRarities(rows);
    expect(sr?.verdict).toBe('below');
  });

  it('adjusts for every rarity that does have odds', () => {
    const published = { numerator: 1, denominator: 12 };
    const rows = Array.from({ length: 8 }, (_, i) => ({
      rarity: `R${String(i)}`,
      hits: 33,
      packs: 600,
      published,
    }));
    expect(compareRarities(rows).every((r) => r.verdict === 'consistent')).toBe(true);
  });

  it('returns one row per rarity, in order', () => {
    const rows = [
      { rarity: 'C', hits: 1, packs: 10, published: null },
      { rarity: 'SR', hits: 1, packs: 10, published: null },
    ];
    expect(compareRarities(rows).map((r) => r.rarity)).toEqual(['C', 'SR']);
  });
});

describe('handles', () => {
  it.each(['trstn', 'gundam-with-trstn', 'ab1', 'x'.repeat(32)])('accepts %s', (handle) => {
    expect(HANDLE_PATTERN.test(handle)).toBe(true);
  });

  it.each(['-lead', 'trail-', 'Upper', 'has space', 'a', 'ab', 'x'.repeat(33), 'em🙂ji'])(
    'rejects %s',
    (handle) => {
      expect(HANDLE_PATTERN.test(handle)).toBe(false);
    },
  );

  it('refuses handles that would read as official or shadow a route', () => {
    expect(isValidHandle('admin')).toBe(false);
    expect(isValidHandle('official')).toBe(false);
    expect(isValidHandle('methodology')).toBe(false);
    expect(isValidHandle('trstn')).toBe(true);
  });
});
