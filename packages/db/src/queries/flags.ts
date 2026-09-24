import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

/**
 * Kill switches (plan §22, `docs/runbooks/incident.md`).
 *
 * Containment before investigation: the instinct in an incident is to understand it first,
 * and the runbook's advice is to stop the bleeding instead. These are what "stop" means.
 *
 * Two properties decide the whole design:
 *
 *  - **Absent means on.** Only overrides are stored, so the table is empty in normal
 *    operation, and anything that goes wrong with reading it — no row, no table, no database
 *    — leaves the site working rather than dark.
 *  - **Off is remembered, not erased.** A switch is restored by setting it back to true,
 *    which keeps the row, the reason and who flipped it. Deleting the evidence that the API
 *    was off for two hours is not an operation this offers, and no role has DELETE.
 */
export const FLAGS = {
  /**
   * Alert delivery. Off stops alerts being **sent** — by the fan-out inside the scanner's
   * request, and by the retry job, which until now did not read this switch at all.
   *
   * Deliveries already owed stay pending and untouched, and go out when it is back on. A
   * restock detected *while* it is off is still recorded, but creates no delivery, so nobody
   * is told about that one afterwards. The asymmetry is worth knowing: this switch pauses a
   * backlog, it does not queue new alerts up behind itself.
   */
  alertsEnabled: 'alerts.enabled',
  /** The public catalog and pricing API. Off answers 503; the console stays reachable. */
  publicApiEnabled: 'api.public.enabled',
  /** Scanner ingestion. Off refuses new stock reports without revoking anybody's key. */
  scannerIngestEnabled: 'scanner.ingest.enabled',
} as const;

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS];

export const ALL_FLAGS: FlagKey[] = Object.values(FLAGS);

export interface FlagState {
  key: string;
  enabled: boolean;
  reason: string;
  updatedAt: Date;
  updatedBy: string | null;
}

export function isKnownFlag(key: string): key is FlagKey {
  return (ALL_FLAGS as string[]).includes(key);
}

/** Every override currently stored. A key that is missing is on. */
export async function listFlagOverrides(db: Database): Promise<FlagState[]> {
  const rows = await db.execute<{
    key: string;
    enabled: boolean;
    reason: string;
    updated_at: string;
    updated_by: string | null;
  }>(sql`
    select key, enabled, reason, updated_at, updated_by
      from app.feature_flags
     order by key
  `);
  return rows.map((row) => ({
    key: row.key,
    enabled: row.enabled,
    reason: row.reason,
    updatedAt: new Date(row.updated_at),
    updatedBy: row.updated_by,
  }));
}

/** Every known switch, including the ones nobody has touched. */
export async function listFlags(db: Database): Promise<FlagState[]> {
  const overrides = new Map((await listFlagOverrides(db)).map((flag) => [flag.key, flag]));
  return ALL_FLAGS.map(
    (key) =>
      overrides.get(key) ?? {
        key,
        enabled: true,
        reason: '',
        updatedAt: new Date(0),
        updatedBy: null,
      },
  );
}

export async function setFlag(
  db: Database,
  key: FlagKey,
  enabled: boolean,
  actorId: string,
  reason: string,
): Promise<void> {
  await db.execute(sql`
    insert into app.feature_flags (key, enabled, reason, updated_by)
    values (${key}, ${enabled}, ${reason}, ${actorId})
    on conflict (key) do update
      set enabled = excluded.enabled,
          reason = excluded.reason,
          updated_by = excluded.updated_by,
          updated_at = now()
  `);
}

/**
 * A reader with a short memory.
 *
 * Every request would otherwise ask the database whether the API is switched on, which is a
 * query per request to answer "no" a few times a year. Ten seconds of staleness is the
 * trade the plan asks for, and it is the right one: an incident where ten more seconds of
 * traffic matters is an incident where the answer is `docker compose stop`, not a flag.
 *
 * **Fails on.** If the read throws, the last known answer is kept, and if there has never
 * been one, everything is enabled. A database wobble must not take the site down by itself.
 */
export interface FlagReader {
  isEnabled: (key: FlagKey) => Promise<boolean>;
  /** Drops the cached answers, so a flip is visible at once to the process that made it. */
  refresh: () => void;
}

export const FLAG_CACHE_TTL_MS = 10_000;

export function createFlagReader(
  db: Database,
  options: { ttlMs?: number; now?: () => number } = {},
): FlagReader {
  const { ttlMs = FLAG_CACHE_TTL_MS, now = Date.now } = options;
  let disabled = new Set<string>();
  let readAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  const load = async (): Promise<void> => {
    try {
      const overrides = await listFlagOverrides(db);
      disabled = new Set(overrides.filter((flag) => !flag.enabled).map((flag) => flag.key));
      readAt = now();
    } catch {
      // Keep whatever was known. A failed read is not a reason to turn anything off.
      readAt = now();
    } finally {
      inFlight = null;
    }
  };

  return {
    isEnabled: async (key) => {
      if (now() - readAt >= ttlMs) {
        // One read per expiry, however many requests arrive during it.
        inFlight ??= load();
        await inFlight;
      }
      return !disabled.has(key);
    },
    refresh: () => {
      readAt = -Infinity;
    },
  };
}
