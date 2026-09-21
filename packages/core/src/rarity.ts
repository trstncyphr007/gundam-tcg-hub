/**
 * Hit rates against published pack odds (FR-4.3).
 *
 * This is the most dangerous page in the project. A breaker profile that says "pulls SR at
 * half the published rate" is, in the only reading anyone will give it, an accusation of
 * rigging — and it is an accusation we would be making automatically, at scale, about a
 * named person, from a sample that is usually far too small to support it.
 *
 * So the rules here are deliberately conservative, and every one of them errs towards saying
 * nothing:
 *
 *  - The interval is **Wilson**, not the textbook normal approximation. For the rates pack
 *    odds actually use (1 in 12, 1 in 72) the normal interval is badly wrong at small n and
 *    can even run below zero. Wilson is well behaved right down to zero hits.
 *  - Nothing is compared until the sample could possibly say anything: a floor on packs, and
 *    a floor on *expected* hits, because 500 packs at 1-in-1000 is still no evidence.
 *  - The confidence level is adjusted for how many rarities are being compared at once
 *    (Šidák). Six rarities tested at 95% gives a 26% chance that one looks damning purely by
 *    luck, and that one is exactly the one a reader would screenshot.
 *
 * Everything is a rate per pack. Odds are carried as an exact fraction — `1/12`, never
 * `0.0833` — so the comparison is against the number the publisher printed.
 */

/** Below this many packs, no comparison is offered at all. */
export const MIN_PACKS_FOR_ODDS = 30;

/**
 * And below this many *expected* hits either.
 *
 * The usual rule of thumb for a normal-ish approximation, and it carries its own meaning:
 * at 1-in-72 odds you need 360 packs before the published rate can be distinguished from
 * anything. Most breakers will never reach that for their rarest slot, and the honest answer
 * there is "not enough packs", forever.
 */
export const MIN_EXPECTED_HITS = 5;

/** Two-sided confidence before adjusting for how many rarities are compared at once. */
export const ODDS_CONFIDENCE = 0.95;

/**
 * A published rate, as the publisher printed it: `numerator` cards per `denominator` packs.
 *
 * A fraction rather than a float because "1 in 12" is exact and 0.08333 is not, and because
 * the source line under the table should be able to quote the original.
 */
export interface PublishedOdds {
  numerator: number;
  denominator: number;
}

export type OddsVerdict =
  /** No odds have been published for this rarity, or none we can cite. */
  | 'unpublished'
  /** Too few packs for the comparison to mean anything. The common case, and fine. */
  | 'insufficient'
  /** More hits than packs: the one-per-pack model does not describe this data. */
  | 'not_comparable'
  /** The published rate sits inside the interval. This is what honest data looks like. */
  | 'consistent'
  | 'above'
  | 'below';

export interface RarityComparison {
  rarity: string;
  hits: number;
  packs: number;
  /** Observed hits per pack, or null when no packs were counted. */
  observedRate: number | null;
  published: PublishedOdds | null;
  publishedRate: number | null;
  /** Wilson bounds on the observed rate, null whenever no comparison was made. */
  lowRate: number | null;
  highRate: number | null;
  verdict: OddsVerdict;
}

// --------------------------------------------------------------------------- //
// The normal quantile, because the confidence level is not a fixed 1.96
// --------------------------------------------------------------------------- //

const LOW_TAIL = 0.02425;

// Acklam's published coefficients, transcribed and pinned by the known-answer tests.
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
] as const;
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
] as const;
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
] as const;
const D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
] as const;

function at(values: readonly number[], index: number): number {
  const value = values.at(index);
  if (value === undefined) throw new RangeError(`coefficient ${String(index)} is missing`);
  return value;
}

/**
 * The inverse standard normal CDF (Acklam's rational approximation, ~1e-9 absolute).
 *
 * Written out rather than pulled in as a dependency: it is thirty lines, it is covered by
 * known-answer tests below, and a statistics library is a large amount of supply chain to
 * take on for one function (SR-0.9).
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`quantile needs 0 < p < 1, got ${String(p)}`);

  if (p < LOW_TAIL) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((at(C, 0) * q + at(C, 1)) * q + at(C, 2)) * q + at(C, 3)) * q + at(C, 4)) * q +
        at(C, 5)) /
      ((((at(D, 0) * q + at(D, 1)) * q + at(D, 2)) * q + at(D, 3)) * q + 1)
    );
  }
  if (p > 1 - LOW_TAIL) return -normalQuantile(1 - p);

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((at(A, 0) * r + at(A, 1)) * r + at(A, 2)) * r + at(A, 3)) * r + at(A, 4)) * r + at(A, 5)) *
      q) /
    (((((at(B, 0) * r + at(B, 1)) * r + at(B, 2)) * r + at(B, 3)) * r + at(B, 4)) * r + 1)
  );
}

/**
 * The two-sided z for `comparisons` simultaneous tests (Šidák).
 *
 * Testing every rarity on a page and reporting whichever one crossed the line is the classic
 * way to manufacture a finding from noise. Šidák rather than Bonferroni only because it is
 * exact for independent tests and very slightly less brutal; either would do.
 */
