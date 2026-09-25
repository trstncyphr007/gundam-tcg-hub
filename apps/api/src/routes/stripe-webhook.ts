import { IllegalTransitionError } from '@gth/core';
import {
  type Database,
  claimWebhookEvent,
  getOrderByPaymentIntent,
  markOrderChargedBack,
  markOrderPaid,
  markOrderRefunded,
  markWebhookProcessed,
  updateSellerCapabilities,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { StripeClient } from '../payments/stripe.js';

export interface StripeWebhookDeps {
  /**
   * The worker pool. A webhook is not a session: migration 0041 gives the web role nothing on
   * `webhook_events` at all, the two capability columns on `seller_accounts` are outside its
   * grant, and 0043 takes the payment columns on `orders` out of its reach too. This is the
   * role that may write what a verified webhook says.
   */
  workerDb: Database;
  stripe: StripeClient;
}

/**
 * Everything Stripe tells us (SR-5.2).
 *
 * Three properties, in this order, and the order is the design:
 *
 * 1. **Verified against the raw body.** A parsed-and-reserialised body has different bytes
 *    and a signature that will not match. Fastify parses JSON by default, so this route is
 *    registered inside its own scope with a parser that keeps the buffer — widening that
 *    app-wide would change how every other route reads its body.
 * 2. **Claimed before it is acted on.** The unique index on `(provider, event_id)` decides
 *    which delivery is ours; a conflict means somebody already has it. No read, no gap
 *    between checking and acting.
 * 3. **Acknowledged only after it is persisted.** Stripe retries anything that is not a
 *    prompt 2xx, which is how a delivery we dropped comes back.
 *
 * An event type we do not handle is still claimed and still answered 200. Stripe would
 * otherwise retry it for days, and "we received this and chose to ignore it" is a true and
 * useful thing for the table to say.
 *
 * ## The claim is inside the transaction now, and #95 had it outside
 *
 * That was right while nothing was being done about these events and wrong the moment
 * something was. Claim-then-act, as two statements, has a gap: if the handler throws, the
 * claim row is already committed, so Stripe's retry finds a duplicate, is answered 200, and
 * the event is **never processed**. A row with a null `processed_at` records it, but nothing
 * acts on that row — the failure is visible and permanent, which is the worst pair.
 *
 * Inside one transaction a failed handler rolls the claim back with it, and the retry is a
 * fresh claim. Concurrency is unaffected: a second delivery arriving mid-transaction blocks on
 * the unique index and then conflicts, exactly as before. What is lost is the "we were told and
 * did not finish" row — and what replaces it is not having half-finished in the first place.
 */
export async function registerStripeWebhookRoutes(
  app: FastifyInstance,
  deps: StripeWebhookDeps,
): Promise<void> {
  await app.register((scope, _opts, done) => {
    // The raw bytes, kept. This is the only route in the API that needs them, and it needs
    // them because the signature covers exactly what was sent rather than what we made of it.
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, next) => {
        next(null, body);
      },
    );

    scope.post(
      '/v1/webhooks/stripe',
      {
        config: {
          // Generous, and per-IP by default: this endpoint is only ever called by Stripe, and
          // being refused during an incident is worse than being called too often. The
          // signature is what stops anybody else, not the limit.
          rateLimit: { max: 600, timeWindow: '1 minute' },
        },
      },
      async (request, reply) => {
        const signature = request.headers['stripe-signature'];
        if (typeof signature !== 'string') {
          return reply.code(400).send({ error: 'missing_signature' });
        }

        let event;
        try {
          event = deps.stripe.constructEvent(request.body as Buffer, signature);
        } catch {
          // Deliberately no detail. A forged signature and a stale timestamp are the same
          // answer here, and the difference is not something an unauthenticated caller is
          // entitled to learn by trying.
          request.log.warn({ route: '/v1/webhooks/stripe' }, 'webhook signature rejected');
          return reply.code(400).send({ error: 'invalid_signature' });
        }

        const duplicate = await deps.workerDb.transaction(async (tx) => {
          const db = tx as unknown as Database;
          const claim = await claimWebhookEvent(db, {
            provider: 'stripe',
            eventId: event.id,
            type: event.type,
          });
          if (!claim.claimed) return true;

          await handle(db, request, event);
          await markWebhookProcessed(db, claim.id);
          return false;
        });

        // Seen before. 200 rather than 409: Stripe is not doing anything wrong by retrying,
        // and an error would make it keep trying.
        if (duplicate) return reply.send({ received: true, duplicate: true });
        return reply.send({ received: true });
      },
    );

    done();
  });
}

