import { parseEnv } from '@gth/core';
import { z } from 'zod';
import { createDb } from '../client.js';
import { SYNTHETIC_EVIDENCE, seedSamplePrices } from '../seed/prices.js';

/**
 * Fill the price index with synthetic data, for local development.
 *
 *   pnpm db:seed-prices             # 90 days
 *   pnpm db:seed-prices --days 30
 *
 * Writes only about the sample catalog and stamps every row `seed:synthetic`, so it can
 * neither touch real cards nor be mistaken for real observations. Refuses outright in
 * production: a published price index with invented numbers in it is the one thing this
 * project cannot afford.
 */
const { DATABASE_URL_MIGRATOR, NODE_ENV } = parseEnv(
  z.object({
    DATABASE_URL_MIGRATOR: z.string().startsWith('postgres'),
    NODE_ENV: z.string().default('development'),
  }),
);

if (NODE_ENV === 'production') {
  console.error('refusing to seed synthetic prices in production');
  process.exit(1);
}

const args = process.argv.slice(2);
const daysFlag = args.indexOf('--days');
const days = daysFlag === -1 ? 90 : Number(args[daysFlag + 1] ?? 90);

if (!Number.isInteger(days) || days < 1 || days > 400) {
  console.error('--days must be a whole number between 1 and 400');
  process.exit(1);
}

const { db, close } = createDb({ url: DATABASE_URL_MIGRATOR, max: 1 });
try {
  const result = await seedSamplePrices(db, { days });

  if (result.variants === 0) {
    console.log(
      'no sample catalog found, so nothing was written.\n' +
        'run `pnpm db:seed` first — this only ever writes about SAMPLE-01 cards.',
    );
  } else {
    console.log(
      `${String(result.observations)} synthetic observations across ` +
        `${String(result.variants)} printings and ${String(days)} days\n` +
        `${String(result.published)} index rows published, ` +
        `${String(result.skipped)} left as "insufficient data"\n\n` +
        `every row is tagged ${SYNTHETIC_EVIDENCE}; remove them with\n` +
        `  delete from app.price_observations where evidence_ref = '${SYNTHETIC_EVIDENCE}';`,
    );
  }
} finally {
  await close();
}
