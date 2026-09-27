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

    /**
     * The **v2** feed (ADR-045).
     *
     * A second endpoint rather than a branch inside the first, because almost nothing is
     * shared: a different signing secret, a different payload shape, a different verification
     * call, and a different idea of what an event contains. Accepting both on one route would
     * mean a bug in the type-sniffing could let an event signed for one feed be trusted on the
     * other, and that is the one mistake this file exists to make impossible.
     *
     * What *is* shared is the part that matters: raw-body verification first, claim inside the
     * transaction second, act third, acknowledge last. The `webhook_events` table is the same
     * table, so a v2 event id is protected against replay by the same unique index.
     */
    scope.post(
      '/v1/webhooks/stripe-v2',
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const signature = request.headers['stripe-signature'];
        if (typeof signature !== 'string') {
          return reply.code(400).send({ error: 'missing_signature' });
        }

        let event;
        try {
          event = deps.stripe.verifyV2Event(request.body as Buffer, signature);
        } catch {
          // Same silence as the v1 route, for the same reason: a forged signature, a stale
          // timestamp and a malformed body are one answer to an unauthenticated caller.
          request.log.warn({ route: '/v1/webhooks/stripe-v2' }, 'v2 webhook signature rejected');
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

          await handleV2(db, request, deps, event);
          await markWebhookProcessed(db, claim.id);
          return false;
        });

        if (duplicate) return reply.send({ received: true, duplicate: true });
        return reply.send({ received: true });
      },
    );

    done();
  });
}

/**
 * What we do about a v2 event: look the account up and write down what Stripe says now.
 *
 * There is no payload to read — v2 account events are thin, carrying an id and a pointer. So
 * rather than believing a snapshot, this **re-reads the account** and records the current
 * answer. That is a better contract than v1's, not a worse one: two events delivered out of
 * order converge on the same correct row instead of the older one winning.
 *
 * The cost is one API call per event, on the worker, for an event type that fires a handful of
 * times per seller in their life.
 */
async function handleV2(
  db: Database,
  request: FastifyRequest,
  deps: StripeWebhookDeps,
  event: {
    id: string;
    type: string;
    relatedObjectId: string | null;
    relatedObjectType: string | null;
  },
): Promise<void> {
  if (event.relatedObjectType !== 'v2.core.account' || event.relatedObjectId === null) return;
  const accountId = event.relatedObjectId;

  const status = await deps.stripe.getAccountStatus(accountId);

  /**
   * Four states collapsed to two booleans, and only `active` is true.
   *
   * `pending` is not "nearly allowed" — it is Stripe saying it has not decided. Treating it as
   * enabled would let somebody list a card for sale that nobody could pay them for. The richer
   * status is reported live on `/v1/seller`; what is stored is the decision.
   */
  const capabilities = {
    chargesEnabled: status.transfers === 'active',
    payoutsEnabled: status.payouts === 'active',
  };

  const updated = await updateSellerCapabilities(db, accountId, capabilities);
  // An account we have no row for is not an error — created then abandoned before we recorded
  // it, or somebody else's entirely. Nothing to update, nothing to complain about.
  if (!updated) return;

  request.log.info(
    { accountId, transfers: status.transfers, payouts: status.payouts },
    'seller capabilities updated from a v2 event',
  );
  await writeAuditLog(db, {
    action: capabilities.chargesEnabled ? 'seller.enabled' : 'seller.disabled',
    targetType: 'seller_account',
    targetId: accountId,
    // The four-state answer, because "disabled" alone does not tell an admin whether to wait
    // or to go and ask the seller for something.
    diff: { transfers: status.transfers, payouts: status.payouts },
  });
}

type StripeEvent = { type: string; data: { object: unknown } };

/**
 * What we actually do about each kind of event. Unknown types are acknowledged and ignored.
 *
 * **`account.updated` is deliberately not here any more** (ADR-045). It used to write a
 * seller's capabilities from `charges_enabled` and `payouts_enabled` on the v1 event. Our
 * accounts are v2 now, and the v1 API reports both of those as `false` for a v2 account —
 * truthfully, because a v2 recipient account genuinely has no v1 charge capability. Leaving the
 * handler in place would mean a stray v1 event could arrive and **disable a working seller**,
 * silently, with a correct-looking value. Capability changes come from the v2 feed below, which
 * reads the capabilities that exist.
 */
async function handle(db: Database, request: FastifyRequest, event: StripeEvent): Promise<void> {
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
