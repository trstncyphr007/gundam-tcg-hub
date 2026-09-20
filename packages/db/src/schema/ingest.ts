import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { app, retailerProducts, stockSnapshots } from './catalog.js';
import { alertChannel, watchSubscriptions } from './watches.js';

export const apiKeyScope = app.enum('api_key_scope', ['ingest:write', 'catalog:read']);

/**
 * Machine credentials (the scanner). Only a keyed hash is stored, never the secret
 * itself (SR-3.1); the plaintext is shown once at creation.
 */
export const apiKeys = app.table(
  'api_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    /** Public lookup handle, so we never scan every row to find a key. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: apiKeyScope('scopes').array().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_prefix_key').on(t.prefix),
    check('api_keys_scopes_not_empty', sql`cardinality(${t.scopes}) >= 1`),
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
