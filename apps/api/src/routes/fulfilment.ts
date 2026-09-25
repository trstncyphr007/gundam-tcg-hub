import { authorize } from '@gth/auth';
import { IllegalTransitionError, ORDER_REASON_MAX_LENGTH } from '@gth/core';
import {
  type Database,
  OrderNotFoundError,
  WrongPartyError,
  cancelOrder,
  disputeOrder,
  listOrderEvents,
  shipOrder,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

export interface FulfilmentDeps {
  /** The app_web pool. It can move an order to `shipped`, `cancelled` or `disputed`, and no further. */
  db: Database;
}

const idParamSchema = z.object({ id: z.uuid() }).strict();

/**
 * A carrier and a number, both required (FR-5.4).
 *
 * The plan asks for tracking only above a configurable value; migration 0041's CHECK requires
 * it for every shipped order and this schema agrees. The stricter rule is kept on purpose: an
 * untracked parcel is a dispute with no evidence in it, and the person who loses that argument
 * is the seller — so the requirement protects the party it inconveniences.
 *
 * The number is not validated against a carrier's format. There are hundreds of formats, they
 * change, and a regex that rejects a real tracking number is worse than one that accepts a
 * typo — the buyer finds out either way, and only one of those can be fixed by the seller.
 */
const shipSchema = z
  .object({
    carrier: z.string().min(2).max(64),
    trackingNumber: z.string().min(4).max(64),
  })
  .strict();

const reasonSchema = z.object({ reason: z.string().min(1).max(ORDER_REASON_MAX_LENGTH) }).strict();

const cancelSchema = z
  .object({ reason: z.string().max(ORDER_REASON_MAX_LENGTH).optional() })
  .strict();

function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/**
 * Moving an order is rare and consequential: a handful a day for a busy seller, and each one
 * changes what somebody is owed. Thirty a minute leaves room for a bulk shipping day.
 */
const FULFILMENT = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: (request: FastifyRequest) =>
        request.subject ? `order:${request.subject.userId}` : `ip:${request.ip}`,
    },
  },
} as const;

/**
 * What the two parties may do to an order after it is paid for (FR-5.4, FR-5.5).
 *
 * Three moves, and the list is short because most of the state machine is not theirs:
 *
 * - **ship** — the seller's, and the only transition they own outright. They are the one with
 *   the parcel.
 * - **cancel** — either side, before any money moved. After `paid` the state machine refuses
 *   it: an admin cancels a paid order, and the money comes back through Stripe rather than
 *   through a status change.
 * - **dispute** — the buyer's. A seller cannot dispute their own sale.
 *
 * `delivered` and `completed` are absent, and not by omission. They release the seller's
 * payout, so they come from the carrier, the clock or an admin — never from the person who
 * benefits. Migration 0041 refuses to let this database role write either of them, so their
 * absence here is a description of what is possible rather than a rule this file keeps.
 *
 * Every refusal is the same shape: the state machine decides, the route translates. An illegal
 * move is 409 with the reason, because the caller can act on "that order has already shipped"
 * and cannot act on 500.
 */
export function registerFulfilmentRoutes(app: FastifyInstance, deps: FulfilmentDeps): void {
  /** One translation for every transition route, so none of them can invent its own. */
  const refused = (error: unknown): { status: number; body: Record<string, unknown> } | null => {
    if (error instanceof OrderNotFoundError) {
      // Not a party to it and no such order answer alike, as everywhere else.
      return { status: 404, body: { error: 'not_found' } };
    }
    if (error instanceof WrongPartyError) {
      // Visible to them, but not theirs to move. Distinct from 404 on purpose: they can see
      // the order, so pretending it does not exist would be a lie they can check.
      return { status: 403, body: { error: 'wrong_party', expected: error.expected } };
    }
    if (error instanceof IllegalTransitionError) {
      return {
        status: 409,
        body: { error: 'illegal_transition', from: error.from, to: error.to, why: error.reason },
      };
    }
    return null;
  };

  app.post('/v1/orders/:id/ship', FULFILMENT, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = shipSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    try {
      const order = await shipOrder(deps.db, request.subject.userId, params.data.id, body.data);
      await writeAuditLog(deps.db, {
        actorId: request.subject.userId,
        action: 'order.shipped',
        targetType: 'order',
        targetId: order.id,
        // The carrier, not the number: a tracking number identifies a parcel at somebody's
        // address, and the audit log is read by people who do not need it.
        diff: { carrier: order.trackingCarrier },
      });
      return await reply.header('cache-control', 'no-store').send(order);
    } catch (error) {
      const answer = refused(error);
      if (!answer) throw error;
      return reply.code(answer.status).send(answer.body);
    }
  });

  app.post('/v1/orders/:id/cancel', FULFILMENT, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = cancelSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    try {
      const order = await cancelOrder(
        deps.db,
        request.subject.userId,
        params.data.id,
        body.data.reason,
      );
      await writeAuditLog(deps.db, {
        actorId: request.subject.userId,
        action: 'order.cancelled',
        targetType: 'order',
        targetId: order.id,
      });
      return await reply.header('cache-control', 'no-store').send(order);
    } catch (error) {
      const answer = refused(error);
      if (!answer) throw error;
      return reply.code(answer.status).send(answer.body);
    }
  });

  app.post('/v1/orders/:id/dispute', FULFILMENT, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = reasonSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    try {
      const order = await disputeOrder(
        deps.db,
        request.subject.userId,
        params.data.id,
        body.data.reason,
      );
      /**
       * Audited without the reason.
       *
       * The reason is on the `order_events` row, where the two parties and an admin resolving
       * it can read it. Copying free text a buyer typed into the audit log as well puts it in
       * a second place with a different retention and a different audience, for no gain.
       */
      await writeAuditLog(deps.db, {
        actorId: request.subject.userId,
        action: 'order.disputed',
        targetType: 'order',
        targetId: order.id,
      });
      return await reply.header('cache-control', 'no-store').send(order);
    } catch (error) {
      const answer = refused(error);
      if (!answer) throw error;
      return reply.code(answer.status).send(answer.body);
    }
  });

  /**
   * What happened to this order, in order.
   *
   * The record two people reach for when they disagree. Append-only in the database — no role
   * has UPDATE or DELETE on `order_events` — so what it says is what happened.
   */
  app.get('/v1/orders/:id/events', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:read');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    const items = await listOrderEvents(deps.db, request.subject.userId, params.data.id);
    return reply.header('cache-control', 'no-store').send({ items });
  });
}
