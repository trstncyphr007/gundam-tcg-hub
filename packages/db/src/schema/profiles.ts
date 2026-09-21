import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { app, sealedProducts } from './catalog.js';

/**
 * A breaker's public page (FR-4.3).
 *
 * Deliberately its own table rather than columns on `users`, for one reason: **the default
 * has to be "no public page at all"**. A profile row is created when someone claims a handle
 * and published when they say so, so nobody acquires a public identity as a side effect of
 * signing in, and deleting the row removes the page rather than blanking it.
 *
 * Nothing here is copied from the account. `displayName` is typed by the creator, the same
 * rule the overlay follows (FR-2.4): the only things that can reach a public surface are the
 * ones someone entered for display. There is no email, no Discord id, and no `users.name`.
 */
export const creatorProfiles = app.table(
  'creator_profiles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The URL. Lowercase and url-safe so the page has exactly one address. */
    handle: text('handle').notNull(),
    displayName: text('display_name').notNull(),
    bio: text('bio'),
    /** False until the creator publishes. An unpublished profile resolves to a 404. */
    published: boolean('published').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('creator_profiles_user_key').on(t.userId),
    // Case matters here: two handles differing only in case would be two rows and one URL.
    // The CHECK below forbids uppercase outright, so this index is over the only form there
    // can be.
    uniqueIndex('creator_profiles_handle_key').on(t.handle),
    check('creator_profiles_handle_format', sql`${t.handle} ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'`),
    check(
      'creator_profiles_display_name_length',
      sql`length(btrim(${t.displayName})) between 1 and 60`,
    ),
    check('creator_profiles_bio_length', sql`${t.bio} is null or length(${t.bio}) <= 280`),
  ],
);

/**
 * Published pull rates for a sealed product (FR-4.3).
 *
 * Reference data, not user data: the publisher's own numbers, recorded so a profile page can
 * compare against them. Two decisions worth stating:
 *
 * **It is a fraction, not a float.** "1 in 12" is exact; 0.0833 is a rounding of it, and the
 * table under the comparison should be able to print what the publisher actually wrote.
 *
 * **`source_url` is NOT NULL.** Odds we cannot point at are not published odds, they are our
 * claim about published odds — and this table exists to hold a page up when someone says
 * "where did you get that". A row without a citation would quietly turn an argument we can
 * win into one we cannot.
 */
export const packOdds = app.table(
  'pack_odds',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sealedProductId: uuid('sealed_product_id')
      .notNull()
      .references(() => sealedProducts.id, { onDelete: 'cascade' }),
    /** Matches `cards.rarity`, which is free text — so this is free text too, on purpose. */
    rarity: text('rarity').notNull(),
    /** `numerator` cards of this rarity per `denominator` packs. */
    numerator: integer('numerator').notNull(),
    denominator: integer('denominator').notNull(),
    /** Where the publisher stated it. Shown beside the comparison. */
    sourceUrl: text('source_url').notNull(),
    /** When the publisher stated it: odds change between sets and printings. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pack_odds_product_rarity_key').on(t.sealedProductId, t.rarity),
    index('pack_odds_product_idx').on(t.sealedProductId),
    check('pack_odds_denominator_positive', sql`${t.denominator} >= 1`),
    // A rate above one per pack is not a "1 in N" odds line, it is a different statement,
    // and the comparison maths assumes at most one hit per pack.
    check('pack_odds_numerator_range', sql`${t.numerator} between 1 and ${t.denominator}`),
    check('pack_odds_source_https', sql`${t.sourceUrl} like 'https://%'`),
  ],
);
