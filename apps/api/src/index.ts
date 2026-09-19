import { createAuth } from '@gth/auth';
import { createDb } from '@gth/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createMagicLinkSender } from './mailer.js';

const config = loadConfig();

// Public endpoints read through the read-only role; auth/account data needs app_web.
const readonly = createDb({ url: config.DATABASE_URL_READONLY, max: config.DB_POOL_MAX });
const write = createDb({ url: config.DATABASE_URL_WEB, max: config.DB_POOL_MAX });

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

const app = await buildApp(config, { db: readonly.db, writeDb: write.db, auth });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.all([readonly.close(), write.close()]);
  process.exit(0);
};
process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
