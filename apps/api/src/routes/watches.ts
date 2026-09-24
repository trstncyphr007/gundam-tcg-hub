import { authorize } from '@gth/auth';
import {
  type Database,
  DuplicateWatchError,
  MAX_WATCHES_PER_USER,
  WatchLimitError,
  createWatch,
  deleteWatch,
  listWatches,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

const channelSchema = z.enum(['email', 'discord_dm', 'discord_webhook', 'web_push']);

const createWatchSchema = z
  .object({
    sealedProductId: z.uuid().optional(),
    retailerProductId: z.uuid().optional(),
    channels: z.array(channelSchema).min(1).max(4),
  })
  .strict()
  // Exactly one target, mirroring the database check constraint.
  .refine((v) => Boolean(v.sealedProductId) !== Boolean(v.retailerProductId), {
    message: 'provide exactly one of sealedProductId or retailerProductId',
  });

const idParamSchema = z.object({ id: z.uuid() }).strict();

/** Field names and rule codes only: never echo the submitted value back (SR-X.10). */
function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/**
 * Adding and removing a watch, counted per *account* (SR-1.9: "watch mutations, 30 per minute
 * per user").
 *
 * That limit was in the plan and in no code: these two routes declared none, so they inherited
 * the global 120 a minute keyed on the caller's **address** — four times looser, and the wrong
 * unit in both directions. A household behind one address shared an allowance they should not
 * have to, and one account spread over several addresses had no per-account limit at all.
 *
 * `preHandler`, like the account-data limit, because the session has to be resolved before
 * there is a user to count. Falls back to the address when there is none, which only happens on
 * the way to a 401.
 */
const PER_USER_MUTATIONS = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: (request: FastifyRequest) =>
        request.subject ? `watch:${request.subject.userId}` : `ip:${request.ip}`,
    },
  },
} as const;

/** Watch subscriptions. Every row is scoped to the session user; `db` is the app_web pool. */
export function registerWatchRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/watches', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'watch:read');

    const items = await listWatches(db, request.subject.userId);
    return reply.header('cache-control', 'no-store').send({ items, limit: MAX_WATCHES_PER_USER });
  });

  app.post('/v1/watches', PER_USER_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'watch:write');

    const parsed = createWatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(parsed.error) });
    }

    let watch;
    try {
      // The owner is the session user; any userId in the body is ignored (and rejected above).
      watch = await createWatch(db, request.subject.userId, {
        sealedProductId: parsed.data.sealedProductId,
        retailerProductId: parsed.data.retailerProductId,
        channels: parsed.data.channels,
      });
    } catch (error) {
      if (error instanceof WatchLimitError) {
        return reply.code(409).send({ error: 'watch_limit_reached', limit: MAX_WATCHES_PER_USER });
      }
      if (error instanceof DuplicateWatchError) {
        return reply.code(409).send({ error: 'watch_exists' });
      }
      // A MissingReferenceError falls through to the app's handler, which answers 404 for
      // every route at once — the id came from a page that outlived the row behind it.
      throw error;
    }

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'watch.created',
      targetType: 'watch_subscription',
      targetId: watch.id,
    });
    return reply.code(201).header('cache-control', 'no-store').send(watch);
  });

  app.delete('/v1/watches/:id', PER_USER_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'watch:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    // 404 for both "missing" and "belongs to someone else": never confirm another
    // user's ids exist (SR-X.6).
    const removed = await deleteWatch(db, request.subject.userId, params.data.id);
    if (!removed) return reply.code(404).send({ error: 'not_found' });

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'watch.deleted',
      targetType: 'watch_subscription',
      targetId: params.data.id,
    });
    return reply.code(204).header('cache-control', 'no-store').send();
  });
}
