import { authorize } from '@gth/auth';
import {
  AlreadyRatedError,
  type Database,
  NotRatableError,
  getMyRating,
  getReputation,
  listSellerRatings,
  rateOrder,
  updateRating,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

export interface RatingDeps {
  /** The app_web pool. The insert policy is what decides whether a rating may exist at all. */
  db: Database;
}

const idParamSchema = z.object({ id: z.uuid() }).strict();

/**
 * No `sellerId`.
 *
 * It is read from the order. A field for it would be an invitation to rate one account for
 * another's sale — migration 0045's policy refuses that, but there is no reason to accept the
 * field in the first place.
 */
const rateSchema = z
  .object({
    stars: z.int().min(1).max(5),
    comment: z.string().max(500).nullable().optional(),
  })
  .strict();

function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/** Rare and consequential, like everything else that changes what a seller is worth. */
const RATING_LIMIT = {
  config: {
    rateLimit: {
      max: 20,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: (request: FastifyRequest) =>
        request.subject ? `rating:${request.subject.userId}` : `ip:${request.ip}`,
    },
  },
} as const;

/**
 * Seller reputation (FR-5.7).
 *
 * A rating is a receipt: it exists because a specific order completed. Every condition that
 * makes that true lives in the database policy rather than here — the order is yours, you are
 * the buyer, it is completed, and the seller matches. This file does not re-check them, and the
 * omission is deliberate: a second copy of a rule drifts from the first, and the copy that
 * matters is the one an attacker cannot reach around.
 *
 * What this file does is turn a refusal into an answer. All four conditions come back as the
 * same 403, because "you are not the buyer" and "that order is not finished" are different
 * amounts of information to give somebody probing.
 */
export function registerRatingRoutes(app: FastifyInstance, deps: RatingDeps): void {
  app.post('/v1/orders/:id/rating', RATING_LIMIT, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = rateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    try {
      const rating = await rateOrder(deps.db, request.subject.userId, {
        orderId: params.data.id,
        stars: body.data.stars,
        comment: body.data.comment ?? null,
      });
      await writeAuditLog(deps.db, {
        actorId: request.subject.userId,
        action: 'order.rated',
        targetType: 'order',
        targetId: params.data.id,
        // The score, not the comment. What somebody wrote about a seller belongs on the rating
        // where both parties can read it, not in a log with a different audience.
        diff: { stars: rating.stars },
      });
      return await reply.code(201).header('cache-control', 'no-store').send(rating);
    } catch (error) {
      if (error instanceof AlreadyRatedError) {
        return reply.code(409).send({ error: 'already_rated' });
      }
      if (error instanceof NotRatableError) {
        return reply.code(403).send({ error: 'not_ratable' });
      }
      throw error;
    }
  });

  app.patch('/v1/ratings/:id', RATING_LIMIT, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = rateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    try {
      const rating = await updateRating(deps.db, request.subject.userId, params.data.id, {
        stars: body.data.stars,
        comment: body.data.comment ?? null,
      });
      return await reply.header('cache-control', 'no-store').send(rating);
    } catch (error) {
      // Somebody else's rating and one that never existed answer alike.
      if (error instanceof NotRatableError) return reply.code(404).send({ error: 'not_found' });
      throw error;
    }
  });

  /** What this buyer said about this order, so a form can open already filled in. */
  app.get('/v1/orders/:id/rating', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'order:read');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    const rating = await getMyRating(deps.db, request.subject.userId, params.data.id);
    if (!rating) return reply.code(404).send({ error: 'not_found' });
    return reply.header('cache-control', 'no-store').send(rating);
  });

  /**
   * A seller's reputation.
   *
   * Signed in, but with no ownership test at all: the person deciding whether to buy is by
   * definition not a party to the orders being rated, so reputation that only its subject could
   * read would be useless. The rater is never in the response.
   */
  app.get('/v1/sellers/:id/ratings', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:read');

    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const [reputation, items] = await Promise.all([
      getReputation(deps.db, id),
      listSellerRatings(deps.db, id),
    ]);
    // Short-lived rather than no-store: a reputation is public and changes slowly, and a page
    // showing one thirty seconds stale has told nobody anything untrue.
    return reply.header('cache-control', 'private, max-age=30').send({ reputation, items });
  });
}
