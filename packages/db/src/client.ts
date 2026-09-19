import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDb>['db'];

export interface DbOptions {
  /** Connection string for the role this service should use (never a superuser). */
  url: string;
  max?: number;
  /** Fail fast instead of queueing forever when the pool is saturated. */
  connectTimeoutS?: number;
  onNotice?: (notice: unknown) => void;
}

/**
 * Create a Drizzle client. Callers own the lifecycle and must `await close()` on shutdown.
 * Statement timeouts are set per role in the database (init/01-roles.sh), not here.
 */
export function createDb({ url, max = 10, connectTimeoutS = 5, onNotice }: DbOptions) {
  const sql = postgres(url, {
    max,
    connect_timeout: connectTimeoutS,
    // Keep credentials and notices out of app logs unless explicitly handled.
    onnotice: onNotice ?? (() => undefined),
    prepare: true,
  });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return {
    db,
    sql,
    close: async (): Promise<void> => {
      await sql.end({ timeout: 5 });
    },
  };
}

export { schema };
