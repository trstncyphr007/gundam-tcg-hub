import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { orderRatings, orders } from '../schema/market.js';
import { isInsufficientPrivilege, isUniqueViolation } from './pg-errors.js';
import { asUser } from './watches.js';

/**
 * Seller reputation (FR-5.7).
 *
 * A rating is a receipt: it exists because a specific order completed, and migration 0045's
 * INSERT policy is what enforces that. This module does not re-check those conditions in
 * TypeScript, and the omission is deliberate — a second copy of a rule drifts from the first,
 * and the copy that matters is the one an attacker cannot reach around. What this module does
 * is turn the database's refusal into something a route can explain.
 */

export interface Rating {
  id: string;
  orderId: string;
  sellerId: string;
  raterId: string;
  stars: number;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What a stranger is shown. No `raterId`: who bought what is not public (SR-3.8). */
export interface PublicRating {
  id: string;
  stars: number;
  comment: string | null;
  createdAt: Date;
}

export interface Reputation {
  sellerId: string;
  /** Null until there is anything to average. Zero would be a score, and it is not one. */
  average: number | null;
  count: number;
  /** How many of each, one through five, so a page can draw the distribution. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

/** Raised when the order is not one this person may rate, for any of the four reasons. */
export class NotRatableError extends Error {
  constructor() {
    super('that order cannot be rated');
    this.name = 'NotRatableError';
  }
}

export class AlreadyRatedError extends Error {
  constructor() {
    super('that order has already been rated');
    this.name = 'AlreadyRatedError';
  }
}

/**
 * Leave a rating.
 *
 * The seller is read from the order rather than taken from the caller. A `sellerId` in a
 * request body is an invitation to rate one account for another's sale — the policy would
 * refuse it, but there is no reason to accept the field in the first place.
 */
export async function rateOrder(
  db: Database,
  raterId: string,
  input: { orderId: string; stars: number; comment?: string | null | undefined },
): Promise<Rating> {
  return asUser(db, raterId, async (tx) => {
    const [order] = await tx
      .select({ sellerId: orders.sellerId })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);
    // Invisible, or not theirs. The policy would refuse the insert anyway; this is so the
    // route can say 404 rather than turning a policy refusal into a 500.
    if (!order) throw new NotRatableError();

    try {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into app.order_ratings (order_id, seller_id, rater_id, stars, comment)
        values (${input.orderId}, ${order.sellerId}, ${raterId}, ${input.stars},
                ${input.comment ?? null})
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new NotRatableError();

      const [rating] = await tx.select().from(orderRatings).where(eq(orderRatings.id, id)).limit(1);
      if (!rating) throw new Error('rating vanished between insert and read');
      return rating;
    } catch (error) {
      if (isUniqueViolation(error, 'order_ratings_order_key')) throw new AlreadyRatedError();
      /**
       * The policy refused it.
       *
       * A failed `WITH CHECK` **raises** — it does not quietly insert nothing, which is what
       * the first version of this assumed and what made a correctly-working policy surface as
       * an unhandled 500. The four conditions are indistinguishable from out here, and
       * deliberately so: the caller is told the order cannot be rated, not which of the four
       * reasons applied, because "you are not the buyer" and "that order is not finished" are
       * different amounts of information to give somebody probing.
       */
      if (isInsufficientPrivilege(error)) throw new NotRatableError();
      throw error;
    }
  });
}

/** Change your mind. The rating stays yours and stays attached to the same order. */
export async function updateRating(
  db: Database,
  raterId: string,
  ratingId: string,
  input: { stars: number; comment?: string | null | undefined },
): Promise<Rating> {
  return asUser(db, raterId, async (tx) => {
    const [row] = await tx
      .update(orderRatings)
      .set({ stars: input.stars, comment: input.comment ?? null, updatedAt: new Date() })
      .where(and(eq(orderRatings.id, ratingId), eq(orderRatings.raterId, raterId)))
      .returning();
    if (!row) throw new NotRatableError();
    return row;
  });
}

/** This buyer's rating of this order, if they left one. For showing the form already filled in. */
export async function getMyRating(
  db: Database,
  raterId: string,
  orderId: string,
): Promise<Rating | null> {
  return asUser(db, raterId, async (tx) => {
    const [row] = await tx
      .select()
      .from(orderRatings)
      .where(and(eq(orderRatings.orderId, orderId), eq(orderRatings.raterId, raterId)))
      .limit(1);
    return row ?? null;
  });
}

/**
 * A seller's ratings, newest first.
 *
 * `rater_id` is not selected. The policy lets a session read the whole row — reputation is
 * public — and what keeps the buyer out of it is this query choosing not to ask. That is a
 * weaker guarantee than a column grant would be, and it is the right trade here: the rater is
 * not a secret from the rater, and narrowing the grant would stop `getMyRating` working.
 */
export async function listSellerRatings(
  db: Database,
  sellerId: string,
  limit = 20,
): Promise<PublicRating[]> {
  return db
    .select({
      id: orderRatings.id,
      stars: orderRatings.stars,
      comment: orderRatings.comment,
      createdAt: orderRatings.createdAt,
    })
    .from(orderRatings)
    .where(eq(orderRatings.sellerId, sellerId))
    .orderBy(desc(orderRatings.createdAt))
    .limit(limit);
}

/**
 * The number under a seller's name.
 *
 * `average` is null rather than zero when nobody has rated them. Zero is a score — the worst
 * one — and showing it to a new seller's first customer would be a lie that costs them the
 * sale. "No ratings yet" is the truth and reads as neutral.
 *
 * Rounded to one decimal, because a seller with 4.33333 and one with 4.33334 are the same
 * seller and publishing the difference implies a precision the sample does not have.
 */
export async function getReputation(db: Database, sellerId: string): Promise<Reputation> {
  const rows = await db
    .select({ stars: orderRatings.stars, n: sql<number>`count(*)::int` })
    .from(orderRatings)
    .where(eq(orderRatings.sellerId, sellerId))
    .groupBy(orderRatings.stars);

  /**
   * Accumulated in a Map and read out by name.
   *
   * `distribution[stars] = n` would be a computed-key write, which is the shape the object
   * injection rule exists to ask about — and although `stars` came from a CHECK-constrained
   * column and cannot be `__proto__`, "the database guarantees it" is an argument that stops
   * being true the moment somebody adds a second caller. Five named reads cost nothing.
   */
  const counts = new Map<number, number>();
  let total = 0;
  let count = 0;
  for (const row of rows) {
    counts.set(row.stars, row.n);
    total += row.stars * row.n;
    count += row.n;
  }

  return {
    sellerId,
    average: count === 0 ? null : Math.round((total / count) * 10) / 10,
    count,
    distribution: {
      1: counts.get(1) ?? 0,
      2: counts.get(2) ?? 0,
      3: counts.get(3) ?? 0,
      4: counts.get(4) ?? 0,
      5: counts.get(5) ?? 0,
    },
  };
}
