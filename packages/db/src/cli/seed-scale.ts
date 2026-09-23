import { parseEnv } from '@gth/core';
import { z } from 'zod';
import { createDb } from '../client.js';
import { seedScale } from '../seed/scale.js';

/**
 * Fill the catalog to the size the plan makes promises about (FR-1.3, §20).
 *
 *   pnpm db:seed-scale             # 10,000 cards, 30 days of prices
 *   pnpm db:seed-scale --cards 500 # something smaller
 *
 * Local only. It writes placeholder rows with a `SCALE-` set code so they are easy to find
 * and never confusable with a real catalog.
 */
const { DATABASE_URL_MIGRATOR } = parseEnv(
  z.object({ DATABASE_URL_MIGRATOR: z.string().startsWith('postgres') }),
);

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
    console.error(`--${name} must be a whole number between 1 and 1000000`);
    process.exit(1);
  }
  return value;
};

const { db, close } = createDb({ url: DATABASE_URL_MIGRATOR, max: 1 });
try {
  const started = Date.now();
  const result = await seedScale(db, { cards: flag('cards', 10_000), priceDays: flag('days', 30) });
  console.log(
    `seeded ${String(result.cards)} cards, ${String(result.variants)} variants, ` +
      `${String(result.priceRows)} price rows in ${String(Math.round((Date.now() - started) / 100) / 10)}s`,
  );
} finally {
  await close();
}
