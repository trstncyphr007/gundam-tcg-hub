import { createDb } from '@gth/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
// Public endpoints read through the read-only role (least privilege, SR-X.8).
const { db, close } = createDb({ url: config.DATABASE_URL_READONLY, max: config.DB_POOL_MAX });
const app = await buildApp(config, { db });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await close();
  process.exit(0);
};
process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
