import { authorize, describeDevice, mayRevoke } from '@gth/auth';
import {
  type Database,
  countOtherPasskeySessions,
  deleteOtherSessions,
  deleteOwnSession,
  findOwnSession,
  listActiveSessions,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/** Better Auth session ids: short, URL-safe. Anything else is refused before a query runs. */
const sessionIdSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) }).strict();

const METHODS = new Set(['passkey', 'magic_link', 'discord']);

function methodOf(value: string | null): 'passkey' | 'magic_link' | 'discord' | null {
  return value !== null && METHODS.has(value)
    ? (value as 'passkey' | 'magic_link' | 'discord')
    : null;
}

/**
 * The owner's view of their own sessions, and the way to end them (§16.2, SR-X.5, ADR-026).
 *
 * These replace Better Auth's `/list-sessions` and `/revoke-*`, which are switched off: the
 * first hands out every session's token, and the others would let an email session end a
 * passkey one. Nothing returned here is a credential — the id names a session, it does not
 * open one.
 *
 * `db` must be the read-write (app_web) connection.
 */
export function registerSessionRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/account/sessions', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:read');
    const current = request.subject.sessionId;

    const rows = await listActiveSessions(db, request.subject.userId);
    return reply.header('cache-control', 'no-store').send({
      sessions: rows.map((row) => ({
        id: row.id,
        // Named on the server, never the raw header: a user agent is attacker-chosen text.
        device: describeDevice(row.userAgent),
        method: methodOf(row.authMethod),
        signedInAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        current: row.id === current,
      })),
    });
  });

  app.post('/v1/account/sessions/:id/revoke', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:write');

    const params = sessionIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    // Keyed on the owner: another account's session id is "not found", exactly like a made-up
    // one — the answer must not confirm that a session exists (SR-X.6).
    const target = await findOwnSession(db, request.subject.userId, params.data.id);
    if (!target) return reply.code(404).send({ error: 'not_found' });

    if (!mayRevoke(request.subject.authMethod, methodOf(target.authMethod))) {
      return reply.code(403).send({ error: 'passkey_session_required' });
    }

    await deleteOwnSession(db, request.subject.userId, target.id);
    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'auth.session_revoked',
      targetType: 'user',
      targetId: request.subject.userId,
      diff: { count: 1, own: target.id === request.subject.sessionId },
    });
    return reply.header('cache-control', 'no-store').code(204).send();
  });

  app.post('/v1/account/sessions/revoke-others', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:write');
    const current = request.subject.sessionId;
    // Without knowing which session is asking, "everything else" would include it.
    if (!current) return reply.code(401).send({ error: 'unauthenticated' });

    const includePasskey = request.subject.authMethod === 'passkey';
    const revoked = await deleteOtherSessions(db, request.subject.userId, current, includePasskey);
    const kept = includePasskey
      ? 0
      : await countOtherPasskeySessions(db, request.subject.userId, current);

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'auth.session_revoked',
      targetType: 'user',
      targetId: request.subject.userId,
      diff: { count: revoked, keptPasskeySessions: kept },
    });
    return reply.header('cache-control', 'no-store').send({ revoked, keptPasskeySessions: kept });
  });
}
