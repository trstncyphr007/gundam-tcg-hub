import { AUTO_COMPLETE_AFTER_DAYS, type OrderActor, type OrderStatus, transition } from '@gth/core';
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { listings, orderEvents, orders } from '../schema/market.js';
import { MissingReferenceError, isForeignKeyViolation, isUniqueViolation } from './pg-errors.js';
import { asUser } from './watches.js';

/**
 * Buying (FR-5.3, FR-5.4).
 *
 * Two halves, on two roles, and the split is the control.
 *
 * **The buyer's half** runs on `app_web` and may create an order and attach a Checkout session
 * to it. Migration 0043 narrows the grant to the columns that means: everything about money
 * and everything about payment is outside what this role can write, so `paid` is not something
 * a session fails to reach, it is something a session cannot spell.
 *
 * **Stripe's half** runs on `app_worker`, is reached only from a webhook whose signature has
 * been verified against the raw body, and is the only path that writes `paid`.
 *
 * Everything about what was bought is copied onto the order rather than referenced. A listing
 * is editable; an order has to keep saying what was agreed when somebody disputes it in six
 * months.
 */

export interface Order {
  id: string;
  buyerId: string;
  sellerId: string;
  listingId: string | null;
  cardVariantId: string;
  condition: string;
  quantity: number;
  status: OrderStatus;
  amountCents: number;
  feeCents: number;
  taxCents: number;
  currency: string;
  stripeCheckoutId: string | null;
  stripePaymentIntentId: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  paidAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrderInput {
  sellerId: string;
  listingId: string;
  cardVariantId: string;
  condition: 'nm' | 'lp' | 'mp' | 'hp' | 'dmg';
  quantity: number;
  /** What the buyer will be charged. Taken from the listing, never from a request body. */
  amountCents: number;
  /** Our cut, computed from `amountCents`. See `applicationFeeCents` in `@gth/core`. */
  feeCents: number;
  currency: string;
}

/** Somebody else is already part-way through buying this, or has bought it. */
export class ListingUnavailableError extends Error {
  constructor() {
    super('that listing is not available');
    this.name = 'ListingUnavailableError';
  }
}

export class OrderNotFoundError extends Error {
  constructor() {
    super('no such order');
    this.name = 'OrderNotFoundError';
  }
}

/**
 * Open an order, before any money is asked for.
 *
 * Written out in SQL rather than through the query builder, for the reason
 * `recordSellerAccount` documents: Drizzle names **every** column in an INSERT, including the
 * ones it is only letting default, and a statement that mentions `status` is refused outright
 * by a grant that does not include `status`. Naming the nine columns this role may write is
 * what keeps the other fourteen unwritable.
 *
 * The row is read back through the builder inside the same transaction, which the buyer's own
 * SELECT policy allows and which saves hydrating twenty columns of raw SQL by hand.
 */
export async function createOrder(
  db: Database,
  buyerId: string,
  input: CreateOrderInput,
): Promise<Order> {
  return asUser(db, buyerId, async (tx) => {
    let id: string;
    try {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into app.orders
          (buyer_id, seller_id, listing_id, card_variant_id, condition,
           quantity, amount_cents, fee_cents, currency)
        values
          (${buyerId}, ${input.sellerId}, ${input.listingId}, ${input.cardVariantId},
           ${input.condition}::app.card_condition,
           ${input.quantity}, ${input.amountCents}, ${input.feeCents}, ${input.currency})
        returning id
      `);
      const row = rows[0];
      if (!row) throw new Error('order insert returned nothing');
      id = row.id;
    } catch (error) {
      // The `orders_one_open_per_listing` index fired: another buyer got here first. Answered
      // separately from a missing card because the caller tells the two apart — 409 "gone
      // while you were looking at it" against 404 "there is no such thing".
      if (isUniqueViolation(error, 'orders_one_open_per_listing')) {
        throw new ListingUnavailableError();
      }
      if (isForeignKeyViolation(error)) throw new MissingReferenceError('listing');
      throw error;
    }

    const [order] = await tx.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) throw new Error('order vanished between insert and read');
    return order;
  });
}

/**
 * Remember which Checkout session belongs to this order.
 *
 * A convenience, not the link. The authoritative one travels the other way: we put the order
 * id in the session's metadata, and it comes back inside the signed webhook. So a failure here
 * leaves an order that can still be paid — which is why it is a separate statement rather than
 * something the order insert waits for Stripe to provide.
 */
export async function attachCheckoutSession(
  db: Database,
  buyerId: string,
  orderId: string,
  checkoutSessionId: string,
): Promise<void> {
  await asUser(db, buyerId, async (tx) => {
    await tx
      .update(orders)
      .set({ stripeCheckoutId: checkoutSessionId, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
  });
}

/** One order, if this viewer is a party to it. RLS decides; this just asks. */
export async function getOrder(db: Database, viewerId: string, id: string): Promise<Order | null> {
  return asUser(db, viewerId, async (tx) => {
    const [row] = await tx.select().from(orders).where(eq(orders.id, id)).limit(1);
    return (row as Order | undefined) ?? null;
  });
}

/** Everything this person is a party to, bought or sold. The policy returns both sides. */
export async function listMyOrders(db: Database, userId: string): Promise<Order[]> {
  return asUser(db, userId, async (tx) => {
    return tx
      .select()
      .from(orders)
      .orderBy(sql`${orders.createdAt} desc`)
      .limit(200);
  });
}

export interface OrderPaidInput {
  orderId: string;
  paymentIntentId: string;
  checkoutSessionId: string;
  /** From the session's `total_details.amount_tax`, when Stripe Tax is collecting. */
  taxCents?: number | undefined;
}

export type OrderPaidResult =
  | { applied: true; order: Order }
  /** Already `paid`. A retried webhook, and nothing to do. */
  | { applied: false; reason: 'already_paid' }
  /** Metadata named an order that is not here. */
  | { applied: false; reason: 'unknown_order' };

/**
 * A payment happened (SR-5.7).
 *
 * **Worker role only, and only from a verified webhook.** The web role cannot write `paid` —
 * migration 0041 forbids the status and 0043 forbids the columns — so this function is not
 * merely the place we chose to put it, it is the only place it can be done.
 *
 * The order is locked `for update` before the decision, so two deliveries of the same event
 * that both get past the idempotency claim still serialise here rather than both transitioning
 * a `created` order they each read as `created`.
 *
 * An order that cannot legally reach `paid` — cancelled, say, and then paid anyway — throws
 * `IllegalTransitionError` from `@gth/core`. That is a real anomaly and the caller records it;
 * it is not silently swallowed and not retried forever.
 */
export async function markOrderPaid(db: Database, input: OrderPaidInput): Promise<OrderPaidResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for('update')
      .limit(1);
    if (!existing) return { applied: false, reason: 'unknown_order' };

    const from = existing.status;
    if (from === 'paid') return { applied: false, reason: 'already_paid' };

    // Throws if this is not a move, or not Stripe's to make. Both are anomalies worth an
    // audit entry rather than a quiet no-op.
    const to = transition(from, 'paid', 'stripe');

    const [updated] = await tx
      .update(orders)
      .set({
        status: to,
        stripePaymentIntentId: input.paymentIntentId,
        stripeCheckoutId: input.checkoutSessionId,
        ...(input.taxCents === undefined ? {} : { taxCents: input.taxCents }),
        paidAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, input.orderId))
      .returning();
    if (!updated) throw new Error('order vanished mid-transaction');

    await tx.insert(orderEvents).values({
      orderId: input.orderId,
      fromStatus: from,
      toStatus: to,
      actor: 'stripe',
    });

    /**
     * The card is spoken for.
     *
     * A whole listing is bought at once in this slice, so the listing is sold outright rather
     * than decremented. Partial quantities need a reservation the buyer holds while they are
     * at Stripe, and a half-built version of that oversells — which is the one bug in a
     * marketplace that costs a seller a card they do not have.
     */
    if (existing.listingId !== null) {
      await tx
        .update(listings)
        .set({ status: 'sold', updatedAt: new Date() })
        .where(eq(listings.id, existing.listingId));
    }

    return { applied: true, order: updated };
  });
}

/* ------------------------------------------------------------------------------------------ *
 * What happens after the money moves (FR-5.4).
 * ------------------------------------------------------------------------------------------ */

/** Raised when the acting user is a party to the order, but not the party who may do this. */
export class WrongPartyError extends Error {
  constructor(readonly expected: 'buyer' | 'seller') {
    super(`only the ${expected} may do that`);
    this.name = 'WrongPartyError';
  }
}

/** Columns a transition may also set. Deliberately small: a move is not an edit. */
interface TransitionSet {
  trackingCarrier?: string;
  trackingNumber?: string;
  shippedAt?: Date;
  deliveredAt?: Date;
  completedAt?: Date;
}

interface MoveInput {
  orderId: string;
  to: OrderStatus;
  actor: OrderActor;
  /** The person, when it was one. `stripe` and `system` are not people and a CHECK says so. */
  actorId?: string | null | undefined;
  reason?: string | null | undefined;
  set?: TransitionSet | undefined;
  /**
   * Checked against the order before the move, so "you are a party to this" and "you are the
   * party who may do this" stay different questions. Row-level security answers the first; it
   * has no opinion on the second, because both parties can see the same row.
   */
  mustBe?: 'buyer' | 'seller' | undefined;
}

/**
 * Move an order, or refuse to.
 *
 * Every transition in this file goes through here, so there is exactly one place where the
 * order is locked, the state machine is consulted, the row is written and the history is
 * appended — and no route can perform three of those four.
 *
 * `for update` before the decision: two requests that both read `paid` would otherwise both
 * decide they may ship it, and the second would overwrite the first's tracking number with its
 * own. Locking makes them queue and the second one lose on the state machine, which is the
 * correct answer rather than a race.
 */
async function move(tx: Database, input: MoveInput): Promise<Order> {
  const [existing] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for('update')
    .limit(1);
  if (!existing) throw new OrderNotFoundError();

  if (input.mustBe !== undefined) {
    const party = input.mustBe === 'buyer' ? existing.buyerId : existing.sellerId;
    if (party !== input.actorId) throw new WrongPartyError(input.mustBe);
  }

  // Throws `IllegalTransitionError` from `@gth/core` when the move is not one, or not this
  // actor's to make. The database refuses the same thing again from the other direction:
  // migration 0041's policy will not let a session write `delivered` or `completed` at all.
  const to = transition(existing.status, input.to, input.actor);

  const [updated] = await tx
    .update(orders)
    .set({ status: to, ...(input.set ?? {}), updatedAt: new Date() })
    .where(eq(orders.id, input.orderId))
    .returning();
  if (!updated) throw new Error('order vanished mid-transaction');

  await tx.insert(orderEvents).values({
    orderId: input.orderId,
    fromStatus: existing.status,
    toStatus: to,
    actor: input.actor,
    // `stripe` and `system` are machines. `order_events_actor_identified` refuses to let one
    // claim to be a person.
    actorId: input.actor === 'stripe' || input.actor === 'system' ? null : (input.actorId ?? null),
    reason: input.reason ?? null,
  });

  return updated;
}

/**
 * The seller posted it (FR-5.4).
 *
 * **Tracking is always required, not only above a threshold.** The plan allows it above a
 * configurable value; the database CHECK from migration 0041 requires it for every shipped
 * order, and that is the stricter rule kept on purpose. An untracked parcel is a dispute with
 * no evidence in it, and the person who loses that argument is the seller — so the requirement
 * protects the party it inconveniences.
 */
export async function shipOrder(
  db: Database,
  sellerId: string,
  orderId: string,
  tracking: { carrier: string; trackingNumber: string },
): Promise<Order> {
  return asUser(db, sellerId, async (tx) =>
    move(tx, {
      orderId,
      to: 'shipped',
      actor: 'seller',
      actorId: sellerId,
      mustBe: 'seller',
      set: {
        trackingCarrier: tracking.carrier,
        trackingNumber: tracking.trackingNumber,
        shippedAt: new Date(),
      },
    }),
  );
}

/**
 * Either side walks away before anything was paid.
 *
 * The actor is derived from the order rather than taken from the caller: a buyer cannot cancel
 * "as the seller" to get a different transition, because there is no field in which to say so.
 * After `paid` this refuses — the state machine only lets an admin cancel a paid order, and
 * the money has to come back through Stripe rather than through a status change.
 */
export async function cancelOrder(
  db: Database,
  userId: string,
  orderId: string,
  reason?: string,
): Promise<Order> {
  return asUser(db, userId, async (tx) => {
    const [existing] = await tx
      .select({ buyerId: orders.buyerId, sellerId: orders.sellerId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!existing) throw new OrderNotFoundError();

    const actor: OrderActor = existing.buyerId === userId ? 'buyer' : 'seller';
    return move(tx, {
      orderId,
      to: 'cancelled',
      actor,
      actorId: userId,
      ...(reason === undefined ? {} : { reason }),
    });
  });
}

/** The buyer says something is wrong (FR-5.5). Only the buyer; a seller cannot dispute a sale. */
export async function disputeOrder(
  db: Database,
  buyerId: string,
  orderId: string,
  reason: string,
): Promise<Order> {
  return asUser(db, buyerId, async (tx) =>
    move(tx, {
      orderId,
      to: 'disputed',
      actor: 'buyer',
      actorId: buyerId,
      mustBe: 'buyer',
      reason,
    }),
  );
}

/**
 * It arrived (FR-5.4). Worker role only.
 *
 * Never the seller, who benefits from it: `delivered` starts the clock that ends in
 * `completed`, which releases their payout. It comes from carrier confirmation — `system` —
 * or from an admin looking at the evidence.
 *
 * The web role cannot write this status at all (migration 0041), so the restriction is not a
 * convention this function keeps.
 */
export async function markOrderDelivered(
  db: Database,
  orderId: string,
  by: { actor: 'system' | 'admin'; actorId?: string | undefined; reason?: string | undefined },
): Promise<Order> {
  return db.transaction(async (tx) =>
    move(tx as unknown as Database, {
      orderId,
      to: 'delivered',
      actor: by.actor,
      actorId: by.actorId ?? null,
      reason: by.reason ?? null,
      set: { deliveredAt: new Date() },
    }),
  );
}

/**
 * The sale is finished and the seller may be paid (FR-5.6). Worker role only.
 *
 * `system` when the hold window has passed, `admin` when a dispute was resolved in the seller's
 * favour. Neither party can reach it: a seller marking their own sale complete would be marking
 * their own homework, and a buyer doing it is AC-5.4's explicit "cannot".
 */
export async function completeOrder(
  db: Database,
  orderId: string,
  by: { actor: 'system' | 'admin'; actorId?: string | undefined; reason?: string | undefined },
): Promise<Order> {
  return db.transaction(async (tx) =>
    move(tx as unknown as Database, {
      orderId,
      to: 'completed',
      actor: by.actor,
      actorId: by.actorId ?? null,
      reason: by.reason ?? null,
      set: { completedAt: new Date() },
    }),
  );
}

export interface OrderEvent {
  id: string;
  orderId: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  actor: OrderActor;
  actorId: string | null;
  reason: string | null;
  at: Date;
}

/**
 * Everything that happened to this order, oldest first.
 *
 * Visible to the two parties and nobody else, which the policy enforces through a subquery on
 * `orders` — so this cannot be used to read somebody else's history sideways.
 */
export async function listOrderEvents(
  db: Database,
  viewerId: string,
  orderId: string,
): Promise<OrderEvent[]> {
  return asUser(db, viewerId, async (tx) =>
    tx.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)).orderBy(orderEvents.at),
  );
}

/**
 * Delivered orders whose hold window has passed. Worker role only.
 *
 * What the nightly job asks for. The window is counted from `delivered_at` rather than from the
 * payment, because the buyer's chance to complain starts when the card arrives — and a parcel
 * that took three weeks should not arrive with its dispute window already spent.
 */
export async function ordersReadyToComplete(
  db: Database,
  now: Date = new Date(),
  afterDays: number = AUTO_COMPLETE_AFTER_DAYS,
): Promise<Order[]> {
  const cutoff = new Date(now.getTime() - afterDays * 24 * 60 * 60 * 1000);
  return (
    db
      .select()
      .from(orders)
      // `lte` rather than a `sql` template: a raw Date interpolated into one binds with a type
      // postgres.js will not serialise, and the error names neither the column nor the value.
      // The builder knows this column is a timestamp and encodes it properly.
      .where(and(eq(orders.status, 'delivered'), lte(orders.deliveredAt, cutoff)))
      .orderBy(orders.deliveredAt)
      .limit(200)
  );
}

/**
 * Stripe says the money went back (FR-5.5). Worker role only.
 *
 * `refunded` is reachable by `stripe` and nobody else, which is the same rule as `paid` and for
 * the same reason: an admin can *ask* Stripe to refund, and what moves the order is the webhook
 * that follows. The difference between those two sentences is the whole control — an admin who
 * could write `refunded` directly could mark an order refunded without any money moving, and
 * the row would look exactly like one where it had.
 *
 * Idempotent on the status: Stripe sends `charge.refunded` for each refund, and a partially
 * refunded charge that is later refunded in full sends it twice.
 */
export async function markOrderRefunded(
  db: Database,
  input: { orderId: string; reason?: string | undefined },
): Promise<{ applied: boolean; order?: Order }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for('update')
      .limit(1);
    if (!existing) return { applied: false };
    if (existing.status === 'refunded') return { applied: false };

    const order = await move(tx as unknown as Database, {
      orderId: input.orderId,
      to: 'refunded',
      actor: 'stripe',
      reason: input.reason ?? null,
    });
    return { applied: true, order };
  });
}

/**
 * A chargeback (FR-5.5, T11). Worker role only.
 *
 * The buyer went to their bank instead of to us. `completed → disputed` lists `stripe` among
 * its actors precisely for this: a sale can go wrong after it is finished, and a chargeback
 * arrives whenever it arrives.
 *
 * Not an error when the order is already disputed — a buyer who complained here and then went
 * to their bank anyway is the common case, not a contradiction.
 */
export async function markOrderChargedBack(
  db: Database,
  input: { paymentIntentId: string; reason?: string | undefined },
): Promise<{ applied: boolean; order?: Order }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.stripePaymentIntentId, input.paymentIntentId))
      .for('update')
      .limit(1);
    if (!existing) return { applied: false };
    if (existing.status === 'disputed' || existing.status === 'refunded') {
      return { applied: false };
    }

    const order = await move(tx as unknown as Database, {
      orderId: existing.id,
      to: 'disputed',
      actor: 'stripe',
      reason: input.reason ?? 'chargeback opened with the buyer’s bank',
    });
    return { applied: true, order };
  });
}

/** The order a payment belongs to, for a webhook that knows only Stripe's identifier. */
export async function getOrderByPaymentIntent(
  db: Database,
  paymentIntentId: string,
): Promise<Order | null> {
  const [row] = await db
    .select()
    .from(orders)
    .where(eq(orders.stripePaymentIntentId, paymentIntentId))
    .limit(1);
  return row ?? null;
}

/**
 * One order, with no viewer. Worker role only.
 *
 * There is no `asUser` here because there is no user: an admin acting through the console and
 * a webhook acting on Stripe's word are both looking at an order neither of them is a party to.
 * On the web role this returns nothing at all, because `orders` FORCEs row-level security and a
 * connection that has not said who it is matches no rows — so wiring this to the wrong pool
 * fails visibly rather than quietly widening what a session can see.
 */
export async function getOrderById(db: Database, id: string): Promise<Order | null> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return row ?? null;
}
