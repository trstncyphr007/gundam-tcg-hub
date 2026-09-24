import { type OrderStatus, transition } from '@gth/core';
import { eq, sql } from 'drizzle-orm';
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
