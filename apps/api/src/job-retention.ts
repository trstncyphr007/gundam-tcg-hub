import { parseEnv } from '@gth/core';
import { createDb, retentionJob } from '@gth/db';
import { z } from 'zod';

/**
 * The nightly retention job, shipped inside the API image so the server runs exactly the code
 * that was built, scanned and signed (plan §15.5, §19).
 *
 *   docker compose --profile jobs run --rm retention
 *
 * It was previously only a pnpm script, which meant it could not run on the server at all:
 * the production image is distroless and has no pnpm, no tsx and no repository in it.
 *
 * Runs as the **worker**, whose grants are the point — it can do this job and nothing else.
 * Anything it deletes is deleted by a database function it cannot steer (ADR-035).
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
