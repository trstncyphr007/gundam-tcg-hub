import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/** Apply pending migrations. Must run as app_migrator: it is the only role with DDL rights. */
export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createDb({ url, max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: 'drizzle' });
  } finally {
    await close();
  }
}

export { MIGRATIONS_FOLDER };