type StripeEvent = { type: string; data: { object: unknown } };

/** What we actually do about each kind of event. Unknown types are acknowledged and ignored. */
async function handle(db: Database, request: FastifyRequest, event: StripeEvent): Promise<void> {
  if (event.type === 'account.updated') return accountUpdated(db, event);
  if (event.type === 'checkout.session.completed') return checkoutCompleted(db, request, event);
  if (event.type === 'charge.refunded') return chargeRefunded(db, request, event);
  if (event.type === 'charge.dispute.created') return chargeDisputed(db, request, event);
}

/** The `payment_intent` on a charge, which arrives as an id or as an expanded object. */
function paymentIntentOf(charge: { payment_intent?: unknown }): string | null {
  if (typeof charge.payment_intent === 'string') return charge.payment_intent;
  if (
    typeof charge.payment_intent === 'object' &&
    charge.payment_intent !== null &&
    typeof (charge.payment_intent as { id?: unknown }).id === 'string'
  ) {
    return (charge.payment_intent as { id: string }).id;
  }
  return null;
}

/**
 * The money went back (FR-5.5).
 *
 * The **only** path to `refunded`. An admin asking Stripe to refund does not move the order;
 * this does, when Stripe confirms it happened. An admin who could write the status directly
 * could mark an order refunded with no money moving, and the row would be indistinguishable
 * from one where it had.
 *
 * A partial refund is not a refunded order. Stripe sends this event for each one, with
 * `amount_refunded` running up to `amount`; anything short of the full amount leaves the order
 * where it is, because the buyer has not been made whole and the sale has not been undone.
 */
async function chargeRefunded(
  db: Database,
  request: FastifyRequest,
  event: StripeEvent,
): Promise<void> {
  const charge = event.data.object as {
    payment_intent?: unknown;
    amount?: unknown;
    amount_refunded?: unknown;
  };
  const paymentIntentId = paymentIntentOf(charge);
  if (paymentIntentId === null) return;

  if (
    typeof charge.amount !== 'number' ||
    typeof charge.amount_refunded !== 'number' ||
    charge.amount_refunded < charge.amount
  ) {
    // Partial, or a shape we did not expect. Recorded rather than acted on: a partial refund
    // is a real thing that wants a human, and guessing at an unfamiliar payload is how an
    // order gets refunded because a field was missing.
    request.log.info({ paymentIntentId }, 'partial or unrecognised refund, order left as it is');
    return;
  }

  const order = await getOrderByPaymentIntent(db, paymentIntentId);
  if (!order) return;

  let result;
  try {
    result = await markOrderRefunded(db, { orderId: order.id, reason: 'refunded by Stripe' });
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    // A refund for an order that cannot legally be refunded — one still `created`, say.
    // Recorded and acknowledged: the money has genuinely moved, so somebody has to look.
    request.log.error({ orderId: order.id, from: error.from }, 'refund for an unrefundable order');
    await writeAuditLog(db, {
      action: 'order.refund_refused',
      targetType: 'order',
      targetId: order.id,
      diff: { from: error.from, reason: error.reason },
    });
    return;
  }

  if (!result.applied) return;
  await writeAuditLog(db, {
    action: 'order.refunded',
    targetType: 'order',
    targetId: order.id,
    diff: { amountCents: charge.amount_refunded },
  });
}

/**
 * The buyer went to their bank instead of to us (T11).
 *
 * `completed → disputed` lists `stripe` among its actors precisely for this: a sale can go
 * wrong after it is finished, and a chargeback arrives whenever it arrives. The order is moved
 * to `disputed` rather than `refunded` because nothing has been decided yet — the bank will
 * take weeks, and the money may come back.
 */
