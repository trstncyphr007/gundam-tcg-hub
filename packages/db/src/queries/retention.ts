import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

/** One line of the nightly sweep: what was deleted, and how much of it. */
export interface RetentionLine {
  what: string;
  deleted: number;
}

/**
 * Delete what has outlived its purpose (SR-X.21, SR-X.23, migration 0035).
 *
 * The periods are in the database, not here. This function cannot ask for a shorter one, and
 * neither can anything else that runs on the worker role: a compromised nightly job must not
 * be able to prune the audit log up to the moment it was compromised.
 */
export async function runRetention(db: Database): Promise<RetentionLine[]> {
  // `deleted` is a bigint, which arrives as a string.
  const rows = await db.execute<{ what: string; deleted: string }>(
    sql`select what, deleted from app.run_retention()`,
  );
  return rows.map((row) => ({ what: row.what, deleted: Number(row.deleted) }));
}
