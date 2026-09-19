import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** All application tables live in the `app` schema, owned by app_migrator (see init/01-roles.sh). */
export const app = pgSchema('app');

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// Enum types live in `app` too: app_migrator has no CREATE right on the public schema.
export const cardFinish = app.enum('card_finish', ['normal', 'parallel', 'alt_art', 'promo']);
export const cardLanguage = app.enum('card_language', ['en', 'ja']);
export const sealedKind = app.enum('sealed_kind', [
  'booster_box',
  'booster_pack',
  'starter_deck',
  'case',
  'bundle',
  'accessory',
]);

export const games = app.table('games', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sets = app.table(
  'sets',
  {
    id: id(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    releaseDate: date('release_date'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sets_game_code_key').on(t.gameId, t.code)],
);

export const cards = app.table(
  'cards',
  {
    id: id(),
    setId: uuid('set_id')
      .notNull()
      .references(() => sets.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    name: text('name').notNull(),
    cardType: text('card_type'),
    color: text('color'),
    rarity: text('rarity'),
    text: text('text'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('cards_set_number_key').on(t.setId, t.number),
    // Trigram index powers fuzzy name search (FR-1.3, <200ms p95).
    index('cards_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

export const cardVariants = app.table(
  'card_variants',
  {
    id: id(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    finish: cardFinish('finish').notNull().default('normal'),
    language: cardLanguage('language').notNull().default('en'),
    /** Link to the publisher's image. We do NOT rehost card art (plan §23, IP review). */
    imageRef: text('image_ref'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('card_variants_card_finish_lang_key').on(t.cardId, t.finish, t.language)],
);

export const sealedProducts = app.table(
  'sealed_products',
  {
    id: id(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'restrict' }),
    setId: uuid('set_id').references(() => sets.id, { onDelete: 'set null' }),
    kind: sealedKind('kind').notNull(),
    name: text('name').notNull(),
    upc: text('upc'),
    msrpCents: integer('msrp_cents'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sealed_products_game_name_key').on(t.gameId, t.name),
    check('sealed_products_msrp_nonneg', sql`${t.msrpCents} is null or ${t.msrpCents} >= 0`),
  ],
);

export const retailers = app.table(
  'retailers',
  {
    id: id(),
    name: text('name').notNull(),
    /** Scanner egress allowlist is derived from this column (SR-1.1). */
    domain: text('domain').notNull().unique(),
    adapterKey: text('adapter_key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    robotsOk: boolean('robots_ok').notNull().default(false),
    tosReviewedAt: timestamp('tos_reviewed_at', { withTimezone: true }),
    minIntervalS: integer('min_interval_s').notNull().default(900),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // FR-1.4 / SR-1.4 enforced in the database, not just the app: a retailer cannot be
    // enabled until its ToS + robots.txt have been reviewed.
    check(
      'retailers_enabled_requires_review',
      sql`not ${t.enabled} or (${t.tosReviewedAt} is not null and ${t.robotsOk})`,
    ),
    check('retailers_min_interval_positive', sql`${t.minIntervalS} >= 60`),
  ],
);

export const retailerProducts = app.table(
  'retailer_products',
  {
    id: id(),
    retailerId: uuid('retailer_id')
      .notNull()
      .references(() => retailers.id, { onDelete: 'cascade' }),
    sealedProductId: uuid('sealed_product_id')
      .notNull()
      .references(() => sealedProducts.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    externalId: text('external_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('retailer_products_retailer_url_key').on(t.retailerId, t.url),
    check('retailer_products_url_https', sql`${t.url} like 'https://%'`),
  ],
);

export const stockSnapshots = app.table(
  'stock_snapshots',
  {
    id: id(),
    retailerProductId: uuid('retailer_product_id')
      .notNull()
      .references(() => retailerProducts.id, { onDelete: 'cascade' }),
    inStock: boolean('in_stock').notNull(),
    priceCents: integer('price_cents'),
    currency: text('currency').notNull().default('USD'),
    /** Hash of the parsed payload, so unchanged pages don't create churn. */
    rawHash: text('raw_hash'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stock_snapshots_product_checked_idx').on(t.retailerProductId, t.checkedAt.desc()),
    check('stock_snapshots_price_nonneg', sql`${t.priceCents} is null or ${t.priceCents} >= 0`),
    check('stock_snapshots_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);
