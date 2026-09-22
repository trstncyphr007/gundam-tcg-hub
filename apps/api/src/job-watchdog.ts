import { createOpsNotifier } from '@gth/alerts';
import { parseEnv } from '@gth/core';
import { createDb, watchdogJob } from '@gth/db';
import { z } from 'zod';

/**
 * The watchdog (SR-X.22), shipped inside the API image like the other jobs (ADR-036).
 *
 *   docker compose --profile jobs run --rm watchdog
 *
 * Runs every quarter of an hour. It reads what the operations page reads, decides whether any
 * of it is worth saying, and says each thing at most once per its own interval — plus one
 * "all clear" a day, so a quiet channel means nothing is wrong rather than that the watchdog
 * died on Tuesday.
 *
 * `DISCORD_OPS_WEBHOOK_URL` is optional here and the job succeeds without it: it prints what
 * it would have said. A host that is not wired up yet should show that in its journal, not
 * fail a timer every fifteen minutes until somebody silences it.
 */
const env = parseEnv(
  z.object({
    DATABASE_URL_WORKER: z.string().startsWith('postgres'),
    // Empty counts as absent: an env file that carries the key with no value is a host that
    // has not been wired up yet, not a misconfiguration to crash on.
    DISCORD_OPS_WEBHOOK_URL: z
      .url()
      .optional()
      .or(z.literal('').transform(() => undefined)),
  }),
);

const webhookUrl = env.DISCORD_OPS_WEBHOOK_URL;
const notifier = webhookUrl === undefined ? null : createOpsNotifier({ webhookUrl });
if (notifier === null) {
  console.log('no DISCORD_OPS_WEBHOOK_URL: findings will be printed, not sent');
}

const { db, close } = createDb({ url: env.DATABASE_URL_WORKER, max: 1 });
try {
  const lines = await watchdogJob(db, notifier === null ? null : (text) => notifier.notify(text));
  for (const line of lines) console.log(line);
  if (lines.length === 0) console.log('nothing to say');
} finally {
  await close();
}
