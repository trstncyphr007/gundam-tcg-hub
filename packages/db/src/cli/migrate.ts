import { parseEnv } from '@gth/core';
import { z } from 'zod';
import { runMigrations } from '../migrate.js';

const { DATABASE_URL_MIGRATOR } = parseEnv(
  z.object({ DATABASE_URL_MIGRATOR: z.string().startsWith('postgres') }),
);

await runMigrations(DATABASE_URL_MIGRATOR);
console.log('migrations applied');
