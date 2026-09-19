import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
