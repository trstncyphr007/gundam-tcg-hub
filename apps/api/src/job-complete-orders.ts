import { AUTO_COMPLETE_AFTER_DAYS, parseEnv } from '@gth/core';
import { completeDeliveredJob, createDb } from '@gth/db';
import { z } from 'zod';

/**
 * Finish delivered orders whose hold window has passed (FR-5.4, FR-5.6).
 *
 *   docker compose --profile jobs run --rm complete-orders
 *
 * This is the `system` actor the order state machine talks about — the clock, and nothing else.
 * Neither party may finish their own sale: a seller marking it complete would be marking their
 * own homework, and a buyer doing it is AC-5.4's explicit "cannot". So `delivered → completed`
 * has exactly two paths, and this is the one that does not need a person.
 *
 * Shipped inside the API image for the same reason as the other jobs: the production image is
 * distroless, with no pnpm, no tsx and no repository to run a script from. A job that exists
 * only as a developer command is a job that does not run on the server.
 *
 * Runs as the **worker**, which is the only role that can write `completed` at all. If this
 * file were wired to the web pool by mistake it would not quietly complete orders on the wrong
 * role — every statement would be refused.
 */
const { DATABASE_URL_WORKER } = parseEnv(
  z.object({ DATABASE_URL_WORKER: z.string().startsWith('postgres') }),
);

const { db, close } = createDb({ url: DATABASE_URL_WORKER, max: 1 });
try {
  console.log(`completing delivered orders older than ${String(AUTO_COMPLETE_AFTER_DAYS)} days`);
  for (const line of await completeDeliveredJob(db)) console.log(line);
} finally {
  await close();
}
