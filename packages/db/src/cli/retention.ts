import { BUYER_HANDLE_RETENTION_DAYS, parseEnv } from '@gth/core';
import { z } from 'zod';
import { createDb } from '../client.js';
import { purgeExpiredBuyerHandles } from '../queries/live-sales.js';
import { runRetention } from '../queries/retention.js';

/**
 * Erase personal data that has outlived its purpose (SR-4.5, SR-X.23, SR-X.25).
 *
 *   pnpm db:retention
 *
 * Two steps, both nightly, in one command that is nothing else. It is written as its own
 * command rather than folded into the price rollup because a deletion job that only runs when
 * some other job succeeds is a deletion job that silently stops.
 *
 *   1. Buyer handles from the live-sale logger, ninety days after the sale. Runs on the
 *      **worker**, which by its grants can write that column and cannot read it (migration
 *      0024): erasing a name is the one operation that should never require seeing it.
 *   2. The sweep in migration 0035 — expired sessions and verification tokens, devices not
 *      seen in a year, and audit entries past the year the privacy policy publishes. Those
 *      tables are append-only or off-limits to the worker, so the deletions live in one
 *      database function that takes no arguments: the caller chooses *when* it runs, never
 *      *how far back* it reaches.
 */
const { DATABASE_URL_WORKER } = parseEnv(
  z.object({ DATABASE_URL_WORKER: z.string().startsWith('postgres') }),
);

const { db, close } = createDb({ url: DATABASE_URL_WORKER, max: 1 });
try {
  const purged = await purgeExpiredBuyerHandles(db);
  console.log(
    `erased ${String(purged)} buyer handle(s) older than ${String(BUYER_HANDLE_RETENTION_DAYS)} days`,
  );

  for (const line of await runRetention(db)) {
    console.log(`deleted ${String(line.deleted)} ${line.what}`);
  }
} finally {
  await close();
}
