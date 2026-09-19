import { sql } from 'drizzle-orm';
import { check, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { app, retailerProducts, sealedProducts } from './catalog.js';

export const alertChannel = app.enum('alert_channel', [
  'email',
  'discord_dm',
  'discord_webhook',
  'web_push',
]);

/**
 * A user's interest in a product coming back in stock (FR-1.9).
 * Row-level security restricts every row to its owner (SR-X.8); see migration 0003.
 */
export const watchSubscriptions = app.table(
  'watch_subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Watch a product across all retailers... */
    sealedProductId: uuid('sealed_product_id').references(() => sealedProducts.id, {
      onDelete: 'cascade',
    }),
    /** ...or one specific retailer listing. Exactly one of the two is set. */
    retailerProductId: uuid('retailer_product_id').references(() => retailerProducts.id, {
      onDelete: 'cascade',
    }),
    channels: alertChannel('channels').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('watch_subscriptions_user_idx').on(t.userId),
    // One watch per user per target; partial indexes because either column may be null.
    uniqueIndex('watch_subscriptions_user_product_key')
      .on(t.userId, t.sealedProductId)
      .where(sql`${t.sealedProductId} is not null`),
    uniqueIndex('watch_subscriptions_user_listing_key')
      .on(t.userId, t.retailerProductId)
      .where(sql`${t.retailerProductId} is not null`),
    check(
      'watch_subscriptions_exactly_one_target',
      sql`(${t.sealedProductId} is null) <> (${t.retailerProductId} is null)`,
    ),
    // cardinality(), not array_length(): array_length of an empty array is NULL, and a
    // CHECK constraint passes on NULL, so the empty case would slip through.
    check('watch_subscriptions_channels_not_empty', sql`cardinality(${t.channels}) >= 1`),
  ],
);
