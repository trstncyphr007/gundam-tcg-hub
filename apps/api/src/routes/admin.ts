import { authorize, requireAdminStepUp } from '@gth/auth';
import { IllegalTransitionError, ORDER_REASON_MAX_LENGTH } from '@gth/core';
import {
  type Database,
  MAX_REASON_LENGTH,
  ModerationError,
  OrderNotFoundError,
  completeOrder,
  decideFlag,
  decideReport,
  getModerationQueue,
  type FlagReader,
  getOperationsSummary,
  getOrderById,
  getSecuritySummary,
  isKnownFlag,
  listFlags,
  markOrderDelivered,
  normaliseReason,
  setFlag,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { StripeClient } from '../payments/stripe.js';

/**
 * The admin moderation console's API (SR-3.5, SR-4.4, SR-1.10, SR-5.9).
 *
 * Every route here demands four things, in this order, and fails closed on each:
 *
 *   1. a session                                 → 401
 *   2. the admin role                            → 403 `forbidden`
 *   3. a session opened with a verified passkey  → 403 `passkey_required`
 *   4. opened within the last twelve hours       → 403 `step_up_required`
 *
 * The last two are distinct from the second on purpose. The caller *is* allowed; the session
 * they hold is not enough for this. The client's fix is "sign in with your passkey", not
 * "you cannot do this", and the errors say so (ADR-024, ADR-025).
 *
 * Reads use the web pool. Decisions run on the **worker** pool — the only role that may mark
 * a price as counting (migration 0027) — and every one of them is audited with its reason.
 */

export interface AdminDeps {
  /** Web pool: reading the queues and writing the audit log. */
  db: Database;
  /** Worker pool: the one role permitted to change whether a price counts. */
  workerDb: Database;
  /**
   * The API's own flag reader, so flipping a switch here takes effect in this process at once
   * rather than after its cache expires. Other processes see it within ten seconds.
   */
  flags?: FlagReader | undefined;
  /**
   * The Stripe client, for refunds (FR-5.5). Absent means the refund route is not mounted —
   * a console offering a button that cannot refund anything is worse than one without it.
   */
  stripe?: Pick<StripeClient, 'refundPayment'> | undefined;
}

const idParamSchema = z.object({ id: z.uuid() }).strict();

const reportDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().max(MAX_REASON_LENGTH + 50),
  })
  .strict();

/** An admin moving an order says why, every time (SR-5.9). */
const adminOrderSchema = z
  .object({ reason: z.string().min(1).max(ORDER_REASON_MAX_LENGTH) })
  .strict();

/**
 * A refund says why, and says who bears it.
 *
 * `reverseTransfer` defaults to true — the seller gives back their share, which is right when
 * the card never arrived. Setting it false leaves them paid and the platform out of pocket,
 * which is a goodwill decision somebody should have to make on purpose and which the audit
 * entry records either way.
 */
const refundSchema = z
  .object({
    reason: z.string().min(1).max(ORDER_REASON_MAX_LENGTH),
    reverseTransfer: z.boolean().optional(),
  })
  .strict();

const killSwitchSchema = z
  .object({ enabled: z.boolean(), reason: z.string().max(MAX_REASON_LENGTH + 50) })
  .strict();

const flagDecisionSchema = z
  .object({
    decision: z.enum(['clear', 'reject']),
    reason: z.string().max(MAX_REASON_LENGTH + 50),
  })
  .strict();

