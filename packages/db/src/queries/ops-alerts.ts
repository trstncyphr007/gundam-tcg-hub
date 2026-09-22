import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import type { OperationsSummary } from './operations.js';
import type { SecuritySummary } from './security-events.js';

/**
 * Deciding what is worth waking somebody for (SR-X.22, §20).
 *
 * Two rules shape all of this:
 *
 *  - **An alert that fires every quarter of an hour is not an alert.** Each finding carries a
 *    key and a repeat interval; `claimAlert` grants the right to speak at most once per
 *    interval, in one statement, so two overlapping runs cannot both take it.
 *  - **Silence must be distinguishable from death.** A watchdog that only speaks when
 *    something is wrong is indistinguishable from one that stopped running, so it also says
 *    "all clear" once a day.
 */
export interface Finding {
  /** Stable across runs: it is what the repeat interval is remembered against. */
  key: string;
  severity: 'critical' | 'warning' | 'info';
  text: string;
  /** How long before this may be said again. */
  repeatAfterS: number;
}

export interface WatchdogThresholds {
  /** Failed sign-ins in an hour, across everything. */
  failedSignInsPerHour: number;
  /** Failed sign-ins in a day from one source — a single hash grinding away. */
  failedSignInsPerSource: number;
  /** Rate-limit refusals in an hour, across everything. */
  rateLimitedPerHour: number;
  /** How long a delivery backlog may sit before it counts as stuck, in seconds. */
  stuckBacklogS: number;
  /** How long an enabled retailer may go unreported before the scanner counts as silent. */
  scannerSilentS: number;
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  // Chosen to be quiet on a normal day and loud on a bad one. A handful of people mistyping
  // their address in an hour is ordinary; thirty is not.
  failedSignInsPerHour: 30,
  failedSignInsPerSource: 15,
  // The public limit is 120/minute per address, so being refused two hundred times in an hour
  // means something is hammering rather than mis-sized.
  rateLimitedPerHour: 200,
  stuckBacklogS: 15 * 60,
  scannerSilentS: 2 * 60 * 60,
};

const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;

function ageS(from: Date | string | null, now: Date): number | null {
  if (from === null) return null;
  return (now.getTime() - new Date(from).getTime()) / 1000;
}

/**
 * Pure: summaries in, findings out. The thresholds are the interesting part of this file and
 * the easiest thing to get wrong, so nothing here touches a database or a clock it was not
 * handed.
 */
export function decideAlerts(
  ops: OperationsSummary,
  security: SecuritySummary,
  now: Date,
  thresholds: WatchdogThresholds = DEFAULT_THRESHOLDS,
): Finding[] {
  const findings: Finding[] = [];
  const count = (action: string): { lastHour: number; last24h: number } => {
    const row = security.counts.find((c) => c.action === action);
    return { lastHour: row?.lastHour ?? 0, last24h: row?.last24h ?? 0 };
  };

  const failed = count('auth.sign_in_failed');
  if (failed.lastHour >= thresholds.failedSignInsPerHour) {
    findings.push({
      key: 'auth.failed_spike',
      severity: 'critical',
      text: `${String(failed.lastHour)} failed sign-ins in the last hour (${String(failed.last24h)} today). Check /admin/operations.`,
      repeatAfterS: HOUR_S,
    });
  }

  const worst = security.noisySources[0];
  if (worst && worst.attempts >= thresholds.failedSignInsPerSource) {
    findings.push({
      key: 'auth.noisy_source',
      severity: 'warning',
      text: `One source (…${worst.source}) has been refused ${String(worst.attempts)} times today.`,
      repeatAfterS: 6 * HOUR_S,
    });
  }

  const limited = count('api.rate_limited').lastHour + count('auth.rate_limited').lastHour;
  if (limited >= thresholds.rateLimitedPerHour) {
    findings.push({
      key: 'api.rate_limit_storm',
      severity: 'warning',
      text: `${String(limited)} rate-limit refusals in the last hour.`,
      repeatAfterS: 6 * HOUR_S,
    });
  }

  const backlogS = ageS(ops.deliveries.oldestPendingAt, now);
  if (backlogS !== null && backlogS > thresholds.stuckBacklogS) {
    findings.push({
      key: 'alerts.backlog_stuck',
      severity: 'critical',
      text: `Alert deliveries have stopped moving: ${String(ops.deliveries.pending)} waiting, oldest ${String(Math.round(backlogS / 60))} minutes old.`,
      repeatAfterS: 2 * HOUR_S,
    });
  }

  // The scanner is a separate service, so "it has stopped reporting" is the only thing this
  // side can honestly say about it — and it is the thing worth saying (ADR-033).
  const silent = ops.retailers.filter(
    (r) => r.enabled && (ageS(r.lastCheckedAt, now) ?? Infinity) > thresholds.scannerSilentS,
  );
  if (silent.length > 0) {
    findings.push({
      key: 'scanner.silent',
      severity: 'critical',
      text: `The scanner has reported nothing for ${silent.length === 1 ? '' : `${String(silent.length)} retailers, including `}${String(silent[0]?.name)} in over ${String(Math.round(thresholds.scannerSilentS / 3600))} hours.`,
      repeatAfterS: 6 * HOUR_S,
    });
  }

  // Said last, and always: a quiet channel should mean "nothing is wrong", not "the watchdog
  // died on Tuesday". The daily interval is what makes this a dead-man's switch rather than
  // noise.
  findings.push({
    key: 'watchdog.heartbeat',
    severity: 'info',
    text:
      findings.length === 0
        ? 'All clear. Scanner reporting, deliveries moving, nothing unusual at the door.'
        : `Watchdog is running; ${String(findings.length)} thing(s) currently need attention.`,
    repeatAfterS: DAY_S,
  });

  return findings;
}

/**
 * Take the right to say this, or find that somebody already did.
 *
 * One statement, so two runs that overlap cannot both decide they are the one to speak — and
 * the state lives in the database rather than in the process, so restarting the job does not
 * reset anyone's peace and quiet.
 */
export async function claimAlert(
  db: Database,
  finding: Pick<Finding, 'key' | 'repeatAfterS' | 'text'>,
): Promise<boolean> {
  const rows = await db.execute<{ claimed: boolean }>(
    sql`select app.claim_ops_alert(${finding.key}, ${finding.repeatAfterS}, ${finding.text}) as claimed`,
  );
  return rows[0]?.claimed === true;
}
