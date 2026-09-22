import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { breakPulls } from './breaks.js';
import { app, cardVariants } from './catalog.js';

/** Where a price came from. Ordered by how much we trust it (see SOURCE_WEIGHTS). */
export const priceSource = app.enum('price_source', [
  'break_pull',
  'live_sale',
  'user_report',
  'ebay_api',
  'walmart_api',
]);

/** What kind of price this is. An asking price is not a sale and must not be treated as one. */
export const priceSaleType = app.enum('price_sale_type', ['sold', 'listed']);

/** Standard single-card grades. A card straight out of a pack is `nm`. */
export const cardCondition = app.enum('card_condition', ['nm', 'lp', 'mp', 'hp', 'dmg']);

/**
 * One observed price for one card variant (FR-3.1).
 *
 * **Deviation from the plan, recorded on purpose:** §7 calls for monthly partitioning. This
 * is a plain table with indexes instead. Partitioning earns its keep when old data has to be
 * dropped cheaply or an index stops fitting in memory; a card game's price observations are
 * thousands a month, not millions, and Postgres is entirely comfortable there. Partitioning
 * now would be machinery maintained for a problem we do not have.
 *
 * It is not free to change later -- converting a populated table means a rewrite -- so the
 * trigger is written down: partition by `observed_at` if this table passes ~50M rows or a
 * retention policy appears. Both are far off, and both are visible well in advance.
 */
export const priceObservations = app.table(
  'price_observations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cardVariantId: uuid('card_variant_id')
      .notNull()
      .references(() => cardVariants.id, { onDelete: 'cascade' }),
    source: priceSource('source').notNull(),
    saleType: priceSaleType('sale_type').notNull().default('sold'),
    condition: cardCondition('condition').notNull().default('nm'),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    /** A link to a VOD timestamp, a screenshot, an order reference (FR-4.4, SR-3.5). */
    evidenceRef: text('evidence_ref'),
    /** Who told us, when a person did. Null for our own logs and for APIs. */
    reporterId: text('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    /** The pull this came from, when we watched it happen. */
    breakPullId: uuid('break_pull_id').references(() => breakPulls.id, { onDelete: 'set null' }),
    /**
     * Moderation (SR-3.5). A user report counts for nothing until a human approves it, so
     * the index cannot be moved by simply asserting a price. Our own sources are approved
     * on arrival, because we watched them.
     */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    /** Set when the price sat far outside the current spread; a human looks before it counts. */
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The rollup's access pattern: one variant, one condition, a day's window.
    index('price_observations_rollup_idx').on(t.cardVariantId, t.condition, t.observedAt),
    index('price_observations_reporter_idx').on(t.reporterId),
    // One observation per pull: re-running the wiring must not inflate the sample.
    uniqueIndex('price_observations_break_pull_key')
      .on(t.breakPullId)
      .where(sql`${t.breakPullId} is not null`),
    check('price_observations_price_non_negative', sql`${t.priceCents} >= 0`),
    check('price_observations_price_sane', sql`${t.priceCents} <= 100000000`),
    check('price_observations_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    // Approved and rejected are mutually exclusive: a row cannot be both.
    check(
      'price_observations_not_both_decisions',
      sql`${t.approvedAt} is null or ${t.rejectedAt} is null`,
    ),
    // A user report must name its reporter while it is being judged, or there is nobody to
    // weight or to ask. Once approved it is part of the public record, and it outlives the
    // reporter's account anonymously: the foreign key's `set null` is what erases them from
    // it (ADR-027). Before this, that `set null` contradicted the check, and deleting any
    // account that had ever reported a price failed outright.
    check(
      'price_observations_reporter_required',
      sql`${t.source} <> 'user_report' or ${t.reporterId} is not null or ${t.approvedAt} is not null`,
    ),
  ],
);

/**
 * The published index: one row per variant, condition and day (FR-3.2).
 *
 * Recomputed by a nightly rollup rather than maintained incrementally, because the maths is
 * order-dependent -- a trimmed median cannot be updated by adding one number to it.
 */
export const priceIndexDaily = app.table(
  'price_index_daily',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    cardVariantId: uuid('card_variant_id')
      .notNull()
      .references(() => cardVariants.id, { onDelete: 'cascade' }),
    condition: cardCondition('condition').notNull(),
    day: date('day').notNull(),
    medianCents: integer('median_cents').notNull(),
    p25Cents: integer('p25_cents').notNull(),
    p75Cents: integer('p75_cents').notNull(),
    lowCents: integer('low_cents').notNull(),
    highCents: integer('high_cents').notNull(),
    /** Observations that went in, before trimming and before weighting. */
    observationCount: integer('observation_count').notNull(),
    currency: text('currency').notNull().default('USD'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Currency belongs in the key. Without it a USD row and a CAD row for the same card and
    // day collide, and whichever the rollup writes second silently replaces the other.
    uniqueIndex('price_index_daily_key').on(t.cardVariantId, t.condition, t.day, t.currency),
    index('price_index_daily_history_idx').on(t.cardVariantId, t.day),
    check(
      'price_index_daily_ordered',
      sql`${t.p25Cents} <= ${t.medianCents} and ${t.medianCents} <= ${t.p75Cents}`,
    ),
    check(
      'price_index_daily_range',
      sql`${t.lowCents} <= ${t.p25Cents} and ${t.p75Cents} <= ${t.highCents}`,
    ),
    // Never publish below the floor; the API says "insufficient data" instead.
    check('price_index_daily_min_observations', sql`${t.observationCount} >= 3`),
  ],
);
