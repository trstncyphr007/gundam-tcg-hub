import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { app, cardVariants } from './catalog.js';
import { cardCondition, priceObservations } from './pricing.js';

/**
 * One card sold live on stream (FR-4.1).
 *
 * This is the half of the data asset nobody else records. A card sold on a live stream leaves
 * no public trace: no marketplace listing, no sold-price page, nothing to scrape. We know
 * because we watched it, which is why these observations are weighted as heavily as our own
 * break pulls (ADR-018).
 *
 * **It is a separate table rather than a direct write to `price_observations`, on purpose.**
 * Migration 0013 forbids the web role from inserting any observation except an unapproved
 * `user_report`: the sources we weight most cannot be reached from a session at all. A
 * compromised web process must not be able to assert "this came from a live sale we
 * watched". So a seller writes here, and a worker — a different role, on a different
 * schedule — turns these rows into observations. The control stays intact and the logger
 * still feels immediate.
 */
export const liveSales = app.table(
  'live_sales',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Which card. Nullable, with a free-text `label` fallback, for the same reason a pull is:
     * a seller must never be blocked mid-stream by a gap in the catalog. An entry with no
     * variant is still a record of the sale — it just cannot feed the index, because there is
     * nothing to price.
     */
    cardVariantId: uuid('card_variant_id').references(() => cardVariants.id, {
      onDelete: 'set null',
    }),
    label: text('label'),
    /**
     * A live sale is usually a single out of a binder, not a card from a pack opened five
     * seconds ago — so unlike a break pull, the condition is a real question and is recorded
     * rather than assumed.
     */
    condition: cardCondition('condition').notNull().default('nm'),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    soldAt: timestamp('sold_at', { withTimezone: true }).notNull().defaultNow(),
    /** Where it can be watched: a VOD link, ideally with a timestamp (FR-4.4). */
    streamRef: text('stream_ref'),
    /**
     * The buyer's handle, AES-256-GCM encrypted (SR-4.5, SR-1.6).
     *
     * Somebody's name on another platform, typed by a third party who never agreed to
     * anything with us. It exists so the seller knows who to post the card to, and it is
     * defended in four ways, none of which trusts application code to be correct:
     *
     *   1. encrypted at rest, so a database backup does not contain buyer handles
     *   2. `app_worker` has **no SELECT** on this column (migration 0024), so the ingestion
     *      path that writes public price observations provably cannot carry it across
     *   3. it appears in no public view and in no price observation — only in the owning
     *      seller's own listing
     *   4. it is erased 90 days after the sale, by a job that may UPDATE this column and
     *      still cannot read it
     */
    buyerHandleEncrypted: text('buyer_handle_encrypted'),
    /**
     * Whether a handle is stored — which is not itself PII, and is what lets the retention
     * sweep run on a role that cannot read the handle.
     *
     * Without this, the sweep's own `WHERE buyer_handle_encrypted IS NOT NULL` would need
     * SELECT on that column, and granting it would hand the ingestion path exactly what the
     * split grant exists to withhold. So the two facts are separated on purpose: *whether*
     * there is a name here is operational metadata anyone may read; *what it is* is not.
     * A CHECK keeps the two honest about each other.
     */
    hasBuyerHandle: boolean('has_buyer_handle').notNull().default(false),
    /**
     * The observation this produced, once the worker has ingested it. Unique, so re-running
     * ingestion cannot inflate the sample — the same guard break pulls have, and it matters
     * more here because a seller could otherwise move the index by re-saving.
     */
    priceObservationId: uuid('price_observation_id')
      .unique()
      .references(() => priceObservations.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The seller's own listing, newest first, and the per-day cap's count.
    index('live_sales_seller_sold_idx').on(t.sellerId, t.soldAt.desc()),
    // The ingestion's access pattern: everything not yet turned into an observation.
    index('live_sales_pending_idx')
      .on(t.priceObservationId)
      .where(sql`${t.priceObservationId} is null`),
    // The retention sweep's: the oldest handles still present. On the flag, which is what
    // the sweep is permitted to look at.
    index('live_sales_handle_retention_idx')
      .on(t.soldAt)
      .where(sql`${t.hasBuyerHandle}`),
    check('live_sales_price_non_negative', sql`${t.priceCents} >= 0`),
    check('live_sales_price_sane', sql`${t.priceCents} <= 100000000`),
    check('live_sales_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    // Something must identify the card, or the row says nothing.
    check(
      'live_sales_identified',
      sql`${t.cardVariantId} is not null or length(btrim(coalesce(${t.label}, ''))) > 0`,
    ),
    // The ciphertext format, checked by the database as well as by the decryptor. A handle
    // written in plaintext by a future bug fails here rather than being published later.
    check(
      'live_sales_handle_encrypted',
      sql`${t.buyerHandleEncrypted} is null or ${t.buyerHandleEncrypted} ~ '^v1:'`,
    ),
    // The flag and the column agree, always. A sweep that cleared one and not the other
    // would leave a row claiming to hold a name it does not — or, worse, the reverse.
    check(
      'live_sales_handle_flag_matches',
      sql`${t.hasBuyerHandle} = (${t.buyerHandleEncrypted} is not null)`,
    ),
    check(
      'live_sales_stream_ref_https',
      sql`${t.streamRef} is null or ${t.streamRef} like 'https://%'`,
    ),
  ],
);
