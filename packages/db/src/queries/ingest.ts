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

/**
 * Deliveries that are still owed, and may be tried again (FR-1.8).
 *
 * `pending` means "nobody has managed to send this yet", which covers two situations that look
 * the same from here and are both alerts a person asked for and did not get:
 *
 *  - a transport said it failed and might not next time — a Discord 429, a 5xx, a timeout;
 *  - nothing said anything, because the process died between claiming the row and sending it.
 *
 * `created_at` older than `staleAfter` keeps this off rows a fan-out is working on right now,
 * and `FOR UPDATE SKIP LOCKED` keeps two runs off each other.
 *
 * Bounded by the event's age as well as by attempts. A restock alert is worth having for a few
 * hours and worth nothing the next day — telling somebody a box came back in stock yesterday
 * is not a late alert, it is a wrong one.
 */
export interface RetryableDelivery {
  id: string;
  eventId: string;
  subscriptionId: string;
  channel: 'email' | 'discord_dm' | 'discord_webhook' | 'web_push';
  attempts: number;
  retailerProductId: string;
  /** From the event, so a retry says what the first attempt would have said. */
  priceCents: number | null;
  currency: string;
  /** When the stock actually came back — not when we got round to saying so. */
  detectedAt: Date;
}

/** What the driver actually hands back: `db.execute` needs an indexable shape, and a raw
 * timestamptz arrives as a string. Kept separate so the exported type stays honest. */
interface RetryableRow extends Omit<RetryableDelivery, 'detectedAt'> {
  [key: string]: unknown;
  detectedAt: string;
}

export async function claimRetryableDeliveries(
  db: Database,
  options: {
    maxAttempts?: number;
    staleAfterSeconds?: number;
    eventWithinHours?: number;
    limit?: number;
  } = {},
): Promise<RetryableDelivery[]> {
  const { maxAttempts = 5, staleAfterSeconds = 120, eventWithinHours = 24, limit = 200 } = options;
  // Raw SQL, so the driver hands back what Postgres sent: `detected_at` arrives as a string,
  // not a Date. Declaring it a Date and passing it straight into a message would have thrown
  // the first time anything formatted it — at the far end of a retry nobody was watching. It
  // is converted here, where the type is claimed, rather than trusted downstream.
  const rows = await db.execute<RetryableRow>(sql`
    select d.id,
           d.event_id        as "eventId",
           d.subscription_id as "subscriptionId",
           d.channel,
           d.attempts,
           e.retailer_product_id as "retailerProductId",
           e.price_cents         as "priceCents",
           e.currency,
           e.detected_at         as "detectedAt"
      from app.alert_deliveries d
      join app.restock_events e on e.id = d.event_id
     where d.status = 'pending'
       and d.attempts < ${maxAttempts}
       and d.created_at < now() - make_interval(secs => ${staleAfterSeconds})
       and e.detected_at > now() - make_interval(hours => ${eventWithinHours})
     order by d.created_at
     limit ${limit}
     for update of d skip locked
  `);
  return rows.map((row) => ({ ...row, detectedAt: new Date(row.detectedAt) }));
}

/** Give up on a delivery that has been tried as often as it is going to be. */
export async function abandonDelivery(db: Database, id: string, reason: string): Promise<void> {
  await db
    .update(alertDeliveries)
    .set({ status: 'failed', lastError: reason.slice(0, 300) })
    .where(eq(alertDeliveries.id, id));
}

export async function markDeliveryFailed(
  db: Database,
  id: string,
  reason: string,
  status: 'failed' | 'skipped' | 'pending' = 'failed',
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

/**
 * Count one request against a key's daily allowance, and say how many that makes (FR-3.7).
 *
 * One statement, because two would race: between a read and a write, any number of other
 * requests can pass. The row lock an UPDATE takes is what serialises concurrent callers using
 * the same key, and the whole roll-over is expressed inside it -- the CASE reads the *old*
 * `quota_day`, so the first request of a new day resets to 1 without anybody scheduling
 * anything. There is no sweeper, no cron, and no key that quietly keeps yesterday's count.
 *
 * The day is UTC and explicitly so. It would otherwise follow the connection's TimeZone
 * setting, which would make a published limit depend on a container's environment.
 *
 * Returns null when the key has gone -- revoked and deleted mid-flight -- which the caller
 * treats as "no durable answer" rather than as a refusal.
 */
export async function consumeApiKeyQuota(db: Database, id: string): Promise<number | null> {
  const rows = await db.execute<{ quota_used: number }>(sql`
    update app.api_keys
       set quota_day  = timezone('utc', now())::date,
           quota_used = case
                          when quota_day = timezone('utc', now())::date then quota_used + 1
                          else 1
                        end
     where id = ${id}::uuid
    returning quota_used
  `);
  return rows[0]?.quota_used ?? null;
}

/** Seconds until the UTC day rolls over, which is when a daily quota comes back. */
export function secondsUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    /* midnight */ 0,
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export async function createApiKey(
  db: Database,
  input: {
    name: string;
    prefix: string;
    keyHash: string;
    scopes: ('ingest:write' | 'catalog:read' | 'prices:read')[];
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