function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/** All four gates, as one call, so no route can forget one. */
function guard(request: FastifyRequest, reply: FastifyReply): string | null {
  if (!request.subject) {
    void reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  authorize(request.subject, 'admin:access');
  requireAdminStepUp(request.subject);
  return request.subject.userId;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, workerDb, flags } = deps;

  app.get('/v1/admin/moderation', async (request, reply) => {
    const actor = guard(request, reply);
    if (actor === null) return reply;

    const queue = await getModerationQueue(db);
    return reply.header('cache-control', 'no-store').send(queue);
  });

  // Scanner health, restocks and alert delivery at a glance (FR-1.12). Read-only and
  // aggregate — no user appears in it — but behind the same four gates: which retailers are
  // being watched, and how the alerting is failing, is not for the public.
  app.get('/v1/admin/operations', async (request, reply) => {
    const actor = guard(request, reply);
    if (actor === null) return reply;

    const summary = await getOperationsSummary(db);
    return reply.header('cache-control', 'no-store').send(summary);
  });

  // What the audit log says about attempts that failed (SR-X.22). Counts and day-hashes only:
  // the question is "is something happening right now?", and a number that jumps answers it
  // without naming anyone.
  app.get('/v1/admin/security', async (request, reply) => {
    const actor = guard(request, reply);
    if (actor === null) return reply;

    const summary = await getSecuritySummary(db);
    return reply.header('cache-control', 'no-store').send(summary);
  });

  // The kill switches (§22, ADR-039). Reading them is harmless; flipping one is rare, audited,
  // and requires a reason — "who turned this off and what for" is the first question asked
  // the next morning.
  app.get('/v1/admin/flags', async (request, reply) => {
    const actor = guard(request, reply);
    if (actor === null) return reply;

    return reply.header('cache-control', 'no-store').send({ flags: await listFlags(db) });
  });

  app.post(
    '/v1/admin/flags/:key',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const actor = guard(request, reply);
      if (actor === null) return reply;

      const key = (request.params as { key?: unknown }).key;
      if (typeof key !== 'string' || !isKnownFlag(key)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const body = killSwitchSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
      }

      let reason: string;
      try {
        reason = normaliseReason(body.data.reason);
      } catch (error) {
        if (error instanceof ModerationError) {
          return reply.code(400).send({ error: 'invalid_request', reason: error.message });
        }
        throw error;
      }

      await setFlag(workerDb, key, body.data.enabled, actor, reason);
      await writeAuditLog(workerDb, {
        actorId: actor,
        action: body.data.enabled ? 'flag.enabled' : 'flag.disabled',
        targetType: 'feature_flag',
        targetId: key,
        diff: { reason },
      });
      // The process that made the change should not have to wait out its own cache.
      flags?.refresh();

      return reply.header('cache-control', 'no-store').send({ flags: await listFlags(db) });
    },
  );

  app.post(
    '/v1/admin/reports/:id/decision',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const actor = guard(request, reply);
      if (actor === null) return reply;

      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = reportDecisionSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
      }

      let reason: string;
      try {
        reason = normaliseReason(body.data.reason);
      } catch (error) {
        if (error instanceof ModerationError) {
          return reply.code(400).send({ error: 'invalid_request', reason: error.message });
        }
        throw error;
      }

      const decided = await decideReport(workerDb, params.data.id, body.data.decision);
      if (!decided) {
        // Already decided — most likely by another admin a moment ago. A conflict, not a
        // not-found: the row exists, it has just moved on.
        return reply.code(409).send({ error: 'already_decided' });
      }

      await writeAuditLog(db, {
        actorId: actor,
        action: `moderation.report.${body.data.decision}`,
        targetType: 'price_observation',
        targetId: params.data.id,
        diff: { decision: body.data.decision, reason },
      });
      return reply
        .header('cache-control', 'no-store')
        .send({ id: params.data.id, decision: body.data.decision });
    },
  );

  app.post(
    '/v1/admin/flags/:id/decision',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const actor = guard(request, reply);
      if (actor === null) return reply;

      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = flagDecisionSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
      }

      let reason: string;
      try {
        reason = normaliseReason(body.data.reason);
      } catch (error) {
        if (error instanceof ModerationError) {
          return reply.code(400).send({ error: 'invalid_request', reason: error.message });
        }
        throw error;
      }

      const decided = await decideFlag(workerDb, params.data.id, body.data.decision);
      if (!decided) return reply.code(409).send({ error: 'already_decided' });

      await writeAuditLog(db, {
        actorId: actor,
        action: `moderation.flag.${body.data.decision}`,
        targetType: 'price_observation',
        targetId: params.data.id,
        diff: { decision: body.data.decision, reason },
      });
      return reply
        .header('cache-control', 'no-store')
        .send({ id: params.data.id, decision: body.data.decision });
    },
  );

  /**
   * The two order transitions neither party may make (FR-5.4, SR-5.9).
   *
   * `delivered` starts the clock and `completed` releases the seller's payout, so both are
   * reachable only by the carrier's confirmation — which this system does not have yet — by the
   * clock, or by an admin who has looked at the evidence.
   *
   * On the **worker** pool, because the web role cannot write either status at all (migration
   * 0041). Behind the same four gates as everything else here, and audited with a reason,
   * because SR-5.9 asks that of any admin action that moves money.
   */
  for (const step of [
    { path: 'deliver', run: markOrderDelivered, action: 'order.delivered' },
    { path: 'complete', run: completeOrder, action: 'order.completed' },
  ] as const) {
    app.post(
      `/v1/admin/orders/:id/${step.path}`,
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const actor = guard(request, reply);
        if (actor === null) return reply;

        const params = idParamSchema.safeParse(request.params);
        if (!params.success) return reply.code(404).send({ error: 'not_found' });
        const body = adminOrderSchema.safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
        }

        let order;
        try {
          order = await step.run(workerDb, params.data.id, {
            actor: 'admin',
            actorId: actor,
            reason: body.data.reason,
          });
        } catch (error) {
          if (error instanceof OrderNotFoundError) {
            return reply.code(404).send({ error: 'not_found' });
          }
          // The state machine refused it. An admin is powerful, not exempt: there is no move
          // from `cancelled` to `delivered` for anybody.
          if (error instanceof IllegalTransitionError) {
            return reply.code(409).send({
              error: 'illegal_transition',
              from: error.from,
              to: error.to,
              why: error.reason,
            });
          }
          throw error;
        }

        await writeAuditLog(db, {
          actorId: actor,
          action: step.action,
          targetType: 'order',
          targetId: order.id,
          diff: { reason: body.data.reason },
        });
        return reply.header('cache-control', 'no-store').send(order);
      },
    );
  }

  /**
   * Give the money back (FR-5.5, SR-5.9).
   *
   * **This route does not refund the order.** It asks Stripe to refund the payment, and the
   * order moves when the `charge.refunded` webhook arrives. Those are two different sentences
   * and the difference is the whole control: an admin who could write `refunded` directly
   * could mark an order refunded with no money moving, and the row would be indistinguishable
   * from one where it had.
   *
   * So the response says `requested`, not `refunded`, and means it.
   *
   * Only mounted when Stripe is configured. An admin console offering a refund button that
   * cannot refund anything is worse than one without it.
   */
  if (deps.stripe) {
    const stripe = deps.stripe;
    app.post(
      '/v1/admin/orders/:id/refund',
      { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const actor = guard(request, reply);
        if (actor === null) return reply;

        const params = idParamSchema.safeParse(request.params);
        if (!params.success) return reply.code(404).send({ error: 'not_found' });
        const body = refundSchema.safeParse(request.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
        }

        const order = await getOrderById(workerDb, params.data.id);
        if (!order) return reply.code(404).send({ error: 'not_found' });
        if (order.stripePaymentIntentId === null) {
          // Nothing was ever charged, so there is nothing to give back. Cancelling is the
          // move for an unpaid order, and it is a different one.
          return reply.code(409).send({ error: 'nothing_to_refund', status: order.status });
        }
        if (order.status === 'refunded') {
          return reply.code(409).send({ error: 'already_refunded' });
        }

        /**
         * Audited **before** the call, not after.
         *
         * If Stripe times out we do not know whether the refund happened, and the entry saying
         * an admin asked is the only record that survives either way. An audit written on
         * success is an audit that is missing exactly when somebody needs it.
         */
        await writeAuditLog(db, {
          actorId: actor,
          action: 'order.refund_requested',
          targetType: 'order',
          targetId: order.id,
          diff: {
            reason: body.data.reason,
            reverseTransfer: body.data.reverseTransfer ?? true,
          },
        });

        const refund = await stripe.refundPayment({
          paymentIntentId: order.stripePaymentIntentId,
          orderId: order.id,
          ...(body.data.reverseTransfer === undefined
            ? {}
            : { reverseTransfer: body.data.reverseTransfer }),
        });

        return reply.header('cache-control', 'no-store').send({
          // Deliberately not `refunded`. The order moves on the webhook, and saying otherwise
          // here would be the console reporting something that has not happened yet.
          status: 'requested',
          refundId: refund.id,
          stripeStatus: refund.status,
          orderStatus: order.status,
        });
      },
    );
  }
}
