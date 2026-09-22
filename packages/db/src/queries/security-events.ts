import { and, desc, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { auditLog } from '../schema/audit.js';

/**
 * What the audit log says about attempts that failed (SR-X.21, SR-X.22).
 *
 * Aggregates only. The point of the summary is to answer "is something happening right now?"
 * — a number that jumps answers it, and naming people would add nothing except a reason to be
 * careful about who may read the page.
 *
 * Sources are counted by that day's hash (ADR-028), so "one source, three hundred attempts"
 * is sayable within a day and nothing follows anyone past midnight.
 */
export const WATCHED_ACTIONS = [
  'auth.sign_in_failed',
  'auth.rate_limited',
  'api.rate_limited',
] as const;

export type WatchedAction = (typeof WATCHED_ACTIONS)[number];

export interface ActionCounts {
  action: string;
  lastHour: number;
  last24h: number;
  last7d: number;
}

export interface NoisySource {
  /** That day's hash, shortened for display — never an address. */
  source: string;
  attempts: number;
  lastAt: Date;
}

export interface SecuritySummary {
  generatedAt: Date;
  counts: ActionCounts[];
  /** The busiest sources in the last day, at most five. */
  noisySources: NoisySource[];
  /** The endpoints refusing most often in the last day, at most five. */
  endpoints: { endpoint: string; attempts: number }[];
}

const NOISY_LIMIT = 5;
const HOUR_MS = 60 * 60 * 1000;

export async function getSecuritySummary(
  db: Database,
  now: Date = new Date(),
): Promise<SecuritySummary> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - 24 * HOUR_MS);
  const weekAgo = new Date(now.getTime() - 7 * 24 * HOUR_MS);
  // Inside a raw fragment the driver gets no column to infer a type from, so the boundary
  // goes in as text with the cast spelled out. A Date there fails at bind time.
  const since = (at: Date) => sql`${at.toISOString()}::timestamptz`;
  const watched = [...WATCHED_ACTIONS];
  const recent = and(inArray(auditLog.action, watched), gte(auditLog.at, weekAgo));

  const counted = await db
    .select({
      action: auditLog.action,
      lastHour: sql<number>`count(*) filter (where ${auditLog.at} >= ${since(hourAgo)})::int`,
      last24h: sql<number>`count(*) filter (where ${auditLog.at} >= ${since(dayAgo)})::int`,
      last7d: sql<number>`count(*)::int`,
    })
    .from(auditLog)
    .where(recent)
    .groupBy(auditLog.action);

  // Every watched action appears, even at zero: a quiet hour and a hook that stopped writing
  // must not look the same on the page.
  const found = new Map(counted.map((row) => [row.action, row]));
  const counts: ActionCounts[] = watched.map((action) => {
    const row = found.get(action);
    return {
      action,
      lastHour: row?.lastHour ?? 0,
      last24h: row?.last24h ?? 0,
      last7d: row?.last7d ?? 0,
    };
  });

  const inTheLastDay = and(inArray(auditLog.action, watched), gte(auditLog.at, dayAgo));

  const attempts = sql<number>`count(*)::int`;
  const lastAt = sql<Date>`max(${auditLog.at})`;

  const noisy = await db
    .select({ source: auditLog.ipHash, attempts, lastAt })
    .from(auditLog)
    .where(and(inTheLastDay, isNotNull(auditLog.ipHash)))
    .groupBy(auditLog.ipHash)
    .orderBy(desc(attempts), desc(lastAt))
    .limit(NOISY_LIMIT);

  const endpoints = await db
    .select({ endpoint: sql<string>`coalesce(${auditLog.targetId}, 'unknown')`, attempts })
    .from(auditLog)
    .where(inTheLastDay)
    .groupBy(sql`1`)
    .orderBy(desc(attempts))
    .limit(NOISY_LIMIT);

  return {
    generatedAt: now,
    counts,
    noisySources: noisy.map((row) => ({
      // Eight characters tell two sources apart on a page, and the whole value is meaningless
      // tomorrow in any case.
      source: String(row.source).slice(-8),
      attempts: row.attempts,
      lastAt: new Date(row.lastAt),
    })),
    endpoints: endpoints.map((row) => ({
      endpoint: row.endpoint,
      attempts: row.attempts,
    })),
  };
}
