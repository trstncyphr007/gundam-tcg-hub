import { parseEnv } from '@gth/core';
import { z } from 'zod';
import { createDb } from '../client.js';
import { ingestLiveSales } from '../queries/live-sales.js';
import { ingestBreakPulls, rollUpDay } from '../queries/pricing.js';

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
 * Runs as the migrator here. In production this is the worker's job, which has exactly the
 * grants it needs: read observations, write the index, and nothing else.
 */
const { DATABASE_URL_MIGRATOR } = parseEnv(
  z.object({ DATABASE_URL_MIGRATOR: z.string().startsWith('postgres') }),
);

const args = process.argv.slice(2);
const daysFlag = args.indexOf('--days');
const days = daysFlag === -1 ? 1 : Number(args[daysFlag + 1] ?? 1);
const explicitDay = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

if (!Number.isInteger(days) || days < 1 || days > 400) {
  console.error('--days must be a whole number between 1 and 400');
  process.exit(1);
}

const { db, close } = createDb({ url: DATABASE_URL_MIGRATOR, max: 1 });
try {
  // Pull logs first: they are our strongest source, and an observation that arrives after
  // the rollup would otherwise wait a whole day to count.
  const ingested = await ingestBreakPulls(db);
  console.log(`ingested ${String(ingested)} new observation(s) from break pulls`);

  // Live sales, for the same reason and with one extra step: each is measured against the
  // published spread first, and one sitting far outside is recorded but held back until a
  // person has looked (SR-4.4). Flagged is not rejected.
  const live = await ingestLiveSales(db);
  console.log(
    `ingested ${String(live.ingested)} from live sales ` +
      `(${String(live.flagged)} flagged for review, ` +
      `${String(live.unpriceable)} name no catalogued card)`,
  );

  const targets: Date[] = explicitDay
    ? [new Date(`${explicitDay}T00:00:00Z`)]
    : Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - 1 - i) * 86_400_000));

  let written = 0;
  let skipped = 0;
  for (const day of targets) {
    const result = await rollUpDay(db, day);
    written += result.written;
    skipped += result.skipped;
    console.log(
      `${day.toISOString().slice(0, 10)}: ${String(result.written)} published, ` +
        `${String(result.skipped)} below the minimum`,
    );
  }

  console.log(
    `\n${String(written)} index row(s) published, ${String(skipped)} left as "insufficient data"`,
  );
} finally {
  await close();
}