export function zFor(confidence = ODDS_CONFIDENCE, comparisons = 1): number {
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError(`confidence must be within 0..1, got ${String(confidence)}`);
  }
  if (!Number.isInteger(comparisons) || comparisons < 1) {
    throw new RangeError(`comparisons must be a positive integer, got ${String(comparisons)}`);
  }
  // Per-test *confidence* is `confidence^(1/k)`, so per-test alpha is what is left of it.
  // Note the shape: it is not `(1 - confidence)^(1/k)`, which looks similar, is an easy
  // thing to write, and at k=1 returns z = 0.06 — a "95% interval" of almost no width.
  const alphaPerTest = 1 - confidence ** (1 / comparisons);
  return normalQuantile(1 - alphaPerTest / 2);
}

/**
 * Wilson score interval for a proportion.
 *
 * Chosen over the Wald interval for the reason that matters here: at zero hits, Wald gives
 * the interval [0, 0] — infinite confidence that the true rate is exactly zero, from a
 * sample of thirty. Wilson gives a sensible upper bound instead.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z: number,
): { low: number; high: number } {
  if (!Number.isInteger(successes) || successes < 0) {
    throw new RangeError(`successes must be a non-negative integer, got ${String(successes)}`);
  }
  if (!Number.isInteger(trials) || trials < 1) {
    throw new RangeError(`trials must be a positive integer, got ${String(trials)}`);
  }
  if (successes > trials) {
    throw new RangeError(`successes (${String(successes)}) exceeds trials (${String(trials)})`);
  }

  const phat = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (phat + z2 / (2 * trials)) / denominator;
  const spread =
    (z / denominator) * Math.sqrt((phat * (1 - phat)) / trials + z2 / (4 * trials * trials));
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

/** The published rate as a number, or null when nothing is published. */
export function ratePerPack(odds: PublishedOdds | null): number | null {
  if (!odds) return null;
  if (!Number.isInteger(odds.numerator) || !Number.isInteger(odds.denominator)) {
    throw new TypeError('published odds must be a ratio of two integers');
  }
  if (odds.denominator < 1 || odds.numerator < 0) {
    throw new RangeError('published odds must be a non-negative rate over at least one pack');
  }
  return odds.numerator / odds.denominator;
}

/**
 * Compare one rarity's observed hits against its published odds.
 *
 * Returns a verdict, not a judgement. `consistent` is the expected outcome and the page says
 * so in those words; `above` and `below` mean only that the published rate fell outside the
 * interval, which is a statement about this sample and not about the breaker.
 */
export function compareToOdds(input: {
  rarity: string;
  hits: number;
  packs: number;
  published: PublishedOdds | null;
  /** How many rarities are being compared alongside this one. */
  comparisons?: number;
  confidence?: number;
}): RarityComparison {
  const { rarity, hits, packs, published } = input;
  const publishedRate = ratePerPack(published);
  const observedRate = packs > 0 ? hits / packs : null;

  const base: RarityComparison = {
    rarity,
    hits,
    packs,
    observedRate,
    published,
    publishedRate,
    lowRate: null,
    highRate: null,
    verdict: 'unpublished',
  };

  if (published === null || publishedRate === null) return base;
  // More hits than packs is not a scandal, it is a different distribution: a pack can hold
  // two of a rarity, and "1 in 12 packs" says nothing about that case. Reporting a verdict
  // from a model the data contradicts would be worse than reporting none.
  if (hits > packs) return { ...base, verdict: 'not_comparable' };
  if (packs < MIN_PACKS_FOR_ODDS || packs * publishedRate < MIN_EXPECTED_HITS) {
    return { ...base, verdict: 'insufficient' };
  }

  const { low, high } = wilsonInterval(hits, packs, zFor(input.confidence, input.comparisons));
  const verdict: OddsVerdict =
    publishedRate < low ? 'above' : publishedRate > high ? 'below' : 'consistent';
  return { ...base, lowRate: low, highRate: high, verdict };
}

/**
 * Compare a whole product's rarities together, so the multiple-comparison adjustment counts
 * the tests that were actually run rather than pretending each was the only one.
 *
 * Only rarities with published odds are counted towards that total: a rarity we cannot
 * compare was never a test, and inflating `k` with it would make the surviving comparisons
 * weaker than they should be.
 */
export function compareRarities(
  rows: readonly { rarity: string; hits: number; packs: number; published: PublishedOdds | null }[],
  options: { confidence?: number } = {},
): RarityComparison[] {
  const comparisons = Math.max(1, rows.filter((r) => r.published !== null).length);
  return rows.map((row) =>
    compareToOdds({
      ...row,
      comparisons,
      ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
    }),
  );
}

/**
 * Handles that would collide with a route or read as official.
 *
 * `/breakers/<handle>` shares a namespace with nothing today, but the page for a breaker and
 * the page *about* breakers should never be able to become the same URL, and nobody should
 * be able to register the one that looks like staff.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'about',
  'admin',
  'administrator',
  'api',
  'docs',
  'gth',
  'gundam',
  'help',
  'me',
  'methodology',
  'new',
  'official',
  'root',
  'settings',
  'staff',
  'support',
  'system',
]);

/** Lowercase, url-safe, no leading or trailing dash. Mirrored by a CHECK constraint. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u;

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle) && !RESERVED_HANDLES.has(handle);
}
