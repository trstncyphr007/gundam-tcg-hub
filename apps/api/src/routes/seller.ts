import { authorize } from '@gth/auth';
import { type Database, getSellerAccount, recordSellerAccount, writeAuditLog } from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { StripeClient } from '../payments/stripe.js';

export interface SellerDeps {
  /** The app_web pool. The two capability columns are outside its grant on purpose. */
  db: Database;
  stripe: StripeClient;
  /** Where Stripe sends somebody back to. Ours, from configuration, never from a request. */
  appBaseUrl: string;
}

/**
 * Onboarding is one account per person, and slow.
 *
 * Creating a connected account is a network round trip to Stripe, and the only legitimate
 * reason to do it twice is the first one failing. Five an hour leaves room for that and none
 * for a script.
 */
const ONBOARDING = {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '1 hour',
      hook: 'preHandler',
      keyGenerator: (request: FastifyRequest) =>
        request.subject ? `seller:${request.subject.userId}` : `ip:${request.ip}`,
    },
  },
} as const;

/**
 * Becoming a seller (FR-5.1).
 *
 * The whole flow is Stripe's: we create a connected account, hand back a link to their hosted
 * onboarding, and they collect the identity, the bank details and the tax information. We
 * never see any of it. What comes back is an account id and, later, two booleans on a webhook.
 *
 * **`charges_enabled` is read from Stripe, not from our row.** The row is a cache that a
 * webhook fills, and until that webhook exists (next slice) it would be permanently false.
 * Asking Stripe is both correct and honest: they are the only ones who know.
 */
export function registerSellerRoutes(app: FastifyInstance, deps: SellerDeps): void {
  app.get('/v1/seller', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:read');

    const account = await getSellerAccount(deps.db, request.subject.userId);
    if (!account) {
      return reply
        .header('cache-control', 'no-store')
        .send({ onboarded: false, chargesEnabled: false, payoutsEnabled: false });
    }

    // Stripe's answer, live. Ours is a cache with nothing in it yet.
    const status = await deps.stripe.getAccountStatus(account.stripeAccountId);
    return reply.header('cache-control', 'no-store').send({
      onboarded: status.detailsSubmitted,
      chargesEnabled: status.chargesEnabled,
      payoutsEnabled: status.payoutsEnabled,
      // Deliberately not the account id. It is Stripe's identifier for somebody's business
      // and the browser has no use for it.
    });
  });

  app.post('/v1/seller/onboard', ONBOARDING, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const existing = await getSellerAccount(deps.db, request.subject.userId);

    // Reuse the account if there is one. Stripe's onboarding can be abandoned half way and
    // resumed, and starting a second account each time somebody came back would leave a trail
    // of half-finished ones and no answer to which is theirs.
    let accountId = existing?.stripeAccountId;
    if (accountId === undefined) {
      const created = await deps.stripe.createConnectedAccount({ userId: request.subject.userId });
      const recorded = await recordSellerAccount(
        deps.db,
        request.subject.userId,
        created.accountId,
      );
      // `recordSellerAccount` returns the row that won a race, which may not be the one we
      // just created — use whichever is actually stored.
      accountId = recorded.stripeAccountId;

      await writeAuditLog(deps.db, {
        actorId: request.subject.userId,
        action: 'seller.onboarding_started',
        targetType: 'seller_account',
        targetId: recorded.id,
      });
    }

    const link = await deps.stripe.createOnboardingLink({
      accountId,
      returnUrl: `${deps.appBaseUrl}/account/selling?onboarded=1`,
      refreshUrl: `${deps.appBaseUrl}/account/selling`,
    });

    return reply.header('cache-control', 'no-store').send({ url: link.url });
  });
}
