import {
  createDiscordWebhookTransport,
  createEmailTransport,
  createUnsupportedTransport,
} from '@gth/alerts';
import { createAuth } from '@gth/auth';
import { createDb, getRestockContext } from '@gth/db';
import { createScanner, createStorage } from '@gth/photos';
import { buildKeyRing } from '@gth/security';
import { createTransport } from 'nodemailer';
import { buildApp } from './app.js';
import { createStripeClient } from './payments/stripe.js';
import { loadConfig } from './config.js';
import { createMagicLinkSender, createSecurityNoticeSender } from './mailer.js';
import { unsubscribeUrl } from './routes/unsubscribe.js';

const config = loadConfig();

// One pool per role (least privilege, SR-X.8):
//   readonly -> public catalog reads
//   web      -> accounts, watches
//   worker   -> scanner ingestion, alert delivery
const readonly = createDb({ url: config.DATABASE_URL_READONLY, max: config.DB_POOL_MAX });
const write = createDb({ url: config.DATABASE_URL_WEB, max: config.DB_POOL_MAX });
const worker = createDb({ url: config.DATABASE_URL_WORKER, max: config.DB_POOL_MAX });

const log = {
  warn: (obj: Record<string, unknown>, msg: string) => {
    app.log.warn(obj, msg);
  },
  info: (obj: Record<string, unknown>, msg: string) => {
    app.log.info(obj, msg);
  },
};

const securityNotices = createSecurityNoticeSender(config, log);

const auth = createAuth(write.db, {
  baseURL: config.API_BASE_URL,
  secret: config.BETTER_AUTH_SECRET,
  // The WebAuthn origin too: in development the site is opened at http://localhost:3000 for
  // passkeys (an IP address cannot be an RP ID), which is a different origin from
  // APP_BASE_URL's 127.0.0.1, and the CSRF origin check has to accept it.
  trustedOrigins: [...new Set([config.APP_BASE_URL, config.API_BASE_URL, config.WEBAUTHN_ORIGIN])],
  passkey: {
    rpID: config.WEBAUTHN_RP_ID,
    rpName: config.WEBAUTHN_RP_NAME,
    origin: config.WEBAUTHN_ORIGIN,
  },
  sendSecurityNotice: securityNotices,
  production: config.NODE_ENV === 'production',
  trustProxyHeaders: config.API_TRUST_PROXY,
  discord:
    config.DISCORD_CLIENT_ID && config.DISCORD_CLIENT_SECRET
      ? { clientId: config.DISCORD_CLIENT_ID, clientSecret: config.DISCORD_CLIENT_SECRET }
      : undefined,
  sendMagicLink: createMagicLinkSender(config, log),
});

const mailer = config.SMTP_URL ? createTransport(config.SMTP_URL) : null;

const app = await buildApp(config, {
  db: readonly.db,
  writeDb: write.db,
  auth,
  notify: securityNotices,
  // API keys are verified on the worker role, the only one with SELECT on `key_hash`
  // (migration 0017). Without this the key plugin is not registered at all and every caller
  // is anonymous — noisy, but never silently trusting an unverified key.
  keysDb: worker.db,
  // Moderation decisions run on the worker role too: the web role may look at the review
  // queue and can never mark a price as counting (migration 0027).
  moderationDb: worker.db,
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
  // The marketplace, only when Stripe is configured (Phase 5). No key, no seller routes —
  // rather than routes that exist and answer 500 because a secret is missing.
  ...(config.STRIPE_SECRET_KEY === undefined
    ? {}
    : {
        seller: {
          db: write.db,
          stripe: createStripeClient({
            secretKey: config.STRIPE_SECRET_KEY,
            webhookSecret: config.STRIPE_WEBHOOK_SECRET,
          }),
          appBaseUrl: config.APP_BASE_URL,
        },
        /**
         * Buying, only when a webhook can be verified.
         *
         * Nested inside the `STRIPE_WEBHOOK_SECRET` check below on purpose: without it an
         * order could be created and charged and **never marked paid**, because the only thing
         * that moves it is a signed webhook. Taking somebody's money with no way to record
         * that we did is worse than not offering to.
         */
        // Only with a signing secret. Without one nothing could be verified, and an endpoint
        // that accepts unverifiable claims about money is worse than no endpoint.
        ...(config.STRIPE_WEBHOOK_SECRET === undefined
          ? {}
          : {
              stripeWebhook: {
                workerDb: worker.db,
                stripe: createStripeClient({
                  secretKey: config.STRIPE_SECRET_KEY,
                  webhookSecret: config.STRIPE_WEBHOOK_SECRET,
                }),
              },
              checkout: {
                db: write.db,
                stripe: createStripeClient({
                  secretKey: config.STRIPE_SECRET_KEY,
                  webhookSecret: config.STRIPE_WEBHOOK_SECRET,
                }),
                appBaseUrl: config.APP_BASE_URL,
                feeBps: config.MARKETPLACE_FEE_BPS,
              },
            }),
      }),
  /**
   * Listing photos, only when there is somewhere to put them (Phase 5, slice 4).
   *
   * The scanner is separate and optional *within* this: storage configured without ClamAV
   * still mounts the routes, and the pipeline then refuses to finish an upload rather than
   * approving it unscanned. "No scanner" is a reason to leave a photo pending, never a reason
   * to skip the step.
   */
  ...(config.S3_ENDPOINT === undefined ||
  config.S3_BUCKET === undefined ||
  config.S3_ACCESS_KEY_ID === undefined ||
  config.S3_SECRET_ACCESS_KEY === undefined
    ? {}
    : {
        photos: {
          db: write.db,
          workerDb: worker.db,
          storage: createStorage({
            endpoint: config.S3_ENDPOINT,
            bucket: config.S3_BUCKET,
            credentials: {
              accessKeyId: config.S3_ACCESS_KEY_ID,
              secretAccessKey: config.S3_SECRET_ACCESS_KEY,
              region: config.S3_REGION,
            },
          }),
          ...(config.CLAMAV_HOST === undefined
            ? {}
            : { scanner: createScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT }) }),
        },
      }),
  ingest: {
    workerDb: worker.db,
    tokenPepper: config.TOKEN_PEPPER,
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
