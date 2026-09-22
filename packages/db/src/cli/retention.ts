import { parseEnv } from '@gth/core';
import { z } from 'zod';
import { createDb } from '../client.js';
import { retentionJob } from '../jobs.js';

/**
 * Erase personal data that has outlived its purpose (SR-4.5, SR-X.23, SR-X.25).
 *
 *   pnpm db:retention
 *
 * The job itself is `retentionJob` in `../jobs.ts`, so that the same code runs here and from
 * the production image (`dist/job-retention.js`), which has no pnpm to run this file with.
 *
 * It is a command of its own, rather than a step of the price rollup, because a deletion job
 * that only runs when some other job succeeds is a deletion job that silently stops.
 */
const { DATABASE_URL_WORKER } = parseEnv(
  z.object({ DATABASE_URL_WORKER: z.string().startsWith('postgres') }),
);

const { db, close } = createDb({ url: DATABASE_URL_WORKER, max: 1 });
try {
  for (const line of await retentionJob(db)) console.log(line);
} finally {
  await close();
}
