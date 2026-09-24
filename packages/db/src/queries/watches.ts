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

/**
 * Stop emailing about one watch, for somebody who is not signed in (SR-1.12).
 *
 * The email channel is removed and the watch is kept — unsubscribing is a request to stop *this
 * mail*, not to forget what somebody asked about, and one click from a mail client should not
 * throw away a choice they made. The watches page still shows it, and that is where they turn
 * it back on.
 *
 * **Unless email was the only channel, in which case the watch goes.** A watch alerting through
 * nothing is not a state this schema has: `watch_subscriptions_channels_not_empty` requires at
 * least one, and it is right to. The first version of this ignored that, because its fixture
 * happened to have two channels while every watch the UI creates has exactly one — so the
 * common case raised a constraint violation and answered 500. The reader still gets what they
 * asked for: no more emails about that product, and one click to watch it again.
 *
 * **The owner is passed in, not looked up.** There is no session here, so the first instinct is
 * to read the row and find out whose it is — which does not work: `watch_subscriptions` is
 * FORCE'd, so a connection that has not declared a user sees nothing, and the id alone cannot
 * tell it what to declare. Escaping that with a `SECURITY DEFINER` function would mean granting
 * the ability to read any watch in order to change one.
 *
 * Instead the signed link carries both ids, so the caller knows whose row it is before it asks,
 * and this runs down the ordinary owner-scoped path with the ordinary policies. No new
 * privilege exists anywhere. The signature covers both ids together, so neither can be swapped
 * for somebody else's.
 */
export async function unsubscribeEmail(
  db: Database,
  userId: string,
  watchId: string,
): Promise<boolean> {
  return asUser(db, userId, async (tx) => {
    // Both statements are scoped by owner as well as by id. The pair already came from one
    // signature, so this is belt and braces — and it is what makes a validly-signed link
    // carrying somebody else's watch do nothing at all.
    const removed = await tx.execute<{ id: string }>(sql`
      update app.watch_subscriptions
         set channels = array_remove(channels, 'email'::app.alert_channel),
             updated_at = now()
       where id = ${watchId}::uuid
         and user_id = ${userId}
         and 'email' = any(channels)
         and cardinality(channels) > 1
      returning id
    `);
    if (removed.length > 0) return true;

    // Email was the only way this watch spoke, so there is nothing left for it to be.
    await tx.execute(sql`
      delete from app.watch_subscriptions
       where id = ${watchId}::uuid
         and user_id = ${userId}
         and channels = array['email']::app.alert_channel[]
    `);
    // True either way, including when there was nothing left to do. A mail client retrying its
    // one-click POST, or a reader clicking twice, has got what they asked for; reporting
    // failure would only invite them to try harder.
    return true;
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
