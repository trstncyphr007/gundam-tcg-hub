import {
  createDiscordWebhookTransport,
  createEmailTransport,
  createUnsupportedTransport,
} from '@gth/alerts';
import { createAuth } from '@gth/auth';
import { createDb, getRestockContext } from '@gth/db';
import { buildKeyRing } from '@gth/security';
import { createTransport } from 'nodemailer';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createMagicLinkSender } from './mailer.js';

const config = loadConfig();

// One pool per role (least privilege, SR-X.8):
//   readonly -> public catalog reads
//   web      -> accounts, watches
//   worker   -> scanner ingestion, alert delivery
const readonly = createDb({ url: config.DATABASE_URL_READONLY, max: config.DB_POOL_MAX });
const write = createDb({ url: config.DATABASE_URL_WEB, max: config.DB_POOL_MAX });
const worker = createDb({ url: config.DATABASE_URL_WORKER, max: config.DB_POOL_MAX });

const auth = createAuth(write.db, {
  baseURL: config.API_BASE_URL,
  secret: config.BETTER_AUTH_SECRET,
  trustedOrigins: [config.APP_BASE_URL, config.API_BASE_URL],
  production: config.NODE_ENV === 'production',
  trustProxyHeaders: config.API_TRUST_PROXY,
  discord:
    config.DISCORD_CLIENT_ID && config.DISCORD_CLIENT_SECRET
      ? { clientId: config.DISCORD_CLIENT_ID, clientSecret: config.DISCORD_CLIENT_SECRET }
      : undefined,
  sendMagicLink: createMagicLinkSender(config, {
    warn: (obj, msg) => {
      app.log.warn(obj, msg);
    },
    info: (obj, msg) => {
      app.log.info(obj, msg);
    },
  }),
});

const mailer = config.SMTP_URL ? createTransport(config.SMTP_URL) : null;

const app = await buildApp(config, {
  db: readonly.db,
  writeDb: write.db,
  auth,
  // API keys are verified on the worker role, the only one with SELECT on `key_hash`
  // (migration 0017). Without this the key plugin is not registered at all and every caller
  // is anonymous — noisy, but never silently trusting an unverified key.
  keysDb: worker.db,
  // Breaks are owned by their creator, so they run on the web role under RLS. The reveal is
  // the exception: it reads the encrypted seed, which only the worker role may do.
  breaks: {
    db: write.db,
    tokenPepper: config.TOKEN_PEPPER,
    keyRing: buildKeyRing(config.DATA_ENCRYPTION_KEYS, config.DATA_ENCRYPTION_ACTIVE_KID),
    secretsDb: worker.db,
  },
  // Live sales are the seller's own rows, so they run on the web role under RLS. Turning
  // them into price observations is deliberately not done here: the web role cannot write a
  // first-party observation at all (migration 0013), and the worker does it on a schedule.
  liveSales: {
    db: write.db,
    keyRing: buildKeyRing(config.DATA_ENCRYPTION_KEYS, config.DATA_ENCRYPTION_ACTIVE_KID),
  },
  ingest: {
    workerDb: worker.db,
    tokenPepper: config.TOKEN_PEPPER,
    transports: {
      email: mailer
        ? createEmailTransport({
            mailer,
            from: config.EMAIL_FROM,
            unsubscribeUrl: `${config.APP_BASE_URL}/account/watches`,
          })
        : createUnsupportedTransport('email (no SMTP configured)'),
      discord_webhook: config.DISCORD_ALERT_WEBHOOK_URL
        ? createDiscordWebhookTransport({ webhookUrl: config.DISCORD_ALERT_WEBHOOK_URL })
        : createUnsupportedTransport('discord_webhook (no webhook configured)'),
      discord_dm: createUnsupportedTransport('discord_dm'),
      web_push: createUnsupportedTransport('web_push'),
    },
    buildMessage: async (db, retailerProductId, priceCents, currency) => {
      const context = await getRestockContext(db, retailerProductId);
      if (!context) return null;
      return { ...context, priceCents, currency, detectedAt: new Date() };
    },
  },
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.all([readonly.close(), write.close(), worker.close()]);
  process.exit(0);
};
process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
