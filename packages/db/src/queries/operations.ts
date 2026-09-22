import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

/**
 * What an operator needs to see at a glance: is the scanner reporting, are restocks being
 * found, are alerts going out (FR-1.12, plan §20).
 *
 * The scanner is a separate service (ADR-013), so from here its health *is* its reports: a
 * listing whose latest stock snapshot is older than twice its retailer's minimum interval has
 * stopped being checked, whatever the scanner itself believes. Twice, because the scanner
 * adds ±20% jitter to every interval (FR-1.6) — a listing one jitter late is normal, one
 * whole interval late is not.
 *
 * Aggregates only. No user appears anywhere in this: delivery failures are grouped by reason,
 * and `last_error` is written without recipient addresses (SR-X.20).
 */
export interface RetailerHealth {
  id: string;
  name: string;
  domain: string;
  enabled: boolean;
  minIntervalS: number;
  listings: number;
  healthy: number;
  stale: number;
  neverChecked: number;
  lastCheckedAt: Date | null;
}

export interface StaleListing {
  retailer: string;
  product: string;
  lastCheckedAt: Date | null;
  /**
   * How long past its expected next check (last check + the retailer's interval); null when
   * it has never been checked at all.
   */
  overdueSeconds: number | null;
}

export interface OperationsSummary {
  generatedAt: Date;
  retailers: RetailerHealth[];
  staleListings: StaleListing[];
  restocks: {
    last24h: number;
    last7d: number;
    recent: { product: string; retailer: string; detectedAt: Date }[];
  };
  deliveries: {
    /** Last 24 hours, by channel and outcome. */
    byChannel: { channel: string; status: string; count: number }[];
    /** The backlog: deliveries not yet attempted to completion. */
    pending: number;
    oldestPendingAt: Date | null;
    /** Why deliveries failed in the last 7 days, most common first. */
    failures: { reason: string; count: number; lastAt: Date }[];
  };
}

/** Raw `execute()` can return timestamps as strings; everything leaving here is a Date. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  return typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
}

const STALE_LISTING_LIMIT = 20;

export async function getOperationsSummary(
  db: Database,
  now: Date = new Date(),
): Promise<OperationsSummary> {
  const at = now.toISOString();

  // Each listing's most recent check. Listings with no snapshot at all are kept (left join):
  // "never checked" is its own problem, and the worst one.
  const latest = sql`
    select rp.id, rp.retailer_id, rp.sealed_product_id, max(s.checked_at) as last_checked
      from app.retailer_products rp
      left join app.stock_snapshots s
        on s.retailer_product_id = rp.id and s.checked_at <= ${at}::timestamptz
     group by rp.id`;
  const staleBefore = sql`(${at}::timestamptz - make_interval(secs => 2 * r.min_interval_s))`;

  const retailerRows = await db.execute<{
    id: string;
    name: string;
    domain: string;
    enabled: boolean;
    min_interval_s: number;
    listings: number;
    healthy: number;
    stale: number;
    never_checked: number;
    last_checked: unknown;
  }>(sql`
    with latest as (${latest})
    select r.id, r.name, r.domain, r.enabled, r.min_interval_s,
           count(l.id)::int as listings,
           count(*) filter (where l.last_checked >= ${staleBefore})::int as healthy,
           count(*) filter (where l.last_checked < ${staleBefore})::int as stale,
           count(*) filter (where l.id is not null and l.last_checked is null)::int as never_checked,
           max(l.last_checked) as last_checked
      from app.retailers r
      left join latest l on l.retailer_id = r.id
     group by r.id
     order by r.name`);

  const staleRows = await db.execute<{
    retailer: string;
    product: string;
    last_checked: unknown;
    overdue_seconds: number | null;
  }>(sql`
    with latest as (${latest})
    select r.name as retailer, p.name as product, l.last_checked,
           case when l.last_checked is null then null
                else extract(epoch from (${at}::timestamptz - l.last_checked))::int
                     - r.min_interval_s end as overdue_seconds
      from latest l
      join app.retailers r on r.id = l.retailer_id
      join app.sealed_products p on p.id = l.sealed_product_id
     where r.enabled
       and (l.last_checked is null or l.last_checked < ${staleBefore})
     order by l.last_checked asc nulls first
     limit ${STALE_LISTING_LIMIT}`);

  const [restockCounts] = await db.execute<{ last24h: number; last7d: number }>(sql`
    select count(*) filter (where detected_at >= ${at}::timestamptz - interval '24 hours')::int as last24h,
           count(*) filter (where detected_at >= ${at}::timestamptz - interval '7 days')::int as last7d
      from app.restock_events
     where detected_at <= ${at}::timestamptz`);

  const recentRestocks = await db.execute<{
    product: string;
    retailer: string;
    detected_at: unknown;
  }>(sql`
    select p.name as product, r.name as retailer, e.detected_at
      from app.restock_events e
      join app.retailer_products rp on rp.id = e.retailer_product_id
      join app.retailers r on r.id = rp.retailer_id
      join app.sealed_products p on p.id = rp.sealed_product_id
     where e.detected_at <= ${at}::timestamptz
     order by e.detected_at desc
     limit 10`);

  const byChannel = await db.execute<{ channel: string; status: string; count: number }>(sql`
    select channel::text as channel, status::text as status, count(*)::int as count
      from app.alert_deliveries
     where created_at >= ${at}::timestamptz - interval '24 hours'
       and created_at <= ${at}::timestamptz
     group by channel, status
     order by channel, status`);

  const [backlog] = await db.execute<{ pending: number; oldest: unknown }>(sql`
    select count(*)::int as pending, min(created_at) as oldest
      from app.alert_deliveries
     where status = 'pending'`);

  const failures = await db.execute<{ reason: string; count: number; last_at: unknown }>(sql`
    select coalesce(nullif(btrim(last_error), ''), '(no reason recorded)') as reason,
           count(*)::int as count, max(created_at) as last_at
      from app.alert_deliveries
     where status = 'failed'
       and created_at >= ${at}::timestamptz - interval '7 days'
     group by 1
     order by count desc, last_at desc
     limit 10`);

  return {
    generatedAt: now,
    retailers: retailerRows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      enabled: r.enabled,
      minIntervalS: r.min_interval_s,
      listings: r.listings,
      healthy: r.healthy,
      stale: r.stale,
      neverChecked: r.never_checked,
      lastCheckedAt: toDate(r.last_checked),
    })),
    staleListings: staleRows.map((r) => ({
      retailer: r.retailer,
      product: r.product,
      lastCheckedAt: toDate(r.last_checked),
      overdueSeconds: r.overdue_seconds,
    })),
    restocks: {
      last24h: restockCounts?.last24h ?? 0,
      last7d: restockCounts?.last7d ?? 0,
      recent: recentRestocks.map((r) => ({
        product: r.product,
        retailer: r.retailer,
        detectedAt: toDate(r.detected_at) ?? now,
      })),
    },
    deliveries: {
      byChannel: [...byChannel],
      pending: backlog?.pending ?? 0,
      oldestPendingAt: toDate(backlog?.oldest),
      failures: failures.map((f) => ({
        reason: f.reason,
        count: f.count,
        lastAt: toDate(f.last_at) ?? now,
      })),
    },
  };
}
