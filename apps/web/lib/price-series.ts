/**
 * Shaping a price series for display.
 *
 * Pure functions, deliberately outside the chart component: this is the part that decides
 * what the chart *claims*, and it should be testable without rendering anything.
 */

export interface PricePoint {
  cardVariantId: string;
  finish: string;
  language: string;
  condition: string;
  day: string;
  medianCents: number;
  p25Cents: number;
  p75Cents: number;
  lowCents: number;
  highCents: number;
  observationCount: number;
  currency: string;
}

export function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/**
 * Split a series wherever a day is missing.
 *
 * This is the function that keeps the chart honest. The index publishes nothing on a day
 * with fewer than three observations; a line drawn straight across that gap asserts a price
 * we did not have. Each run of consecutive days is drawn separately, so a break in the line
 * is a day we could not price — and looks like one.
 */
export function splitRuns(points: readonly PricePoint[]): PricePoint[][] {
  const runs: PricePoint[][] = [];
  let current: PricePoint[] = [];

  for (const point of points) {
    const previous = current.at(-1);
    if (previous && dayNumber(point.day) - dayNumber(previous.day) > 1) {
      runs.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Round a value up to something a person would choose as an axis label. */
export function niceCeiling(cents: number): number {
  if (cents <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(cents));
  return Math.ceil(cents / magnitude) * magnitude;
}
