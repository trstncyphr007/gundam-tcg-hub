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
import { app, retailerProducts, stockSnapshots } from './catalog.js';
import { alertChannel, watchSubscriptions } from './watches.js';

/**
 * What a key may do.
 *
 * `prices:read` joins the original two for the public pricing API (FR-3.7). The plan writes
 * these the other way round (`read:prices`); the existing values were already
 * `resource:verb`, and one convention consistently applied beats matching a document at the
 * cost of having two.
 */
export const apiKeyScope = app.enum('api_key_scope', [
  'ingest:write',
  'catalog:read',
  'prices:read',
]);

/** Request allowance per key. Only one tier exists; the column is what makes a second cheap. */
export const apiKeyTier = app.enum('api_key_tier', ['free']);

/**
 * Machine credentials. Only a keyed hash is stored, never the secret itself (SR-3.1); the
 * plaintext is shown once at creation.
 *
 * Two kinds of key live here. A **first-party** key belongs to no user: the scanner's key is
 * created by an operator at the CLI and `owner_id` is null. A **self-serve** key belongs to
 * the account that made it (FR-3.7). The column is nullable for exactly that reason, and the
 * check constraint below is what stops the difference being abused -- a key nobody owns may
 * not be created from a session, and a session key may not hold an ingest scope.
 */
export const apiKeys = app.table(
  'api_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Null for first-party keys issued at the CLI; set for every self-serve key. */
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Public lookup handle, so we never scan every row to find a key. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: apiKeyScope('scopes').array().notNull(),
    tier: apiKeyTier('tier').notNull().default('free'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** The UTC day `quotaUsed` counts for. Null until the key's first call (migration 0040). */
    quotaDay: date('quota_day'),
    /** Requests made on `quotaDay`. Durable on purpose: a restart must not refill a quota. */
    quotaUsed: integer('quota_used').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_key').on(t.prefix),
    index('api_keys_owner_idx').on(t.ownerId),
    check('api_keys_scopes_not_empty', sql`cardinality(${t.scopes}) >= 1`),
    check('api_keys_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check('api_keys_name_length', sql`length(${t.name}) <= 60`),
    check('api_keys_quota_used_not_negative', sql`${t.quotaUsed} >= 0`),
    // Writing to the platform is not something a self-serve key may ever do. Enforced here
    // rather than only where keys are created, because "the UI would never send that" is not
    // a security control.
    check(
      'api_keys_owned_keys_are_read_only',
      sql`${t.ownerId} is null or not ('ingest:write' = any(${t.scopes}))`,
    ),
  ],
);

/** An out-of-stock → in-stock transition worth alerting on (FR-1.7). */
export const restockEvents = app.table(
  'restock_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    retailerProductId: uuid('retailer_product_id')
      .notNull()
      .references(() => retailerProducts.id, { onDelete: 'cascade' }),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => stockSnapshots.id, { onDelete: 'cascade' }),
    priceCents: integer('price_cents'),
    currency: text('currency').notNull().default('USD'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('restock_events_product_detected_idx').on(t.retailerProductId, t.detectedAt.desc()),
    uniqueIndex('restock_events_snapshot_key').on(t.snapshotId),
  ],
);

export const deliveryStatus = app.enum('delivery_status', ['pending', 'sent', 'failed', 'skipped']);

/**
 * One row per (event, subscription, channel). The unique index is the idempotency
 * guard: a retried fan-out can never send the same alert twice (FR-1.8).
 */
export const alertDeliveries = app.table(
  'alert_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    eventId: uuid('event_id')
      .notNull()
      .references(() => restockEvents.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => watchSubscriptions.id, { onDelete: 'cascade' }),
    channel: alertChannel('channel').notNull(),
    status: deliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Failure reason for operators; never contains recipient addresses (SR-X.20). */
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('alert_deliveries_event_subscription_channel_key').on(
      t.eventId,
      t.subscriptionId,
      t.channel,
    ),
    index('alert_deliveries_status_idx').on(t.status),
    check('alert_deliveries_attempts_nonneg', sql`${t.attempts} >= 0`),
  ],
);

/** Convenience view of what the scanner reports for one listing. */
export interface StockReport {
  retailerProductId: string;
  inStock: boolean;
  priceCents?: number | null;
  currency?: string;
  rawHash?: string | null;
}

export type RestockEvent = typeof restockEvents.$inferSelect;
export type AlertDelivery = typeof alertDeliveries.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
