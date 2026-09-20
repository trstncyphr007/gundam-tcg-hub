import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { app, cardVariants } from './catalog.js';
import { cardCondition } from './pricing.js';

/**
 * Who may see a collection (FR-3.4).
 *
 * `unlisted` means "anyone holding the id", the same bargain as an unlisted video: the id is
 * an unguessable UUID, so it is shareable without being discoverable. Only `public`
 * collections appear in listings.
 */
export const collectionVisibility = app.enum('collection_visibility', [
  'private',
  'unlisted',
  'public',
]);

export const collections = app.table(
  'collections',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Private by default. Sharing has to be a decision, never an accident. */
    visibility: collectionVisibility('visibility').notNull().default('private'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('collections_owner_idx').on(t.ownerId),
    // Listing public collections is a common read; keep it off a sequential scan.
    index('collections_public_idx')
      .on(t.visibility)
      .where(sql`${t.visibility} = 'public'`),
    check('collections_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check('collections_name_length', sql`length(${t.name}) <= 80`),
  ],
);

/**
 * One line in a collection: a card variant, in a condition, with a quantity.
 *
 * `acquiredPriceCents` is what the owner paid **per card**, not for the line, so that a
 * quantity change does not silently rewrite the cost basis. It is the only way gain or loss
 * means anything. It is nullable because plenty of cards arrive without a known cost --
 * pulled from a pack, traded, given -- and a made-up zero would quietly report the whole
 * collection as pure profit.
 */
export const collectionItems = app.table(
  'collection_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    cardVariantId: uuid('card_variant_id')
      .notNull()
      .references(() => cardVariants.id, { onDelete: 'cascade' }),
    condition: cardCondition('condition').notNull().default('nm'),
    quantity: integer('quantity').notNull().default(1),
    acquiredPriceCents: integer('acquired_price_cents'),
    /**
     * The currency the cost basis is in, and the one this line is valued in. Everywhere else
     * in this database money is cents *plus* a currency, and a cost basis is no different:
     * "1200" is not an amount until you know whether it is dollars or yen.
     */
    currency: text('currency').notNull().default('USD'),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('collection_items_collection_idx').on(t.collectionId),
    // One line per variant per condition: the same card in two conditions is two lines,
    // the same card twice in one condition is a quantity.
    uniqueIndex('collection_items_unique_line').on(t.collectionId, t.cardVariantId, t.condition),
    check('collection_items_quantity_positive', sql`${t.quantity} >= 1`),
    check('collection_items_quantity_sane', sql`${t.quantity} <= 100000`),
    check(
      'collection_items_price_non_negative',
      sql`${t.acquiredPriceCents} is null or ${t.acquiredPriceCents} >= 0`,
    ),
    check('collection_items_notes_length', sql`${t.notes} is null or length(${t.notes}) <= 500`),
    check('collection_items_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);
