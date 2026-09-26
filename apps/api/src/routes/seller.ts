import { authorize } from '@gth/auth';
import { HOLD_RELEASE_AFTER_DAYS } from '@gth/core';
import {
  type Database,
  DisplayNameTakenError,
  getSellerAccount,
  holdSellerPayouts,
  isCheckViolation,
  recordSellerAccount,
  setSellerDisplayName,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { StripeClient } from '../payments/stripe.js';

export interface SellerDeps {
  /** The app_web pool. The two capability columns are outside its grant on purpose. */
  db: Database;
  stripe: StripeClient;
  /** Where Stripe sends somebody back to. Ours, from configuration, never from a request. */
  appBaseUrl: string;
  /**
   * The worker pool, for recording the payout hold — `hold_until` is outside the web role's
   * grant. Optional so a deployment without it still onboards sellers; they are held at Stripe
   * either way, because the account is created with a manual schedule.
   */
  workerDb?: Database | undefined;
}

/**
 * Onboarding is one account per person, and slow.
 *
 * Creating a connected account is a network round trip to Stripe, and the only legitimate
 * reason to do it twice is the first one failing. Five an hour leaves room for that and none
 * for a script.
 */
/**
 * A name is cheap to change and should be; it is also a public string, so not unlimited.
 *
 * Twenty an hour leaves room for somebody trying spellings and none for a script cycling names
 * to dodge a report.
 */
const NAMING = {
  config: {
    rateLimit: {
      max: 20,
      timeWindow: '1 hour',
      hook: 'preHandler',
      keyGenerator: (request: FastifyRequest) =>
        request.subject ? `seller-name:${request.subject.userId}` : `ip:${request.ip}`,
    },
  },
} as const;

/**
 * Length here, shape in the database.
 *
 * zod checks what a client can be told plainly — it is a string, it is not empty, it is not
 * absurd — and the CHECK in migration 0046 is what actually decides. Restating the character
 * class in both places would be two rules that agree until somebody edits one.
 */
const displayNameSchema = z.object({ displayName: z.string().min(2).max(40).nullable() }).strict();

/** Field names and rule codes only: never echo the submitted value back (SR-X.10). */
function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

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
      return reply.header('cache-control', 'no-store').send({
        onboarded: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        displayName: null,
      });
    }

    // Stripe's answer, live. Ours is a cache with nothing in it yet.
    const status = await deps.stripe.getAccountStatus(account.stripeAccountId);
    return reply.header('cache-control', 'no-store').send({
      onboarded: status.detailsSubmitted,
      chargesEnabled: status.chargesEnabled,
      payoutsEnabled: status.payoutsEnabled,
      // Theirs, so they can see and edit it. Public elsewhere, but this is the only route
      // that returns it *to its owner* alongside the rest of their account.
      displayName: account.displayName,
      // Deliberately not the account id. It is Stripe's identifier for somebody's business
      // and the browser has no use for it.
    });
  });

  /**
   * Choose the name buyers see, or remove it (FR-5.7, SR-3.8).
   *
   * The only writable thing on a seller's own account row, and deliberately the only one: the
   * grant behind this covers `display_name` and `updated_at`, so a body that also asks to
   * enable payouts is refused by Postgres. There is no field allowlist here doing that job.
   *
   * Nothing is derived from the account. A seller who never calls this has no public name, and
   * their listings say so by saying nothing.
   */
  app.patch('/v1/seller', NAMING, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const body = displayNameSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    // `null` removes it. An empty string is not a name and is not a way to ask for one to be
    // removed either — the schema refuses it, so "" cannot silently become "no name".
    const chosen = body.data.displayName === null ? null : body.data.displayName.trim();

    let account;
    try {
      account = await setSellerDisplayName(deps.db, request.subject.userId, chosen);
    } catch (error) {
      if (error instanceof DisplayNameTakenError) {
        return reply.code(409).send({ error: 'name_taken' });
      }
      // The CHECK, for anything the schema let through that the database would not. Shape is
      // stated once, in the constraint, so this translates rather than restates it.
      if (isCheckViolation(error)) {
        return reply.code(400).send({ error: 'invalid_display_name' });
      }
      throw error;
    }

    // No row means no connected account: a public seller identity costs an identity check.
    if (!account) return reply.code(409).send({ error: 'not_a_seller' });

    await writeAuditLog(deps.db, {
      actorId: request.subject.userId,
      action: chosen === null ? 'seller.name_cleared' : 'seller.name_set',
      targetType: 'seller_account',
      targetId: account.id,
      // The name itself, because an admin investigating an impersonation report needs to know
      // what it was before it was changed again.
      diff: { displayName: chosen },
    });

    return reply.header('cache-control', 'no-store').send({ displayName: account.displayName });
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

      /**
       * The account is created with manual payouts (see `createConnectedAccount`), and the row
       * records that it is held (FR-5.6). `hold_until` carries the earliest date the hold could
       * be reconsidered — a guess, since the real decision is made from completed orders, but
       * "this seller is held" has to be a fact the database states rather than one inferred
       * from an absence.
       *
       * On the worker, because `hold_until` is outside what a session may write.
       */
      if (deps.workerDb) {
        await holdSellerPayouts(
          deps.workerDb,
          accountId,
          new Date(Date.now() + HOLD_RELEASE_AFTER_DAYS * 24 * 60 * 60 * 1000),
        );
      }

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
