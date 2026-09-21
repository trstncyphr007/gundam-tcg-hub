import { BUYER_HANDLE_RETENTION_DAYS, parseEnv } from '@gth/core';
import { z } from 'zod';
import { createDb } from '../client.js';
import { purgeExpiredBuyerHandles } from '../queries/live-sales.js';

/**
 * Erase personal data that has outlived its purpose (SR-4.5, SR-X.25).
 *
 *   pnpm db:retention
 *
 * Today that is one thing: buyer handles from the live-sale logger, ninety days after the
 * sale. It runs nightly, and it is written as its own command rather than folded into the
 * price rollup because a deletion job that only runs when some other job succeeds is a
 * deletion job that silently stops.
 *
 * Runs as the **worker**, which by its grants can write these columns and cannot read them
 * (migration 0024). Erasing a name is the one operation that should never require seeing it.
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
} finally {
  await close();
}
