import { randomUUID } from 'node:crypto';
import { authorize } from '@gth/auth';
import { MAX_PHOTOS_PER_LISTING } from '@gth/core';
import {
  type Database,
  ListingNotYoursError,
  PhotoLimitError,
  PhotoNotFoundError,
  approvePhoto,
  deletePhoto,
  listPhotos,
  listingsSharingPhoto,
  rejectPhoto,
  reorderPhotos,
  startPhotoUpload,
  writeAuditLog,
} from '@gth/db';
import {
  MAX_UPLOAD_BYTES,
  PipelineUnavailableError,
  type Scanner,
  type Storage,
  processUpload,
  uploadKeyFor,
} from '@gth/photos';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

export interface PhotoDeps {
  /** The app_web pool. It may reserve a slot and reorder; it may not judge a file. */
  db: Database;
  /** The app_worker pool, which is the only role that may record what the pipeline found. */
  workerDb: Database;
  storage: Storage;
  scanner?: Scanner | undefined;
}

const idParamSchema = z.object({ id: z.uuid() }).strict();
const photoParamsSchema = z.object({ id: z.uuid(), photoId: z.uuid() }).strict();

/** Only the two the re-encoder can read. WebP is deliberately absent (see `@gth/security`). */
const startSchema = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png']),
    contentLength: z.int().positive().max(MAX_UPLOAD_BYTES),
  })
  .strict();

const reorderSchema = z
  .object({ photoIds: z.array(z.uuid()).min(1).max(MAX_PHOTOS_PER_LISTING) })
  .strict();

function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/**
 * Uploading a photograph is expensive for us and rare for a seller.
 *
 * Each attempt reserves a row and issues a signed URL; each completion decodes, scans and
 * re-encodes a multi-megapixel image. Twenty a minute is more than anybody photographs and far
 * less than anybody scripts.
 */
const PHOTO_MUTATIONS = {
  config: {
    rateLimit: {
      max: 20,
      timeWindow: '1 minute',
      hook: 'preHandler',
      keyGenerator: (request: FastifyRequest) =>
        request.subject ? `photo:${request.subject.userId}` : `ip:${request.ip}`,
    },
  },
} as const;

/**
 * Photographs of the actual card (FR-5.2, SR-5.5).
 *
 * Three steps, and the middle one does not involve us at all:
 *
 * 1. `POST /v1/listings/:id/photos` reserves a row and returns a signed URL.
 * 2. The browser PUTs the file **straight to the bucket**. Ten megabytes per photo through this
 *    process would be a buffer to size and a denial-of-service surface to defend, and would buy
 *    nothing — the bytes are not trusted on arrival either way.
 * 3. `POST /v1/listings/:id/photos/:photoId/complete` runs the pipeline and records the verdict.
 *
 * ## Why step three is synchronous
 *
 * It decodes, scans and re-encodes, which is about a second of work — done inside the request,
 * awaited, so the seller is told immediately whether their photo was accepted and why not.
 *
 * The alternative is a queue, and this repository does not have one (ADR-042 removed Valkey
 * because nothing used it). A queue is the right answer at a scale this is nowhere near; a
 * fire-and-forget promise in a request handler would be the wrong answer at any scale, because
 * nothing would notice when it failed.
 *
 * A photo whose `complete` call never arrives — a closed tab, a crash — stays `pending` and is
 * picked up by the sweeper, which is what makes the immediate call an optimisation rather than
 * the only path.
 */
