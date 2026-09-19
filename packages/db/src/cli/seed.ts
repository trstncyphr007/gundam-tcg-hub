import { parseEnv } from '@gth/core';
import { z } from 'zod';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';

const { NODE_ENV, DATABASE_URL_MIGRATOR } = parseEnv(
  z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL_MIGRATOR: z.string().startsWith('postgres'),
  }),
);

if (NODE_ENV === 'production') {
  throw new Error('refusing to seed sample data in production');
}

const { db, close } = createDb({ url: DATABASE_URL_MIGRATOR, max: 1 });
try {
  await seedSample(db);
  console.log('sample catalog seeded');
} finally {
  await close();
}
