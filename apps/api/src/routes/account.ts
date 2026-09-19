import { authorize } from '@gth/auth';
import { type Database, getSelfProfile, updateDisplayName, writeAuditLog } from '@gth/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const updateMeSchema = z
  .object({
    // Shown publicly, so keep it short and free of control characters (SR-3.8).
    displayName: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(/^[^\p{C}<>]+$/u, 'displayName contains invalid characters')
      .nullable(),
  })
  .strict();

/** Authenticated account endpoints. `db` must be the read-write (app_web) connection. */
export function registerAccountRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/me', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:read');

    const user = await getSelfProfile(db, request.subject.userId);
    if (!user) return reply.code(404).send({ error: 'not_found' });
    // Never cache per-user responses (SR-2.2).
    return reply.header('cache-control', 'no-store').send(user);
  });

  app.patch('/v1/me', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:write');

    const parsed = updateMeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: parsed.error.issues.map((i) => ({
          field: i.path.map(String).join('.') || '(root)',
          code: i.code,
        })),
      });
    }

    // Keyed on the session-derived id; `role` is not writable through this path.
    const updated = await updateDisplayName(db, request.subject.userId, parsed.data.displayName);
    if (!updated) return reply.code(404).send({ error: 'not_found' });

    await writeAuditLog(db, {
      action: 'account.display_name.updated',
      targetType: 'user',
      targetId: request.subject.userId,
    });

    return reply.header('cache-control', 'no-store').send(updated);
  });

  // Example of a role-gated surface; the admin UI lands on top of this in Phase 1.
  app.get('/v1/admin/ping', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'admin:access');
    return reply.header('cache-control', 'no-store').send({ status: 'ok', role: 'admin' });
  });
}
