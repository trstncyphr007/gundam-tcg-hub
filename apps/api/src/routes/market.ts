import { ListingError, canPublish } from '@gth/core';
import { authorize } from '@gth/auth';
import {
  type Database,
  ListingNotFoundError,
  createListing,
  deleteDraftListing,
  getListing,
  listMyListings,
  setListingStatus,
  updateListing,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

const conditionSchema = z.enum(['nm', 'lp', 'mp', 'hp', 'dmg']);

const createSchema = z
  .object({
    cardVariantId: z.uuid(),
    condition: conditionSchema,
    priceCents: z.int().positive(),
    quantity: z.int().positive().default(1),
    notes: z.string().max(500).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    priceCents: z.int().positive(),
    quantity: z.int().positive(),
    condition: conditionSchema.optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();

/**
 * `sold` is not here, and that is the point.
 *
 * A listing becomes sold because an order was paid for, on the worker, after a verified
 * webhook. The database refuses it from this role too (migration 0042); this schema is the
 * polite refusal, that one is the real one.
 */
const statusSchema = z.object({ status: z.enum(['draft', 'active', 'withdrawn']) }).strict();

const idParamSchema = z.object({ id: z.uuid() }).strict();

/** Field names and rule codes only: never echo the submitted value back (SR-X.10). */
function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/**
 * Selling a card (FR-5.2).
 *
 * Counted per account rather than per address, like watches: a household behind one address
 * should not share a seller's allowance, and one seller on two connections should not escape
 * it. `preHandler`, because the session has to be resolved before there is a user to count.
 */
const PER_USER_MUTATIONS = {
  config: {
    rateLimit: {
      max: 60,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: (request: FastifyRequest) =>
        request.subject ? `listing:${request.subject.userId}` : `ip:${request.ip}`,
    },
  },
} as const;

/** Marketplace listings. `db` is the app_web pool; every write declares its user. */
export function registerMarketRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/listings', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:read');

    const items = await listMyListings(db, request.subject.userId);
    return reply.header('cache-control', 'no-store').send({ items });
  });

  app.post('/v1/listings', PER_USER_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(parsed.error) });
    }

    let listing;
    try {
      // The seller is the session user. Any sellerId in the body was rejected by `.strict()`.
      listing = await createListing(db, request.subject.userId, parsed.data);
    } catch (error) {
      if (error instanceof ListingError) {
        return reply.code(400).send({ error: error.code, message: error.message });
      }
      // A card variant that does not exist reaches the app's handler as a 404, the same way
      // every other missing reference does (#64).
      throw error;
    }

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'listing.created',
      targetType: 'listing',
      targetId: listing.id,
    });
    return reply.code(201).header('cache-control', 'no-store').send(listing);
  });

  app.get('/v1/listings/:id', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:read');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    const listing = await getListing(db, request.subject.userId, params.data.id);
    if (!listing) return reply.code(404).send({ error: 'not_found' });
    return reply.header('cache-control', 'no-store').send(listing);
  });

  app.patch('/v1/listings/:id', PER_USER_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = updateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    try {
      const listing = await updateListing(db, request.subject.userId, params.data.id, body.data);
      return await reply.header('cache-control', 'no-store').send(listing);
    } catch (error) {
      // Somebody else's listing and a listing that never existed answer the same way. Which
      // of the two it was is not a distinction a stranger is entitled to.
      if (error instanceof ListingNotFoundError) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (error instanceof ListingError) {
        return reply.code(400).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /**
   * Going on sale, or coming off it.
   *
   * The photo requirement is checked here rather than in the query layer because it is a
   * question about the listing *and* its photos, and the answer changes as photos are added.
   * Slice 4 gives it real photos to count; until then nothing is over the threshold with any.
   */
  app.post('/v1/listings/:id/status', PER_USER_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = statusSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    const existing = await getListing(db, request.subject.userId, params.data.id);
    if (!existing || existing.sellerId !== request.subject.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    if (body.data.status === 'active') {
      const allowed = canPublish({ priceCents: existing.priceCents, photoCount: 0 });
      if (!allowed.ok) {
        return reply.code(409).send({ error: allowed.error.code, message: allowed.error.message });
      }
    }

    try {
      const listing = await setListingStatus(
        db,
        request.subject.userId,
        params.data.id,
        body.data.status,
      );
      await writeAuditLog(db, {
        actorId: request.subject.userId,
        action: `listing.${body.data.status}`,
        targetType: 'listing',
        targetId: listing.id,
      });
      return await reply.header('cache-control', 'no-store').send(listing);
    } catch (error) {
      if (error instanceof ListingNotFoundError) {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw error;
    }
  });

  app.delete('/v1/listings/:id', PER_USER_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    // Only a draft goes; anything that has been on sale is withdrawn instead, because an
    // order may point at it and "that listing no longer exists" is not an answer anybody
    // wants during a dispute.
    const removed = await deleteDraftListing(db, request.subject.userId, params.data.id);
    if (!removed) return reply.code(404).send({ error: 'not_found' });

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'listing.deleted',
      targetType: 'listing',
      targetId: params.data.id,
    });
    return reply.code(204).header('cache-control', 'no-store').send();
  });
}