export function registerPhotoRoutes(app: FastifyInstance, deps: PhotoDeps): void {
  app.post('/v1/listings/:id/photos', PHOTO_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = startSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    /**
     * The key is chosen here, before the row exists, and the row records it.
     *
     * It cannot be derived from the photo id: the web role has no INSERT privilege on `id`
     * (migration 0044), so Postgres generates that and there is nothing to derive from at the
     * moment the key is needed. A fresh UUID is used instead, and `upload_key` on the row is
     * what the pipeline reads — so the file is always looked for where the browser put it.
     */
    const uploadKey = uploadKeyFor(randomUUID());

    let photo;
    try {
      // The row first: the signed URL is *for* this row, and an upload with no row is a file in
      // a bucket that nothing will ever look at or clean up.
      photo = await startPhotoUpload(deps.db, request.subject.userId, {
        listingId: params.data.id,
        uploadKey,
        contentType: body.data.contentType,
      });
    } catch (error) {
      if (error instanceof ListingNotYoursError) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (error instanceof PhotoLimitError) {
        return reply.code(409).send({ error: 'photo_limit', message: error.message });
      }
      throw error;
    }

    const upload = deps.storage.presignUpload({
      key: photo.uploadKey,
      contentType: body.data.contentType,
      contentLength: body.data.contentLength,
    });

    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send({
        photoId: photo.id,
        uploadUrl: upload.url,
        expiresInSeconds: upload.expiresInSeconds,
        // The browser must send exactly these, because they are what the signature covers.
        requiredHeaders: {
          'content-type': body.data.contentType,
          'content-length': String(body.data.contentLength),
        },
      });
  });

  app.post('/v1/listings/:id/photos/:photoId/complete', PHOTO_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const params = photoParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    // Read it back through the policies, so a photo on somebody else's listing is invisible
    // rather than forbidden — and so this route cannot be used to process an arbitrary id.
    const mine = await listPhotos(deps.db, request.subject.userId, params.data.id);
    const photo = mine.find((row) => row.id === params.data.photoId);
    if (!photo) return reply.code(404).send({ error: 'not_found' });
    if (photo.status !== 'pending') {
      return reply.code(409).send({ error: 'already_processed', status: photo.status });
    }

    let outcome;
    try {
      outcome = await processUpload(
        { storage: deps.storage, ...(deps.scanner ? { scanner: deps.scanner } : {}) },
        { photoId: photo.id, uploadKey: photo.uploadKey },
      );
    } catch (error) {
      if (error instanceof PipelineUnavailableError) {
        /**
         * Nothing was decided, so nothing is written.
         *
         * The photo stays `pending` and the sweeper will try again. 503 rather than 500: this
         * is a temporary condition with a `Retry-After`, not a bug in the request.
         */
        request.log.warn({ photoId: photo.id, err: error }, 'photo pipeline unavailable');
        return reply
          .code(503)
          .header('retry-after', '60')
          .send({ error: 'processing_unavailable' });
      }
      throw error;
    }

    if (!outcome.approved) {
      // On the worker, because a session cannot write `status` at all (migration 0044).
      await rejectPhoto(deps.workerDb, photo.id, outcome.reason);
      await writeAuditLog(deps.workerDb, {
        action: 'photo.rejected',
        targetType: 'listing_photo',
        targetId: photo.id,
        diff: { reason: outcome.reason },
      });
      return reply
        .code(422)
        .header('cache-control', 'no-store')
        .send({ status: 'rejected', reason: outcome.reason });
    }

    const approved = await approvePhoto(deps.workerDb, photo.id, outcome.facts);
    if (!approved) return reply.code(409).send({ error: 'already_processed' });

    /**
     * Somebody else's listing already shows this exact picture (SR-5.6).
     *
     * Recorded, not refused. Refusing would let anybody lock a photograph out of the
     * marketplace by uploading it first, which is a worse problem with no appeal path. The
     * audit entry is what a fraud review reads.
     */
    const shared = await listingsSharingPhoto(deps.workerDb, outcome.facts.sha256, photo.listingId);
    if (shared.length > 0) {
      await writeAuditLog(deps.workerDb, {
        action: 'photo.duplicate_detected',
        targetType: 'listing_photo',
        targetId: photo.id,
        diff: { sha256: outcome.facts.sha256, alsoOn: shared },
      });
    }

    return reply.code(200).header('cache-control', 'no-store').send({
      status: 'approved',
      width: approved.width,
      height: approved.height,
    });
  });

  app.get('/v1/listings/:id/photos', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:read');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    const photos = await listPhotos(deps.db, request.subject.userId, params.data.id);
    const items = photos.map((photo) => ({
      id: photo.id,
      status: photo.status,
      position: photo.position,
      width: photo.width,
      height: photo.height,
      rejectionReason: photo.rejectionReason,
      // Only an approved photo has anything to show, and the URL is short-lived. The original
      // has been deleted by this point; there is no code path that hands out a link to one.
      url: photo.objectKey === null ? null : deps.storage.presignView(photo.objectKey).url,
    }));

    // Never cached: these URLs expire, and a cached gallery would serve dead links.
    return reply.header('cache-control', 'no-store').send({ items });
  });

  app.patch('/v1/listings/:id/photos', PHOTO_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = reorderSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    try {
      const items = await reorderPhotos(
        deps.db,
        request.subject.userId,
        params.data.id,
        body.data.photoIds,
      );
      return await reply.header('cache-control', 'no-store').send({ items });
    } catch (error) {
      // A partial order, a repeated id, or an id from another listing all answer the same way:
      // the set given was not the set that exists.
      if (error instanceof PhotoNotFoundError) {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw error;
    }
  });

  app.delete('/v1/listings/:id/photos/:photoId', PHOTO_MUTATIONS, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'listing:write');

    const params = photoParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    let removed;
    try {
      removed = await deletePhoto(deps.db, request.subject.userId, params.data.photoId);
    } catch (error) {
      if (error instanceof PhotoNotFoundError) {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw error;
    }

    /**
     * The row goes first, then the objects.
     *
     * That order is deliberate: if the storage delete fails, the photo is already gone from
     * every gallery and what remains is an orphaned object costing pennies. The other order
     * risks a row pointing at a picture that no longer exists, which is a broken image on a
     * listing somebody is trying to sell.
     */
    for (const key of [removed.uploadKey, removed.objectKey]) {
      if (key === null) continue;
      try {
        await deps.storage.deleteObject(key);
      } catch (error) {
        request.log.warn({ key, err: error }, 'could not remove a deleted photo from storage');
      }
    }

    await writeAuditLog(deps.db, {
      actorId: request.subject.userId,
      action: 'photo.deleted',
      targetType: 'listing_photo',
      targetId: removed.id,
    });
    return reply.code(204).header('cache-control', 'no-store').send();
  });
}
