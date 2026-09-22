import { parseEnv } from '@gth/core';
import { z } from 'zod';
import { createDb } from '../client.js';
import { rollupJob } from '../jobs.js';

/**
 * Build the published price index (FR-3.2).
 *
 *   pnpm price:rollup            # today
 *   pnpm price:rollup 2026-09-19 # one specific day
 *   pnpm price:rollup --days 7   # the last 7 days, oldest first
 *
 * Recomputes rather than updating in place, so it is safe to re-run: a late-arriving or
 * newly-approved observation is picked up on the next pass instead of being lost. That is
 * also why it runs nightly rather than on write -- a trimmed median cannot be nudged by
 * adding one number to yesterday's answer.
 *
 * The job itself is `rollupJob` in `../jobs.ts`, shared with the production image's
 * `dist/job-rollup.js`. Both run as the **worker**, which has exactly the grants this needs:
 * read observations, write the index, and nothing else.
 */
const { DATABASE_URL_WORKER } = parseEnv(
  z.object({ DATABASE_URL_WORKER: z.string().startsWith('postgres') }),
);

const args = process.argv.slice(2);
const daysFlag = args.indexOf('--days');
const days = daysFlag === -1 ? 1 : Number(args[daysFlag + 1] ?? 1);
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

const { db, close } = createDb({ url: DATABASE_URL_WORKER, max: 1 });
try {
  for (const line of await rollupJob(db, day === undefined ? { days } : { day })) {
    console.log(line);
  }
} catch (error) {
  if (error instanceof RangeError) {
    console.error(error.message);
    process.exitCode = 1;
  } else throw error;
} finally {
  await close();
}
