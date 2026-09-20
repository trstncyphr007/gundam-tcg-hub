import { parseEnv } from '@gth/core';
import { runMigrations } from '@gth/db';
import { z } from 'zod';

/**
 * One-off migration entry point, shipped inside the API image so deploys run exactly the
 * migrations that were built and scanned (plan §15.5 step 5).
 *
 * Runs as app_migrator, the only role with DDL rights.
 */
const { DATABASE_URL_MIGRATOR } = parseEnv(
  z.object({ DATABASE_URL_MIGRATOR: z.string().startsWith('postgres') }),
);

await runMigrations(DATABASE_URL_MIGRATOR);
console.log('migrations applied');
