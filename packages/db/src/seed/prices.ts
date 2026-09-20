import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { rollUpDay } from '../queries/pricing.js';

/**
 * Synthetic price observations for local development.
 *
 * **This is fake data and it has to stay obviously fake.** The index is the part of this
 * project that has to be defensible; a chart full of invented numbers that nobody can
 * distinguish from real ones is worse than an empty chart. Three things keep that true:
 *
 *  1. **It only touches the sample catalog.** Every row is scoped to cards in `SAMPLE-01`,
 *     the placeholder set `seedSample` creates. Run this against a database holding the real
 *     catalog and it writes nothing, because it can find no rows to write about.
 *  2. **Every observation says so.** `evidence_ref` is `seed:synthetic` on every row, so
 *     anyone reading the table — or wondering why a number looks odd — is told immediately.
 *  3. **It refuses to run in production**, checked by the caller (`seed-prices.ts`).
 *
 * The published index is then computed by the **real rollup**, not written directly: seeding
 * `price_index_daily` by hand would mean the charts were exercising code that does not run in
 * production, which is how a bug in the rollup survives to launch.
 */

/** Marks every row this writes. Grep for it to find and remove synthetic data. */
export const SYNTHETIC_EVIDENCE = 'seed:synthetic';

/** The placeholder set from `seedSample`. Nothing outside it is ever touched. */
const SAMPLE_SET_CODE = 'SAMPLE-01';

/**
 * A tiny deterministic generator (mulberry32).
 *
 * Deterministic on purpose: the same seed gives the same prices, so a chart looks the same
 * after a database reset and a test can assert on a number. `Math.random()` would make every
 * run a different conversation.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Variant extends Record<string, unknown> {
  id: string;
  rarity: string | null;
  finish: string;
}

/** Roughly what a card of that rarity goes for, before any drift. Integer cents. */
function basePrice(variant: Variant): number {
  const byRarity = new Map([
    ['C', 75],
    ['R', 400],
    ['SR', 2400],
  ]);
  const base = byRarity.get(variant.rarity ?? 'C') ?? 200;
  // A parallel printing of the same card is worth more, which is the whole reason variants
  // are priced separately rather than per card.
  return variant.finish === 'parallel' ? base * 4 : base;
}

export interface SeedPricesOptions {
  /** How many days of history to generate, ending today. */
  days?: number;
  /** Fixed by default, so repeated runs produce the same chart. */
  seed?: number;
}

export interface SeedPricesResult {
  variants: number;
  observations: number;
  published: number;
  skipped: number;
}

/**
 * Generate observations across the last `days` days and publish the index from them.
 *
 * Returns what it did rather than logging, so a test can assert on it and the CLI can print
 * it. A run with no sample catalog returns zeroes instead of throwing: "there is nothing to
 * seed" is a normal outcome, not a failure.
 */
export async function seedSamplePrices(
  db: Database,
  options: SeedPricesOptions = {},
): Promise<SeedPricesResult> {
  const days = Math.min(Math.max(Math.trunc(options.days ?? 90), 1), 400);
  const random = rng(options.seed ?? 20260921);

  const variants = await db.execute<Variant>(sql`
    select v.id, c.rarity, v.finish::text as finish
      from app.card_variants v
      join app.cards c on c.id = v.card_id
      join app.sets s on s.id = c.set_id
     where s.code = ${SAMPLE_SET_CODE}
     order by c.number, v.finish
  `);

  if (variants.length === 0) {
    return { variants: 0, observations: 0, published: 0, skipped: 0 };
  }

  // Re-runnable: clear only what this function wrote, never anything real.
  await db.execute(sql`
    delete from app.price_observations where evidence_ref = ${SYNTHETIC_EVIDENCE}
  `);

  // Weighted so the mix is not uniform: our own live sales should outnumber marketplace
  // pulls, because that is the data asset the whole project is built on.
  const sources = ['live_sale', 'live_sale', 'ebay_api', 'walmart_api'] as const;
  const conditions = ['nm', 'nm', 'nm', 'lp'] as const;

  const rows: {
    cardVariantId: string;
    source: string;
    condition: string;
    priceCents: number;
    observedAt: string;
  }[] = [];

  for (const variant of variants) {
    let level = basePrice(variant);

    for (let dayOffset = days - 1; dayOffset >= 0; dayOffset -= 1) {
      // A slow random walk with a gentle pull back towards the starting price, so a 90-day
      // chart has a shape instead of a straight line or a runaway.
      const drift = (random() - 0.5) * 0.06;
      const pull = (basePrice(variant) - level) * 0.02;
      level = Math.max(25, Math.round(level * (1 + drift) + pull));

      // Enough that near-mint clears the three-observation floor most days, and occasionally
      // not — "insufficient data" is a real state and the UI needs to be seen handling it.
      // Tuned by running it: at 2–7 a day, split across two conditions, nearly half the days
      // fell below the floor and the chart looked broken rather than honest.
      const count = 5 + Math.floor(random() * 6);
      for (let i = 0; i < count; i += 1) {
        // Individual sales scatter around the day's level; this is the spread the index
        // reports as p25/p75 rather than hiding behind one number.
        const scatter = 1 + (random() - 0.5) * 0.3;
        const condition = conditions[Math.floor(random() * conditions.length)] ?? 'nm';
        // A played copy is worth less, and the index prices conditions separately.
        const conditionFactor = condition === 'nm' ? 1 : 0.6;
        const observedAt = new Date(Date.now() - dayOffset * 86_400_000);
        // Spread within the day so they are not all at the same instant.
        observedAt.setUTCHours(Math.floor(random() * 20) + 2, Math.floor(random() * 60), 0, 0);

        rows.push({
          cardVariantId: variant.id,
          source: sources[Math.floor(random() * sources.length)] ?? 'live_sale',
          condition,
          priceCents: Math.max(1, Math.round(level * scatter * conditionFactor)),
          observedAt: observedAt.toISOString(),
        });
      }
    }
  }

  // One statement rather than thousands of round trips: 90 days across six variants is
  // already ~3,000 rows.
  const values = rows.map(
    (row) =>
      sql`(${row.cardVariantId}::uuid, ${row.source}::app.price_source, 'sold',
           ${row.condition}::app.card_condition, ${row.priceCents}, 'USD',
           ${row.observedAt}::timestamptz, ${SYNTHETIC_EVIDENCE}, now())`,
  );
  await db.execute(sql`
    insert into app.price_observations
      (card_variant_id, source, sale_type, condition, price_cents, currency,
       observed_at, evidence_ref, approved_at)
    values ${sql.join(values, sql`, `)}
  `);

  // Publish through the real rollup, so the charts are reading code that also runs in prod.
  let published = 0;
  let skipped = 0;
  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset -= 1) {
    const result = await rollUpDay(db, new Date(Date.now() - dayOffset * 86_400_000));
    published += result.written;
    skipped += result.skipped;
  }

  return { variants: variants.length, observations: rows.length, published, skipped };
}
