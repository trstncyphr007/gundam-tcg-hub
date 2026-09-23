import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { watchSubscriptions } from '../schema/watches.js';
import { MissingReferenceError, isForeignKeyViolation, isUniqueViolation } from './pg-errors.js';

export type AlertChannel = 'email' | 'discord_dm' | 'discord_webhook' | 'web_push';

export interface WatchInput {
  sealedProductId?: string | undefined;
  retailerProductId?: string | undefined;
  channels: AlertChannel[];
}

export type Watch = typeof watchSubscriptions.$inferSelect;

/** Per-user cap so one account cannot flood the scanner queue (FR-1.9). */
export const MAX_WATCHES_PER_USER = 50;

export class WatchLimitError extends Error {
  constructor() {
    super(`watch limit reached (${String(MAX_WATCHES_PER_USER)})`);
    this.name = 'WatchLimitError';
  }
}

export class DuplicateWatchError extends Error {
  constructor() {
    super('watch already exists for this target');
    this.name = 'DuplicateWatchError';
  }
}

/**
 * Run `fn` in a transaction that declares the acting user to Postgres, so row-level
 * security filters every statement inside it (SR-X.8). `set_local` is scoped to the
 * transaction, so a pooled connection can never leak identity to the next request.
 */
export async function asUser<T>(
  db: Database,
  userId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx as unknown as Database);
  });
}

export async function listWatches(db: Database, userId: string): Promise<Watch[]> {
  return asUser(db, userId, (tx) =>
    tx
      .select()
      .from(watchSubscriptions)
      .where(eq(watchSubscriptions.userId, userId))
      .orderBy(desc(watchSubscriptions.createdAt)),
  );
}

export async function countWatches(db: Database, userId: string): Promise<number> {
  return asUser(db, userId, async (tx) => {
    const rows = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from app.watch_subscriptions where user_id = ${userId}`,
    );
    return rows[0]?.n ?? 0;
  });
}

export async function createWatch(db: Database, userId: string, input: WatchInput): Promise<Watch> {
  return asUser(db, userId, async (tx) => {
    const current = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from app.watch_subscriptions where user_id = ${userId}`,
    );
    if ((current[0]?.n ?? 0) >= MAX_WATCHES_PER_USER) throw new WatchLimitError();

    try {
      const [created] = await tx
        .insert(watchSubscriptions)
        .values({
          // userId comes from the session, never from the request body.
          userId,
          sealedProductId: input.sealedProductId ?? null,
          retailerProductId: input.retailerProductId ?? null,
          channels: input.channels,
        })
        .returning();
      if (!created) throw new Error('watch insert returned no row');
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateWatchError();
      // A well-formed id for a product or listing that is not there — a page open in a tab
      // while the catalogue moved on. Ordinary, and previously a 500.
      if (isForeignKeyViolation(error)) throw new MissingReferenceError('product or listing');
      throw error;
    }
  });
}

/** Deletes only if the row belongs to the caller. Returns false when it does not exist. */
export async function deleteWatch(db: Database, userId: string, id: string): Promise<boolean> {
  return asUser(db, userId, async (tx) => {
    const deleted = await tx
      .delete(watchSubscriptions)
      .where(and(eq(watchSubscriptions.id, id), eq(watchSubscriptions.userId, userId)))
      .returning({ id: watchSubscriptions.id });
    return deleted.length > 0;
  });
}
