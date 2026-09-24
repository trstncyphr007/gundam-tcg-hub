import {
  type Database,
  claimWebhookEvent,
  markWebhookProcessed,
  updateSellerCapabilities,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance } from 'fastify';
import type { StripeClient } from '../payments/stripe.js';

export interface StripeWebhookDeps {
  /**
   * The worker pool. A webhook is not a session: migration 0041 gives the web role nothing on
   * `webhook_events` at all, and the two capability columns on `seller_accounts` are outside
   * its grant. This is the role that may write what a verified webhook says.
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

        const claim = await claimWebhookEvent(deps.workerDb, {
          provider: 'stripe',
          eventId: event.id,
          type: event.type,
        });
        if (!claim.claimed) {
          // Seen before. 200 rather than 409: Stripe is not doing anything wrong by retrying,
          // and an error would make it keep trying.
          return reply.send({ received: true, duplicate: true });
        }

        await handle(deps, event);
        await markWebhookProcessed(deps.workerDb, claim.id);
        return reply.send({ received: true });
      },
    );

    done();
  });
}

/** What we actually do about each kind of event. Unknown types are acknowledged and ignored. */
async function handle(deps: StripeWebhookDeps, event: { type: string; data: { object: unknown } }) {
  if (event.type !== 'account.updated') return;

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

  const updated = await updateSellerCapabilities(deps.workerDb, account.id, capabilities);
  // A connected account we have no row for is not an error: it can be one created and then
  // abandoned before we recorded it, or somebody else's account entirely if the key is ever
  // shared. Nothing to update, nothing to complain about.
  if (!updated) return;

  await writeAuditLog(deps.workerDb, {
    action: capabilities.chargesEnabled ? 'seller.enabled' : 'seller.disabled',
    targetType: 'seller_account',
    targetId: account.id,
  });
}
