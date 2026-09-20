import { describe, expect, it } from 'vitest';
import { type PricePoint, niceCeiling, splitRuns } from './price-series';

function point(day: string, medianCents = 100): PricePoint {
  return {
    cardVariantId: 'v1',
    finish: 'normal',
    language: 'en',
    condition: 'nm',
    day,
    medianCents,
    p25Cents: medianCents - 10,
    p75Cents: medianCents + 10,
    lowCents: medianCents - 20,
    highCents: medianCents + 20,
    observationCount: 4,
    currency: 'USD',
  };
}

describe('splitting a series at gaps', () => {
  it('keeps consecutive days as one run', () => {
    const runs = splitRuns([point('2026-09-01'), point('2026-09-02'), point('2026-09-03')]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(3);
  });

  it('breaks the line where a day has no published price', () => {
    // The index publishes nothing below three observations. A line drawn across that gap
    // would assert a price we did not have — so the line has to break.
    const runs = splitRuns([point('2026-09-01'), point('2026-09-02'), point('2026-09-05')]);
    expect(runs.map((run) => run.map((p) => p.day))).toEqual([
      ['2026-09-01', '2026-09-02'],
      ['2026-09-05'],
    ]);
  });

  it('handles a series that is all gaps', () => {
    const runs = splitRuns([point('2026-09-01'), point('2026-09-03'), point('2026-09-05')]);
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.length === 1)).toBe(true);
  });

  it('crosses a month boundary without inventing a gap', () => {
    const runs = splitRuns([point('2026-08-31'), point('2026-09-01')]);
    expect(runs).toHaveLength(1);
  });

  it('is empty for an empty series', () => {
    expect(splitRuns([])).toEqual([]);
  });
});

describe('axis ceilings', () => {
  it.each([
    [0, 100],
    [1, 1],
    [95, 100],
    [1250, 2000],
    [9800, 10000],
  ])('rounds %i cents up to %i', (input, expected) => {
    expect(niceCeiling(input)).toBe(expected);
  });

  it('never returns zero, which would divide the whole scale by nothing', () => {
    expect(niceCeiling(0)).toBeGreaterThan(0);
    expect(niceCeiling(-5)).toBeGreaterThan(0);
  });
});
