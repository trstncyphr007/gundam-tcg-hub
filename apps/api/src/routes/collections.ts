import { authorize } from '@gth/auth';
import {
  CollectionLimitError,
  type Database,
  MAX_COLLECTIONS_PER_USER,
  addItem,
  createCollection,
  deleteCollection,
  exportCollectionCsv,
  getCollection,
  importCollectionCsv,
  listCollections,
  listItems,
  listPublicCollections,
  removeItem,
  updateCollection,
  updateItem,
  valueCollection,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * The import body cap (SR-3.4).
 *
 * The plan's 2 MB is enforced three times over, deliberately: here as a route body limit, in
 * the parser before it does any work, and by the row cap. A limit that exists in only one
 * place is a limit one refactor away from not existing.
 */
const CSV_BODY_LIMIT = 2 * 1024 * 1024;

const visibilitySchema = z.enum(['private', 'unlisted', 'public']);
const conditionSchema = z.enum(['nm', 'lp', 'mp', 'hp', 'dmg']);

const createSchema = z
  .object({ name: z.string().trim().min(1).max(80), visibility: visibilitySchema.optional() })
  .strict();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    visibility: visibilitySchema.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.visibility !== undefined, {
    message: 'nothing to change',
  });

const addItemSchema = z
  .object({
    cardVariantId: z.uuid(),
    condition: conditionSchema.optional(),
    quantity: z.int().min(1).max(100000).optional(),
    acquiredPriceCents: z.int().min(0).max(100_000_000).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    acquiredAt: z.iso.date().optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();

const patchItemSchema = z
  .object({
    quantity: z.int().min(1).max(100000).optional(),
    // null is meaningful here: it is how you say "I no longer claim to know what this cost",
    // which is a different statement from leaving the field out.
    acquiredPriceCents: z.int().min(0).max(100_000_000).nullable().optional(),
    acquiredAt: z.iso.date().nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() }).strict();
const itemParamSchema = z.object({ id: z.uuid(), itemId: z.uuid() }).strict();
const importQuerySchema = z
  .object({
    // Strings, because they arrive from a query string. The default is the safe one.
    apply: z.enum(['true', 'false']).optional(),
    mode: z.enum(['add', 'replace']).optional(),
  })
  .strict();
const valueQuerySchema = z
  .object({
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    maxAgeDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .strict();

/** Field names and rule codes only: never echo the submitted value back (SR-X.10). */
function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/**
 * Collections (FR-3.4, FR-3.5).
 *
 * Reads are viewer-aware rather than owner-only: a public or unlisted collection is readable
 * without an account, and which rows that means is decided by row-level security rather than
 * by a branch here. Writes are owner-only, checked by `authorize()` and again by the row
 * policies -- a public collection is readable by everyone and writable by one person.
 */
export function registerCollectionRoutes(app: FastifyInstance, db: Database): void {
  // Fastify only parses the content types it knows. CSV arrives as text and is handed
  // straight to the parser, which does its own validation -- nothing here interprets it.
  app.addContentTypeParser(
    'text/csv',
    { parseAs: 'string', bodyLimit: CSV_BODY_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get('/v1/collections', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'collection:read');

    const items = await listCollections(db, request.subject.userId);
    return reply
      .header('cache-control', 'no-store')
      .send({ items, limit: MAX_COLLECTIONS_PER_USER });
  });

  // Static before parameterised, so "public" is never read as an id.
  app.get('/v1/collections/public', async (_request, reply) => {
    const items = await listPublicCollections(db);
    // Public means public: it may be cached, briefly.
    return reply.header('cache-control', 'public, max-age=60').send({ items });
  });

  app.post('/v1/collections', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'collection:write');

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(parsed.error) });
    }

    let collection;
    try {
      // The owner is the session user; an ownerId in the body is rejected by .strict().
      collection = await createCollection(db, request.subject.userId, parsed.data);
    } catch (error) {
      if (error instanceof CollectionLimitError) {
        return reply
          .code(409)
          .send({ error: 'collection_limit_reached', limit: MAX_COLLECTIONS_PER_USER });
      }
      throw error;
    }

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'collection.created',
      targetType: 'collection',
      targetId: collection.id,
    });
    return reply.code(201).header('cache-control', 'no-store').send(collection);
  });

  app.get('/v1/collections/:id', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const viewerId = request.subject?.userId ?? null;
    const collection = await getCollection(db, viewerId, params.data.id);
    if (!collection) return reply.code(404).send({ error: 'not_found' });

    const items = await listItems(db, viewerId, params.data.id);
    // A shared collection shows a name and cards, never who owns it (SR-3.8). The owner id
    // goes out only to the owner.
    const isOwner = collection.ownerId === viewerId;
    return reply.header('cache-control', 'no-store').send({
      id: collection.id,
      name: collection.name,
      visibility: collection.visibility,
      updatedAt: collection.updatedAt,
      ...(isOwner ? { ownerId: collection.ownerId } : {}),
      items,
    });
  });

  app.patch('/v1/collections/:id', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'collection:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(parsed.error) });
    }

    const updated = await updateCollection(db, request.subject.userId, params.data.id, parsed.data);
    // 404 for both "missing" and "someone else's": never confirm another user's ids exist.
    if (!updated) return reply.code(404).send({ error: 'not_found' });

    if (parsed.data.visibility) {
      // Sharing a collection is a privacy decision, so it leaves a record.
      await writeAuditLog(db, {
        actorId: request.subject.userId,
        action: 'collection.visibility_changed',
        targetType: 'collection',
        targetId: updated.id,
        diff: { visibility: parsed.data.visibility },
      });
    }
    return reply.header('cache-control', 'no-store').send(updated);
  });

  app.delete('/v1/collections/:id', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'collection:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const removed = await deleteCollection(db, request.subject.userId, params.data.id);
    if (!removed) return reply.code(404).send({ error: 'not_found' });

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'collection.deleted',
      targetType: 'collection',
      targetId: params.data.id,
    });
    return reply.code(204).header('cache-control', 'no-store').send();
  });

  app.post('/v1/collections/:id/items', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'collection:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const parsed = addItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(parsed.error) });
    }

    // Ownership is checked before the write so a stranger gets 404 rather than a database
    // error, but the row policy is what actually stops it.
    const owned = await getCollection(db, request.subject.userId, params.data.id);
    if (!owned || owned.ownerId !== request.subject.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const item = await addItem(db, request.subject.userId, params.data.id, {
      cardVariantId: parsed.data.cardVariantId,
      condition: parsed.data.condition,
      quantity: parsed.data.quantity,
      acquiredPriceCents: parsed.data.acquiredPriceCents,
      currency: parsed.data.currency,
      acquiredAt: parsed.data.acquiredAt
        ? new Date(`${parsed.data.acquiredAt}T00:00:00Z`)
        : undefined,
      notes: parsed.data.notes,
    });
    return reply.code(201).header('cache-control', 'no-store').send(item);
  });

  app.patch('/v1/collections/:id/items/:itemId', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'collection:write');

    const params = itemParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const parsed = patchItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(parsed.error) });
    }

    const updated = await updateItem(db, request.subject.userId, params.data.itemId, {
      ...(parsed.data.quantity === undefined ? {} : { quantity: parsed.data.quantity }),
      ...(parsed.data.acquiredPriceCents === undefined
        ? {}
        : { acquiredPriceCents: parsed.data.acquiredPriceCents }),
      ...(parsed.data.acquiredAt === undefined
        ? {}
        : {
            acquiredAt:
              parsed.data.acquiredAt === null
                ? null
                : new Date(`${parsed.data.acquiredAt}T00:00:00Z`),
          }),
      ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return reply.header('cache-control', 'no-store').send(updated);
  });

  app.delete('/v1/collections/:id/items/:itemId', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'collection:write');

    const params = itemParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const removed = await removeItem(db, request.subject.userId, params.data.itemId);
    if (!removed) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).header('cache-control', 'no-store').send();
  });

  app.get('/v1/collections/:id/value', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const query = valueQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(query.error) });
    }

    const viewerId = request.subject?.userId ?? null;
    const collection = await getCollection(db, viewerId, params.data.id);
    if (!collection) return reply.code(404).send({ error: 'not_found' });

    const valuation = await valueCollection(db, viewerId, params.data.id, query.data);
    return reply.header('cache-control', 'no-store').send(valuation);
  });

  app.get('/v1/collections/:id/export', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const viewerId = request.subject?.userId ?? null;
    const collection = await getCollection(db, viewerId, params.data.id);
    if (!collection) return reply.code(404).send({ error: 'not_found' });

    const csv = await exportCollectionCsv(db, viewerId, params.data.id);
    return (
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        // attachment, not inline: a CSV rendered in the browser is a CSV the browser has been
        // invited to sniff. Content-Disposition also names the file, which is a courtesy.
        .header('content-disposition', `attachment; filename="collection-${collection.id}.csv"`)
        .header('cache-control', 'no-store')
        .send(csv)
    );
  });

  app.post(
    '/v1/collections/:id/import',
    {
      bodyLimit: CSV_BODY_LIMIT,
      // Parsing a file is the most expensive thing an account can ask for, so it gets a
      // tighter limit than the rest of the API (SR-X.27).
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
      authorize(request.subject, 'collection:write');

      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const query = importQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(query.error) });
      }
      if (typeof request.body !== 'string') {
        return reply.code(415).send({ error: 'expected_text_csv' });
      }

      const owned = await getCollection(db, request.subject.userId, params.data.id);
      if (!owned || owned.ownerId !== request.subject.userId) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Preview unless explicitly told otherwise. Making the safe path the one you get by
      // forgetting is the only way it actually happens.
      const dryRun = query.data.apply !== 'true';
      const report = await importCollectionCsv(
        db,
        request.subject.userId,
        params.data.id,
        request.body,
        { dryRun, mode: query.data.mode ?? 'add' },
      );

      if (!dryRun && (report.created > 0 || report.updated > 0)) {
        await writeAuditLog(db, {
          actorId: request.subject.userId,
          action: 'collection.imported',
          targetType: 'collection',
          targetId: params.data.id,
          diff: { created: report.created, updated: report.updated, errors: report.errors.length },
        });
      }

      // 200 even with row errors: a partially valid file is a normal outcome, and the report
      // is the answer. A 400 would throw away the per-row detail the user needs.
      return reply.header('cache-control', 'no-store').send(report);
    },
  );
}
