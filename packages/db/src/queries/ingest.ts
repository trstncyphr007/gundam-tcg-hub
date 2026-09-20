import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { users } from '../schema/auth.js';
import { retailerProducts, stockSnapshots } from '../schema/catalog.js';
import {
  type AlertDelivery,
  type ApiKey,
  type RestockEvent,
  alertDeliveries,
  apiKeys,
  restockEvents,
} from '../schema/ingest.js';
import { watchSubscriptions } from '../schema/watches.js';

export interface StockReportInput {
  retailerProductId: string;
  inStock: boolean;
  priceCents?: number | null | undefined;
  currency?: string | undefined;
  rawHash?: string | null | undefined;
}

export interface IngestResult {
  snapshotId: string;
  /** Present only when this report is an out-of-stock → in-stock transition. */
  event: RestockEvent | null;
  /** True when this listing had no previous snapshot (first sighting never alerts). */
  firstSighting: boolean;
}

/**
 * Record one scanner observation and decide whether it is a restock.
 *
 * Runs in a single transaction so a concurrent report cannot interleave between reading
 * the previous state and writing the new one. Only a false → true transition raises an
 * event; a first sighting never does, otherwise enabling a new listing would alert
 * everybody watching it (FR-1.7).
 */
export async function recordStockReport(
  db: Database,
  report: StockReportInput,
): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ inStock: stockSnapshots.inStock })
      .from(stockSnapshots)
      .where(eq(stockSnapshots.retailerProductId, report.retailerProductId))
      .orderBy(desc(stockSnapshots.checkedAt))
      .limit(1);

    const [snapshot] = await tx
      .insert(stockSnapshots)
      .values({
        retailerProductId: report.retailerProductId,
        inStock: report.inStock,
        priceCents: report.priceCents ?? null,
        currency: report.currency ?? 'USD',
        rawHash: report.rawHash ?? null,
      })
      .returning();
    if (!snapshot) throw new Error('ingest: snapshot insert returned no row');

    const firstSighting = previous === undefined;
    const isTransition = !firstSighting && !previous.inStock && report.inStock;
    if (!isTransition) return { snapshotId: snapshot.id, event: null, firstSighting };

    const [event] = await tx
      .insert(restockEvents)
      .values({
        retailerProductId: report.retailerProductId,
        snapshotId: snapshot.id,
        priceCents: report.priceCents ?? null,
        currency: report.currency ?? 'USD',
      })
      .returning();
    if (!event) throw new Error('ingest: event insert returned no row');
    return { snapshotId: snapshot.id, event, firstSighting };
  });
}

export interface FanOutTarget {
  subscriptionId: string;
  userId: string;
  email: string;
  displayName: string | null;
  channels: string[];
}

/**
 * Everyone watching the listing itself or the product it belongs to.
 * Requires a role that may read all watches (app_worker); RLS blocks app_web here.
 */
export async function findFanOutTargets(
  db: Database,
  retailerProductId: string,
): Promise<FanOutTarget[]> {
  const [listing] = await db
    .select({ sealedProductId: retailerProducts.sealedProductId })
    .from(retailerProducts)
    .where(eq(retailerProducts.id, retailerProductId))
    .limit(1);
  if (!listing) return [];

  return db
    .select({
      subscriptionId: watchSubscriptions.id,
      userId: watchSubscriptions.userId,
      email: users.email,
      displayName: users.displayName,
      channels: watchSubscriptions.channels,
    })
    .from(watchSubscriptions)
    .innerJoin(users, eq(users.id, watchSubscriptions.userId))
    .where(
      or(
        eq(watchSubscriptions.retailerProductId, retailerProductId),
        eq(watchSubscriptions.sealedProductId, listing.sealedProductId),
      ),
    );
}

/**
 * Claim delivery slots for an event. The unique (event, subscription, channel) index makes
 * this idempotent: rows already claimed by an earlier attempt are skipped, so a retry never
 * re-sends (FR-1.8).
 */
export async function claimDeliveries(
  db: Database,
  eventId: string,
  targets: FanOutTarget[],
): Promise<AlertDelivery[]> {
  const rows = targets.flatMap((target) =>
    target.channels.map((channel) => ({
      eventId,
      subscriptionId: target.subscriptionId,
      channel: channel as 'email' | 'discord_dm' | 'discord_webhook' | 'web_push',
    })),
  );
  if (rows.length === 0) return [];
  return db.insert(alertDeliveries).values(rows).onConflictDoNothing().returning();
}

export async function markDeliverySent(db: Database, id: string): Promise<void> {
  await db
    .update(alertDeliveries)
    .set({ status: 'sent', sentAt: new Date(), attempts: sql`${alertDeliveries.attempts} + 1` })
    .where(eq(alertDeliveries.id, id));
}

export async function markDeliveryFailed(
  db: Database,
  id: string,
  reason: string,
  status: 'failed' | 'skipped' = 'failed',
): Promise<void> {
  await db
    .update(alertDeliveries)
    .set({
      status,
      // Truncated and free of recipient data: operators only need the cause.
      lastError: reason.slice(0, 300),
      attempts: sql`${alertDeliveries.attempts} + 1`,
    })
    .where(eq(alertDeliveries.id, id));
}

export async function listDeliveriesForEvent(
  db: Database,
  eventId: string,
): Promise<AlertDelivery[]> {
  return db.select().from(alertDeliveries).where(eq(alertDeliveries.eventId, eventId));
}

/** Look up an active key by its public prefix. The secret is verified by the caller. */
export async function findActiveApiKey(db: Database, prefix: string): Promise<ApiKey | null> {
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
    .limit(1);
  return key ?? null;
}

export async function touchApiKey(db: Database, id: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}

export async function createApiKey(
  db: Database,
  input: {
    name: string;
    prefix: string;
    keyHash: string;
    scopes: ('ingest:write' | 'catalog:read')[];
  },
): Promise<ApiKey> {
  const [key] = await db.insert(apiKeys).values(input).returning();
  if (!key) throw new Error('api key insert returned no row');
  return key;
}

export async function revokeApiKey(db: Database, prefix: string): Promise<boolean> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}
