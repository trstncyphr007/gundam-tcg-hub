import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { sellerAccounts } from '../schema/market.js';
import { asUser } from './watches.js';

/**
 * A seller's connected account (FR-5.1, ADR-011).
 *
 * We hold an id and two booleans. Stripe holds the identity, the bank details and the
 * liability for checking them, which is the whole reason Connect Express was chosen.
 *
 * **The two booleans are not ours to write.** Migration 0041 gives the web role INSERT on
 * `(id, user_id, stripe_account_id, created_at, updated_at)` and nothing else, so a session
 * physically cannot set `charges_enabled` — the column is outside its grant, not merely
 * outside its code path. They arrive from a verified webhook, on the worker.
 */

export interface SellerAccount {
  id: string;
  userId: string;
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  holdUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Whoever this connected account belongs to, for a webhook that knows only the Stripe id. */
export async function getSellerByStripeAccount(
  db: Database,
  stripeAccountId: string,
): Promise<SellerAccount | null> {
  const [row] = await db
    .select()
    .from(sellerAccounts)
    .where(eq(sellerAccounts.stripeAccountId, stripeAccountId))
    .limit(1);
  return row ?? null;
}

/** This person's connected account, if they have started one. */
export async function getSellerAccount(
  db: Database,
  userId: string,
): Promise<SellerAccount | null> {
  return asUser(db, userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(sellerAccounts)
      .where(eq(sellerAccounts.userId, userId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Where a purchase from this seller would send its money, asked by the buyer.
 *
 * The viewer is the one whose identity is declared, not the seller — impersonating the seller
 * to read their own row would make the policy decorative. Migration 0043's
 * `seller_accounts_select_active_seller` is what allows this, and it allows it only for a
 * seller who has something on sale. A seller with no active listing reads as null here even
 * though the row exists, which is the correct answer to "can I buy from them".
 */
export async function getSellerPayoutTarget(
  db: Database,
  viewerId: string,
  sellerId: string,
): Promise<SellerAccount | null> {
  return asUser(db, viewerId, async (tx) => {
    const [row] = await tx
      .select()
      .from(sellerAccounts)
      .where(eq(sellerAccounts.userId, sellerId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Record the account Stripe just gave us.
 *
 * One per person, enforced by a unique index rather than by checking first: two requests
 * racing would both see no row and both insert, and "who gets paid" is not a question to
 * answer twice.
 */
export async function recordSellerAccount(
  db: Database,
  userId: string,
  stripeAccountId: string,
): Promise<SellerAccount> {
  return asUser(db, userId, async (tx) => {
    /**
     * Written out, rather than through the query builder, because of the grant.
     *
     * Drizzle names **every** column in an INSERT — including the ones it is only passing
     * `default` for. Against a column-level grant that is fatal: the statement mentions
     * `charges_enabled`, the web role has no INSERT privilege on `charges_enabled`, and
     * Postgres refuses the whole statement with "permission denied for table". The builder
     * and a partial grant simply cannot be used together.
     *
     * Naming the two columns we are allowed to write keeps the grant doing its job. The
     * capability columns are not merely absent from this statement; they are absent from what
     * this role may write at all.
     */
    const rows = await tx.execute<{
      id: string;
      userId: string;
      stripeAccountId: string;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      holdUntil: string | null;
      createdAt: string;
      updatedAt: string;
    }>(sql`
      insert into app.seller_accounts (user_id, stripe_account_id)
      values (${userId}, ${stripeAccountId})
      on conflict (user_id) do nothing
      returning id, user_id as "userId", stripe_account_id as "stripeAccountId",
                charges_enabled as "chargesEnabled", payouts_enabled as "payoutsEnabled",
                hold_until as "holdUntil", created_at as "createdAt", updated_at as "updatedAt"
    `);

    const inserted = rows[0];
    if (inserted) return hydrate(inserted);

    // The conflict path: somebody else's request won the race, and the row it wrote is the
    // one that counts. Returning it rather than the id we just created means the loser of the
    // race uses the winner's account instead of a second orphaned one.
    const [existing] = await tx
      .select()
      .from(sellerAccounts)
      .where(eq(sellerAccounts.userId, userId))
      .limit(1);
    if (!existing) throw new Error('seller account vanished between insert and read');
    return existing;
  });
}

/** Raw SQL returns timestamps as strings; the builder does not. */
function hydrate(row: {
  id: string;
  userId: string;
  stripeAccountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  holdUntil: string | null;
  createdAt: string;
  updatedAt: string;
}): SellerAccount {
  return {
    ...row,
    holdUntil: row.holdUntil === null ? null : new Date(row.holdUntil),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * What Stripe says this account may do (SR-5.2).
 *
 * On the worker, because these are the columns a session cannot touch. The caller has already
 * verified the webhook's signature; this function does not and must not be reachable without
 * that having happened.
 */
export async function updateSellerCapabilities(
  db: Database,
  stripeAccountId: string,
  capabilities: { chargesEnabled: boolean; payoutsEnabled: boolean },
): Promise<boolean> {
  const rows = await db
    .update(sellerAccounts)
    .set({
      chargesEnabled: capabilities.chargesEnabled,
      payoutsEnabled: capabilities.payoutsEnabled,
      updatedAt: new Date(),
    })
    .where(eq(sellerAccounts.stripeAccountId, stripeAccountId))
    .returning();
  return rows.length > 0;
}

/** May this person take money yet? Both, not either: a charge nobody can be paid for is worse. */
export function canSell(account: SellerAccount | null): boolean {
  return account !== null && account.chargesEnabled && account.payoutsEnabled;
}
