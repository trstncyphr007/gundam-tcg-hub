import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { app, cardVariants, sealedProducts } from './catalog.js';

export const breakStatus = app.enum('break_status', ['draft', 'live', 'ended']);

/**
 * A pack-opening session run by a creator (FR-2.2).
 *
 * Row-level security restricts writes to the owning creator; the public break page reads
 * through a separate published view, so a viewer needs no account (see migration 0010).
 */
export const breaks = app.table(
  'breaks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    creatorId: text('creator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** What is being opened. Its MSRP is the cost the running total is measured against. */
    sealedProductId: uuid('sealed_product_id').references(() => sealedProducts.id, {
      onDelete: 'set null',
    }),
    /** What the creator actually paid, which is often not MSRP. */
    costCents: integer('cost_cents'),
    status: breakStatus('status').notNull().default('draft'),
    /**
     * HMAC of the overlay token (SR-2.1). The token itself is shown once and never
     * stored, so a leaked database row cannot be replayed into a live overlay.
     */
    overlayTokenHash: text('overlay_token_hash').notNull(),
    /** Bumped on rotation, so an old token is provably dead rather than merely unlisted. */
    overlayTokenVersion: integer('overlay_token_version').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('breaks_creator_idx').on(t.creatorId),
    uniqueIndex('breaks_overlay_token_key').on(t.overlayTokenHash),
    check('breaks_title_not_blank', sql`length(btrim(${t.title})) > 0`),
    check('breaks_title_length', sql`length(${t.title}) <= 120`),
    check('breaks_cost_non_negative', sql`${t.costCents} is null or ${t.costCents} >= 0`),
    // A live break has started; an ended one has both timestamps and ends after it starts.
    check(
      'breaks_timestamps_follow_status',
      sql`(${t.status} = 'draft' and ${t.startedAt} is null and ${t.endedAt} is null)
       or (${t.status} = 'live' and ${t.startedAt} is not null and ${t.endedAt} is null)
       or (${t.status} = 'ended' and ${t.startedAt} is not null and ${t.endedAt} is not null
           and ${t.endedAt} >= ${t.startedAt})`,
    ),
  ],
);

/**
 * One card pulled during a break (FR-2.2), in order.
 *
 * `valueCentsAtPull` is frozen at the moment of the pull: the point of a break log is what
 * it was worth then, and a later price move must not silently rewrite history. Phase 4
 * hash-chains this table; the append-only grants land here now so that stays possible.
 */
export const breakPulls = app.table(
  'break_pulls',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    breakId: uuid('break_id')
      .notNull()
      .references(() => breaks.id, { onDelete: 'cascade' }),
    cardVariantId: uuid('card_variant_id').references(() => cardVariants.id, {
      onDelete: 'set null',
    }),
    /** Free-text fallback, so a creator is never blocked by a gap in the catalog. */
    label: text('label'),
    valueCentsAtPull: integer('value_cents_at_pull').notNull().default(0),
    /** Position in the break, assigned server-side. */
    seq: integer('seq').notNull(),
    pulledAt: timestamp('pulled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('break_pulls_break_idx').on(t.breakId, t.seq),
    uniqueIndex('break_pulls_break_seq_key').on(t.breakId, t.seq),
    check('break_pulls_seq_positive', sql`${t.seq} >= 1`),
    check('break_pulls_value_non_negative', sql`${t.valueCentsAtPull} >= 0`),
    // Something must identify the card, or the row says nothing.
    check(
      'break_pulls_identified',
      sql`${t.cardVariantId} is not null or length(btrim(coalesce(${t.label}, ''))) > 0`,
    ),
  ],
);
