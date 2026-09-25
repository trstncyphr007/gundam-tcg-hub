import { BUYER_HANDLE_RETENTION_DAYS } from '@gth/core';
import type { Database } from './client.js';
import { listFlagOverrides } from './queries/flags.js';
import { ingestLiveSales, purgeExpiredBuyerHandles } from './queries/live-sales.js';
import {
  DEFAULT_THRESHOLDS,
  type WatchdogThresholds,
  claimAlert,
  decideAlerts,
} from './queries/ops-alerts.js';
import { getOperationsSummary } from './queries/operations.js';
import { completeOrder, ordersReadyToComplete } from './queries/orders.js';
import { ingestBreakPulls, rollUpDay } from './queries/pricing.js';
import { runRetention } from './queries/retention.js';
import { getSecuritySummary } from './queries/security-events.js';

/**
 * The bodies of the two nightly jobs (`docs/runbooks/scheduled-jobs.md`).
 *
 * They live here, rather than in the CLI files that used to hold them, because they have to
 * run in two places: `pnpm price:rollup` / `pnpm db:retention` on a workstation, and inside
 * the production image, which is distroless and has no pnpm, no tsx and no repository. A job
 * that only exists as a developer command is a job that does not run on the server — which
 * was true of both of these until now.
 *
 * Each returns the lines it would print rather than printing them, so the caller decides
 * where they go and a test can read them.
 */
export async function retentionJob(db: Database): Promise<string[]> {
  const lines: string[] = [];

  const purged = await purgeExpiredBuyerHandles(db);
  lines.push(
    `erased ${String(purged)} buyer handle(s) older than ${String(BUYER_HANDLE_RETENTION_DAYS)} days`,
  );

  for (const line of await runRetention(db)) {
    lines.push(`deleted ${String(line.deleted)} ${line.what}`);
  }
  return lines;
}

/**
 * The watchdog (SR-X.22): look at what the operations page looks at, decide whether any of it
 * is worth saying out loud, and say it once.
 *
 * `notify` is optional on purpose. A host with no ops webhook configured still runs this — it
 * prints what it would have said and exits cleanly — so "nobody is listening" is a visible
 * state in the journal rather than a job that quietly does nothing.
 */
export async function watchdogJob(
  db: Database,
  notify: ((text: string) => Promise<{ ok: boolean | 'skipped'; reason?: string }>) | null,
  now: Date = new Date(),
  thresholds: WatchdogThresholds = DEFAULT_THRESHOLDS,
): Promise<string[]> {
  const [ops, security, overrides] = await Promise.all([
    getOperationsSummary(db, now),
    getSecuritySummary(db, now),
    listFlagOverrides(db),
  ]);
  const flagsOff = overrides.filter((flag) => !flag.enabled);

  const lines: string[] = [];
  for (const finding of decideAlerts(ops, security, now, thresholds, flagsOff)) {
    // Claimed first, sent second. The other order would re-send everything whenever a post
    // failed, which is how a broken webhook becomes a flood the moment it comes back.
    if (!(await claimAlert(db, finding))) {
      lines.push(`held back (said recently): ${finding.key}`);
      continue;
    }
    if (notify === null) {
      lines.push(`WOULD ALERT [${finding.severity}] ${finding.text}`);
      continue;
    }
    const outcome = await notify(`[${finding.severity}] ${finding.text}`);
    lines.push(
      outcome.ok === true
        ? `alerted: ${finding.key}`
        : `FAILED to alert ${finding.key}: ${outcome.reason ?? 'unknown'}`,
    );
  }
  return lines;
}

export interface RollupOptions {
  /** How many days back to recompute, ending today. Ignored when `day` is given. */
  days?: number;
  /** One specific day, as `YYYY-MM-DD`. */
  day?: string;
}

export async function rollupJob(db: Database, options: RollupOptions = {}): Promise<string[]> {
  const { days = 1, day } = options;
  if (!Number.isInteger(days) || days < 1 || days > 400) {
    throw new RangeError('days must be a whole number between 1 and 400');
  }

  const lines: string[] = [];

  // Pull logs first: they are our strongest source, and an observation that arrives after
  // the rollup would otherwise wait a whole day to count.
  const ingested = await ingestBreakPulls(db);
  lines.push(`ingested ${String(ingested)} new observation(s) from break pulls`);

  // Live sales, for the same reason and with one extra step: each is measured against the
  // published spread first, and one sitting far outside is recorded but held back until a
  // person has looked (SR-4.4). Flagged is not rejected.
  const live = await ingestLiveSales(db);
  lines.push(
    `ingested ${String(live.ingested)} from live sales ` +
      `(${String(live.flagged)} flagged for review, ` +
      `${String(live.unpriceable)} name no catalogued card)`,
  );

  const targets: Date[] = day
    ? [new Date(`${day}T00:00:00Z`)]
    : Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - 1 - i) * 86_400_000));

  let written = 0;
  let skipped = 0;
  for (const target of targets) {
    const result = await rollUpDay(db, target);
    written += result.written;
    skipped += result.skipped;
    lines.push(
      `${target.toISOString().slice(0, 10)}: ${String(result.written)} published, ` +
        `${String(result.skipped)} below the minimum`,
    );
  }

  lines.push(
    `${String(written)} index row(s) published, ${String(skipped)} left as "insufficient data"`,
  );
  return lines;
}

/**
 * Finish delivered orders whose hold window has passed (FR-5.4, FR-5.6).
 *
 * This is the `system` actor the order state machine talks about — the clock, and nothing else.
 * It is the only path from `delivered` to `completed` that does not involve an admin, and it
 * exists because neither party may finish their own sale: a seller marking it complete would be
 * marking their own homework, and a buyer doing it is AC-5.4's explicit "cannot".
 *
 * Runs on the worker role, which is the only one that can write `completed` at all.
 *
 * **One order failing does not stop the rest.** An order that has moved since it was listed —
 * disputed a minute ago, say — throws on the state machine, and the right response is to leave
 * that one alone and carry on. A job that abandons ninety-nine orders because the hundredth was
 * disputed is a job that quietly stops paying sellers.
 */
export async function completeDeliveredJob(
  db: Database,
  now: Date = new Date(),
): Promise<string[]> {
  const ready = await ordersReadyToComplete(db, now);
  if (ready.length === 0) return ['no delivered orders are past their hold window'];

  const lines: string[] = [];
  let completed = 0;
  const skipped: string[] = [];

  for (const order of ready) {
    try {
      await completeOrder(db, order.id, { actor: 'system' });
      completed += 1;
    } catch (error) {
      // Recorded by id rather than swallowed: "three orders would not complete" is a sentence
      // somebody needs to be able to read the next morning.
      skipped.push(`${order.id} (${error instanceof Error ? error.name : 'unknown'})`);
    }
  }

  lines.push(`completed ${String(completed)} of ${String(ready.length)} delivered order(s)`);
  if (skipped.length > 0) lines.push(`could not complete: ${skipped.join(', ')}`);
  return lines;
}
