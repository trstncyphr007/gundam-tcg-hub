import {
  alertRetryJob,
  createDiscordWebhookTransport,
  createEmailTransport,
  createUnsupportedTransport,
} from '@gth/alerts';
import { createDb, getRestockContext } from '@gth/db';
import { createTransport } from 'nodemailer';
import { loadConfig } from './config.js';
import { unsubscribeUrl } from './routes/unsubscribe.js';

/**
 * Send the alerts we still owe (FR-1.8), shipped inside the API image like the other jobs
 * (ADR-036).
 *
 *   docker compose --profile jobs run --rm alert-retry
 *
 * Fan-out happens inside the scanner's own request, which is right: an alert is worth having
 * in the first minute and much less in the tenth. But it was one pass and no second chance. A
 * Discord 429 or an SMTP hiccup marked the delivery failed, forever, and the person who asked
 * to be told a box was back in stock was never told — silently, because a failed row was a
 * number on a dashboard and nothing read it.
 *
 * Runs every few minutes. It is deliberately the same code path as the first attempt, with the
 * same transports built from the same configuration, because a retry that goes out a different
 * way is not a retry.
 */
const config = loadConfig(process.env);

const mailer = config.SMTP_URL ? createTransport(config.SMTP_URL) : null;
if (!mailer) console.log('no SMTP_URL: email deliveries will be recorded as unsupported');

const { db, close } = createDb({ url: config.DATABASE_URL_WORKER, max: 1 });
try {
  const lines = await alertRetryJob({
    db,
    transports: {
      email: mailer
        ? createEmailTransport({
            mailer,
            from: config.EMAIL_FROM,
            unsubscribeUrl: (userId, subscriptionId) =>
              unsubscribeUrl(config, userId, subscriptionId),
          })
        : createUnsupportedTransport('email (no SMTP configured)'),
      discord_webhook: config.DISCORD_ALERT_WEBHOOK_URL
        ? createDiscordWebhookTransport({ webhookUrl: config.DISCORD_ALERT_WEBHOOK_URL })
        : createUnsupportedTransport('discord_webhook (no webhook configured)'),
      discord_dm: createUnsupportedTransport('discord_dm'),
      web_push: createUnsupportedTransport('web_push'),
    },
    buildMessage: async (database, retailerProductId, priceCents, currency, detectedAt) => {
      const context = await getRestockContext(database, retailerProductId);
      if (!context) return null;
      // The event's own time, not now. A retry an hour later must not claim the stock came
      // back just this moment — the reader is about to go and look.
      return { ...context, priceCents, currency, detectedAt };
    },
    logger: {
      warn: (obj, msg) => {
        console.log(msg, JSON.stringify(obj));
      },
    },
  });
  for (const line of lines) console.log(line);
} finally {
  await close();
}
