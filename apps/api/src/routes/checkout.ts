import { applicationFeeCents } from '@gth/core';
import { authorize } from '@gth/auth';
import {
  type Database,
  FLAGS,
  type FlagReader,
  ListingUnavailableError,
  attachCheckoutSession,
  canSell,
  createOrder,
  describeCardVariant,
  getListing,
  getOrder,
  getSellerPayoutTarget,
  listMyOrders,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { StripeClient } from '../payments/stripe.js';

export interface CheckoutDeps {
  /** The app_web pool. It may open an order and nothing more (migrations 0041 and 0043). */
  db: Database;
  stripe: StripeClient;
  /** Ours, from configuration. Stripe sends the buyer back here and nowhere a request names. */
  appBaseUrl: string;
  /** What we keep, in basis points. Fixed onto the order when it is opened. */
  feeBps: number;
  /** The `market.checkout.enabled` kill switch (§22). Absent means no switch, which is on. */
  flags?: FlagReader | undefined;
}

const idParamSchema = z.object({ id: z.uuid() }).strict();

function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/**
 * Buying is slower and rarer than browsing, and each attempt costs a Stripe round trip and an
 * order row. Ten a minute is more than anybody shops and less than anybody scripts.
 */
const BUYING = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: (request: FastifyRequest) =>
        request.subject ? `buy:${request.subject.userId}` : `ip:${request.ip}`,
    },
  },
} as const;

/**
 * Checkout (FR-5.3, AC-5.1).
 *
 * The purchase, in the order the steps have to happen:
 *
 * 1. **The order exists first.** Its id is what goes into the session's metadata and into the
 *    idempotency key, so it has to be real before Stripe is asked for anything. An order with
 *    no session is a harmless orphan that expires; a session with no order is a payment we
 *    cannot attribute.
 * 2. **Stripe is told the amount, and we are not.** `amount_cents` is copied from the listing
 *    server-side and the fee is computed from it. Nothing in the request body is money, and
 *    `.strict()` means a body claiming to be is rejected rather than ignored.
 * 3. **The card is never here.** The buyer goes to Stripe's own hosted page, which is what
 *    keeps this project at PCI SAQ-A (SR-5.1).
 * 4. **The order stays `created`.** It becomes `paid` when a webhook says the money moved, on
 *    a different database role, and no path through this file can write that status.
 *
 * ## What this deliberately refuses
 *
 * A listing that is not `active`, a seller Stripe will not let take money, your own listing,
 * and a listing somebody else is already part-way through buying. The last of those is a
 * unique index rather than a check, because a check on this role can only see the buyer's own
 * orders and the buyer racing them is by definition somebody else.
 */
export function registerCheckoutRoutes(app: FastifyInstance, deps: CheckoutDeps): void {
  app.post('/v1/listings/:id/buy', BUYING, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:write');
    const buyerId = request.subject.userId;

    // Checked before anything is created, so flipping the switch stops purchases starting
    // rather than stranding half-made ones. 503 with `Retry-After`: this is a deliberate,
    // temporary stop, and a client that treats it as permanent would be wrong.
    if (deps.flags && !(await deps.flags.isEnabled(FLAGS.checkoutEnabled))) {
      return reply.code(503).header('retry-after', '300').send({ error: 'checkout_unavailable' });
    }

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    const listing = await getListing(deps.db, buyerId, params.data.id);
    if (!listing) return reply.code(404).send({ error: 'not_found' });

    // A draft or a withdrawn listing is visible to its own seller, so this is not dead code
    // for the one person who can reach it.
    if (listing.status !== 'active') {
      return reply.code(409).send({ error: 'listing_unavailable' });
    }

    // The database CHECK `orders_not_self_dealing` refuses this too. Answering here is the
    // difference between "you cannot do that" and an unexplained 500.
    if (listing.sellerId === buyerId) {
      return reply.code(409).send({ error: 'cannot_buy_own_listing' });
    }

    const seller = await getSellerPayoutTarget(deps.db, buyerId, listing.sellerId);
    if (!canSell(seller) || seller === null) {
      // Stripe has not cleared this seller to take money or to be paid it. Taking the payment
      // anyway would leave us holding funds we cannot forward, which is the shape of a problem
      // that ends in a refund at best.
      return reply.code(409).send({ error: 'seller_not_ready' });
    }

    /**
     * The whole listing, at the listing's price.
     *
     * Partial quantities need a reservation the buyer holds while they are at Stripe's page,
     * and a half-built reservation oversells — the one bug in a marketplace that costs a seller
     * a card they do not have. Until that exists, buying takes all of it.
     */
    const amountCents = listing.priceCents * listing.quantity;
    const feeCents = applicationFeeCents(amountCents, deps.feeBps);

    let order;
    try {
      order = await createOrder(deps.db, buyerId, {
        sellerId: listing.sellerId,
        listingId: listing.id,
        cardVariantId: listing.cardVariantId,
        condition: listing.condition as 'nm' | 'lp' | 'mp' | 'hp' | 'dmg',
        quantity: listing.quantity,
        amountCents,
        feeCents,
        currency: listing.currency,
      });
    } catch (error) {
      // Somebody else got here between the read above and this insert.
      if (error instanceof ListingUnavailableError) {
        return reply.code(409).send({ error: 'listing_unavailable' });
      }
      throw error;
    }

    const described = await describeCardVariant(deps.db, listing.cardVariantId);
    const description = `${described ?? 'Trading card'} · ${listing.condition.toUpperCase()}`;

    const session = await deps.stripe.createCheckoutSession({
      orderId: order.id,
      destinationAccountId: seller.stripeAccountId,
      description,
      // Stripe multiplies these itself, and its total has to equal the order's amount.
      amountCents: listing.priceCents,
      quantity: listing.quantity,
      currency: listing.currency.toLowerCase(),
      applicationFeeCents: feeCents,
      successUrl: `${deps.appBaseUrl}/orders/${order.id}?paid=1`,
      cancelUrl: `${deps.appBaseUrl}/orders/${order.id}?cancelled=1`,
    });

    // A convenience, not the link: the order id travels inside the signed webhook, so a
    // failure here still leaves a payment we can attribute.
    await attachCheckoutSession(deps.db, buyerId, order.id, session.id);

    await writeAuditLog(deps.db, {
      actorId: buyerId,
      action: 'order.created',
      targetType: 'order',
      targetId: order.id,
    });

    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send({ orderId: order.id, checkoutUrl: session.url });
  });

  /** What this person has bought and sold. Row-level security returns both sides. */
  app.get('/v1/orders', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:read');

    const items = await listMyOrders(deps.db, request.subject.userId);
    return reply.header('cache-control', 'no-store').send({ items });
  });

  app.get('/v1/orders/:id', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:read');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    // Not a party to it and no such order answer the same way, as everywhere else.
    const order = await getOrder(deps.db, request.subject.userId, params.data.id);
    if (!order) return reply.code(404).send({ error: 'not_found' });
    return reply.header('cache-control', 'no-store').send(order);
  });
}
