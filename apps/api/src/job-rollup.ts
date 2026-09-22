import { parseEnv } from '@gth/core';
import { createDb, rollupJob } from '@gth/db';
import { z } from 'zod';

/**
 * The nightly price rollup, shipped inside the API image for the same reason as the retention
 * job beside it (plan §15.5, FR-3.2).
 *
 *   docker compose --profile jobs run --rm rollup
 *
 * Takes no arguments here: the server recomputes the current day. Re-running is safe — the
 * rollup recomputes rather than adjusts — so a missed night is picked up by the next one, and
 * a backfill is a workstation command (`pnpm price:rollup --days 7`), not a server one.
 */
const { DATABASE_URL_WORKER } = parseEnv(
  z.object({ DATABASE_URL_WORKER: z.string().startsWith('postgres') }),
);

const { db, close } = createDb({ url: DATABASE_URL_WORKER, max: 1 });
try {
  for (const line of await rollupJob(db)) console.log(line);
} finally {
  await close();
}
