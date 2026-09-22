import { BUYER_HANDLE_RETENTION_DAYS } from '@gth/core';
import type { Database } from './client.js';
import { ingestLiveSales, purgeExpiredBuyerHandles } from './queries/live-sales.js';
import { ingestBreakPulls, rollUpDay } from './queries/pricing.js';
import { runRetention } from './queries/retention.js';

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