async function chargeDisputed(
  db: Database,
  request: FastifyRequest,
  event: StripeEvent,
): Promise<void> {
  const dispute = event.data.object as { payment_intent?: unknown; reason?: unknown };
  const paymentIntentId = paymentIntentOf(dispute);
  if (paymentIntentId === null) return;

  // Stripe's own vocabulary — `product_not_received`, `fraudulent` — prefixed so nobody reads
  // it as something a person typed.
  const reason =
    typeof dispute.reason === 'string' ? `chargeback:${dispute.reason}` : 'chargeback opened';

  let result;
  try {
    result = await markOrderChargedBack(db, { paymentIntentId, reason });
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    request.log.error({ paymentIntentId, from: error.from }, 'chargeback on an unmovable order');
    return;
  }

  if (!result.applied || !result.order) return;
  request.log.warn({ orderId: result.order.id }, 'chargeback opened');
  await writeAuditLog(db, {
    action: 'order.chargeback',
    targetType: 'order',
    targetId: result.order.id,
    diff: { reason },
  });
}

async function accountUpdated(db: Database, event: StripeEvent): Promise<void> {
  const account = event.data.object as {
    id?: unknown;
    charges_enabled?: unknown;
    payouts_enabled?: unknown;
  };
  if (typeof account.id !== 'string') return;

  // Anything that is not exactly `true` is false. The capability arrives over the network
  // from a service across an API version boundary, and the failure mode of being generous
  // here is somebody taking payments they cannot be paid for.
  const capabilities = {
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
  };

  const updated = await updateSellerCapabilities(db, account.id, capabilities);
  // A connected account we have no row for is not an error: it can be one created and then
  // abandoned before we recorded it, or somebody else's account entirely if the key is ever
  // shared. Nothing to update, nothing to complain about.
  if (!updated) return;

  await writeAuditLog(db, {
    action: capabilities.chargesEnabled ? 'seller.enabled' : 'seller.disabled',
    targetType: 'seller_account',
    targetId: account.id,
  });
}

/**
 * The money moved (FR-5.3, AC-5.1).
 *
 * This is the only place in the codebase that can mark an order `paid`, and it is reached only
 * after the signature over the raw body has been checked. Everything it needs is inside that
 * signed payload: the order id we put in the metadata, the payment intent, and the tax Stripe
 * collected. Nothing is looked up from the request and nothing is asked of a second API call,
 * because a network round trip inside this transaction would hold it open across somebody
 * else's latency.
 *
 * `payment_status` is checked rather than assumed. A completed session is not necessarily a
 * paid one: a delayed payment method leaves the session complete and `unpaid` until it clears,
 * and it clears on a different event. Believing the wrong one ships a card for nothing.
 */
async function checkoutCompleted(
  db: Database,
  request: FastifyRequest,
  event: StripeEvent,
): Promise<void> {
  const session = event.data.object as {
    id?: unknown;
    payment_intent?: unknown;
    payment_status?: unknown;
    metadata?: { orderId?: unknown } | null;
    total_details?: { amount_tax?: unknown } | null;
  };

  if (session.payment_status !== 'paid') return;

  const orderId = session.metadata?.orderId;
  // The payment intent can arrive expanded on some API versions. We want the id either way,
  // and a shape we did not expect is a reason to stop rather than to guess.
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : undefined;
  if (
    typeof orderId !== 'string' ||
    paymentIntentId === undefined ||
    typeof session.id !== 'string'
  )
    return;

  const taxCents = session.total_details?.amount_tax;

  let result;
  try {
    result = await markOrderPaid(db, {
      orderId,
      paymentIntentId,
      checkoutSessionId: session.id,
      taxCents: typeof taxCents === 'number' && Number.isInteger(taxCents) ? taxCents : undefined,
    });
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    /**
     * A payment for an order that cannot legally be paid — cancelled, or already refunded.
     *
     * Recorded and acknowledged, not retried. Stripe would deliver this for days and the
     * answer would not change, and the money has genuinely moved, so somebody has to look at
     * it. That is what the audit entry is for.
     */
    request.log.error(
      { orderId, from: error.from, reason: error.reason },
      'payment for an order that cannot be paid',
    );
    await writeAuditLog(db, {
      action: 'order.payment_refused',
      targetType: 'order',
      targetId: orderId,
      diff: { from: error.from, to: error.to, reason: error.reason },
    });
    return;
  }

  if (!result.applied) {
    // `already_paid` is an ordinary retry that got past the claim; `unknown_order` means the
    // metadata named something that is not here, which is worth saying out loud.
    if (result.reason === 'unknown_order') {
      request.log.error({ orderId }, 'payment for an order we have no record of');
    }
    return;
  }

  await writeAuditLog(db, {
    action: 'order.paid',
    targetType: 'order',
    targetId: result.order.id,
    diff: { amountCents: result.order.amountCents, feeCents: result.order.feeCents },
  });
}
