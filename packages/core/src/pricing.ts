/**
 * Price index maths (plan FR-3.2).
 *
 * The index is the part of this project that has to be *defensible*. It is published, it is
 * what people will argue with, and Phase 5 eventually prices real money against it. So the
 * rules are deliberately dull and written down at `/methodology`:
 *
 *  - a **trimmed median**, dropping the top and bottom 10% before taking the middle
 *  - p25 / p75 alongside it, so the spread is visible rather than hidden behind one number
 *  - a minimum number of observations, below which we publish **nothing** instead of a
 *    number we would not defend
 *
 * Everything here is integer cents. A float that has been through a median and a percentile
 * is a float nobody can reconcile against a receipt.
 */

/** Below this many observations the index says "insufficient data" rather than guessing. */
export const MIN_OBSERVATIONS = 3;

/** Fraction removed from each end before the median. 10% per the plan. */
export const TRIM_FRACTION = 0.1;

export interface PriceSummary {
  /** Trimmed median, integer cents. */
  medianCents: number;
  p25Cents: number;
  p75Cents: number;
  /** How many observations went in, *before* trimming. */
  count: number;
  /** How many were dropped as outliers by the trim. */
  trimmedCount: number;
  lowCents: number;
  highCents: number;
}

/**
 * How many to drop from each end.
 *
 * Deliberately `floor`: with 3 observations, 10% of 3 is 0.3, and dropping 1 from each end
 * would leave a single value being called a median. Trimming only starts to bite at 10
 * observations, which is the point -- a trim that discards most of a small sample is not a
 * trim, it is a different statistic.
 */
export function trimCount(n: number, fraction = TRIM_FRACTION): number {
  if (n <= 2) return 0;
  const perEnd = Math.floor(n * fraction);
  // Never trim so hard that nothing is left.
  return Math.min(perEnd, Math.floor((n - 1) / 2));
}

/**
 * Linear-interpolated percentile over a sorted array, rounded to whole cents.
 *
 * The interpolating kind, not "nearest rank": with 4 observations the nearest-rank p25 is
 * just the second value, which jumps around as one observation arrives. Interpolation moves
 * smoothly, which matters for a number plotted over time.
 */
export function percentileCents(sortedCents: readonly number[], p: number): number {
  if (sortedCents.length === 0) throw new RangeError('percentile of an empty set');
  if (p < 0 || p > 1) throw new RangeError(`percentile must be within 0..1, got ${String(p)}`);
  const first = sortedCents.at(0);
  if (first === undefined) throw new RangeError('percentile of an empty set');
  if (sortedCents.length === 1) return first;

  const position = (sortedCents.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  // `.at()` rather than an index expression: it is typed `T | undefined`, so a position
  // out of range becomes a thrown error instead of `undefined` quietly turning the
  // arithmetic below into NaN.
  const low = sortedCents.at(lower);
  const high = sortedCents.at(upper);
  if (low === undefined || high === undefined) {
    throw new RangeError(`percentile position ${String(position)} is out of range`);
  }
  if (lower === upper) return low;
  return Math.round(low + (high - low) * (position - lower));
}

/**
 * Summarise observations for one card variant and condition on one day.
 *
 * Returns `null` below MIN_OBSERVATIONS -- the caller publishes "insufficient data". That
 * is a real answer and a more useful one than a median of two.
 */
export function summarisePrices(
  observationsCents: readonly number[],
  options: { minObservations?: number; trimFraction?: number } = {},
): PriceSummary | null {
  const min = options.minObservations ?? MIN_OBSERVATIONS;
  const fraction = options.trimFraction ?? TRIM_FRACTION;

  for (const cents of observationsCents) {
    if (!Number.isInteger(cents)) {
      throw new TypeError(`prices must be integer cents, got ${String(cents)}`);
    }
    if (cents < 0) throw new RangeError(`prices cannot be negative, got ${String(cents)}`);
  }

  const count = observationsCents.length;
  if (count < min) return null;

  const sorted = [...observationsCents].sort((a, b) => a - b);
  const drop = trimCount(count, fraction);
  const kept = drop === 0 ? sorted : sorted.slice(drop, sorted.length - drop);

  const lowest = sorted.at(0);
  const highest = sorted.at(-1);
  if (lowest === undefined || highest === undefined) {
    throw new RangeError('no observations survived sorting');
  }

  return {
    medianCents: percentileCents(kept, 0.5),
    p25Cents: percentileCents(kept, 0.25),
    p75Cents: percentileCents(kept, 0.75),
    count,
    trimmedCount: drop * 2,
    // Low and high come from the FULL set: the point of showing a range is to show what
    // actually happened, including the ends the median deliberately ignores.
    lowCents: lowest,
    highCents: highest,
  };
}

/**
 * Is this observation far enough from the index to be worth a human look? (SR-4.4)
 *
 * Uses the interquartile range rather than standard deviations, because card prices are not
 * normally distributed -- one foil in a set of commons would drag a mean-based threshold
 * far enough that nothing ever looks odd.
 */
export function isOutlier(
  cents: number,
  summary: Pick<PriceSummary, 'p25Cents' | 'p75Cents'>,
  multiplier = 3,
): boolean {
  const iqr = summary.p75Cents - summary.p25Cents;
  // A zero IQR means every kept observation agreed. Anything away from that agreement is
  // notable, so fall back to comparing against the quartiles themselves.
  if (iqr === 0) return cents < summary.p25Cents || cents > summary.p75Cents;
  return cents < summary.p25Cents - multiplier * iqr || cents > summary.p75Cents + multiplier * iqr;
}

/**
 * Weight an observation by where it came from (FR-3.1 "in order of preference").
 *
 * Our own logs are worth more than a stranger's claim, because we watched them happen.
 * Weights are integers so a weighted median stays exact -- an observation with weight 3
 * is literally counted three times rather than multiplied by a float.
 */
export const SOURCE_WEIGHTS = {
  /** We recorded it live, on stream. The strongest evidence we have. */
  break_pull: 3,
  live_sale: 3,
  /** An official API. Trustworthy, but it is someone else's number. */
  ebay_api: 2,
  walmart_api: 2,
  /** A person told us. Moderated before it counts at all (SR-3.5). */
  user_report: 1,
} as const;

export type PriceSourceKind = keyof typeof SOURCE_WEIGHTS;

/** Expand weighted observations into a flat list, so the median stays a real median. */
export function applySourceWeights(
  observations: readonly { cents: number; source: PriceSourceKind }[],
): number[] {
  const out: number[] = [];
  for (const observation of observations) {
    const weight = SOURCE_WEIGHTS[observation.source];
    for (let i = 0; i < weight; i += 1) out.push(observation.cents);
  }
  return out;
}
