import { authorize } from '@gth/auth';
import {
  type Database,
  ProfileError,
  deleteMyProfile,
  getMyProfile,
  upsertProfile,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * The creator's own breaker profile (FR-4.3).
 *
 * Three routes and no more: read yours, write yours, delete yours. There is no route that
 * reads somebody else's through this file — the public page is served by the read-only role
 * under a policy, so a bug here cannot expose an unpublished profile.
 */
const profileSchema = z
  .object({
    handle: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u, 'handle must be lowercase and url-safe'),
    displayName: z.string().trim().min(1).max(60),
    bio: z.string().trim().max(280).optional(),
    // No default. Publishing is a decision, and a missing field defaulting to `true` would
    // make a form bug into a privacy incident.
    published: z.boolean(),
  })
  .strict();

function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

export function registerProfileRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/me/profile', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'profile:write');

    const profile = await getMyProfile(db, request.subject.userId);
    // 200 with null, not 404: "you have no profile yet" is the normal state of this route
    // and the form needs to render for it.
    return reply.header('cache-control', 'no-store').send({ profile });
  });

  app.put('/v1/me/profile', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'profile:write');

    const body = profileSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    let profile;
    try {
      profile = await upsertProfile(db, request.subject.userId, {
        handle: body.data.handle,
        displayName: body.data.displayName,
        bio: body.data.bio,
        published: body.data.published,
      });
    } catch (error) {
      // A taken or reserved handle is an ordinary form outcome, not a server fault.
      if (error instanceof ProfileError) {
        return reply.code(409).send({ error: 'profile_rejected', reason: error.message });
      }
      throw error;
    }

    // Publishing puts a name on the open internet, so it is an audited event and the diff
    // records the state it moved to (SR-X.21).
    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'profile.saved',
      targetType: 'creator_profile',
      targetId: profile.id,
      diff: { handle: profile.handle, published: profile.published },
    });
    return reply.header('cache-control', 'no-store').send({ profile });
  });

  app.delete('/v1/me/profile', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'profile:write');

    const removed = await deleteMyProfile(db, request.subject.userId);
    if (!removed) return reply.code(404).send({ error: 'not_found' });

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'profile.deleted',
      targetType: 'creator_profile',
      targetId: request.subject.userId,
    });
    return reply.code(204).header('cache-control', 'no-store').send();
  });
}
