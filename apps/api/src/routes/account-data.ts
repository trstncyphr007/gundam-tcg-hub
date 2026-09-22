import {
  PASSKEY_CHANGE_MAX_AGE_S,
  PasskeyRequiredError,
  type SecurityNotice,
  authorize,
  requireFreshSession,
} from '@gth/auth';
import {
  type Database,
  countPasskeys,
  deleteAccount,
  exportAccountData,
  getSelfProfile,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * How recent a sign-in must be to take all of an account's data away, or to destroy it:
 * the same ten minutes as changing its passkeys (ADR-025). Both are the kind of thing a
 * stolen, days-old cookie must not be able to do.
 */
const ACCOUNT_DATA_MAX_AGE_MS = PASSKEY_CHANGE_MAX_AGE_S * 1000;

/**
 * Rarely needed, expensive to serve, and exactly what someone in a stolen session would call.
 *
 * Counted per *account*, not per IP: a household or office behind one address must not share
 * five exports an hour between everyone in it. That needs the session, so the limit runs at
 * `preHandler`, after the auth hook has resolved who is asking.
 */
const HOURLY = {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '1 hour',
      hook: 'preHandler',
      keyGenerator: (request: FastifyRequest) =>
        request.subject ? `account:${request.subject.userId}` : `ip:${request.ip}`,
    },
  },
} as const;

const deleteSchema = z.object({ confirm: z.string().min(1).max(320) }).strict();

type Notify = ((notice: SecurityNotice) => Promise<void>) | undefined;

/**
 * Download everything, and delete everything (SR-X.25, ADR-027).
 *
 * `db` must be the read-write (app_web) connection.
 */
export function registerAccountDataRoutes(
  app: FastifyInstance,
  db: Database,
  notify: Notify,
): void {
  app.get('/v1/account/export', HOURLY, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:read');
    requireFreshSession(request.subject, ACCOUNT_DATA_MAX_AGE_MS);

    const data = await exportAccountData(db, request.subject.userId);
    if (!data) return reply.code(404).send({ error: 'not_found' });

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'account.exported',
      targetType: 'user',
      targetId: request.subject.userId,
    });
    // Told, because a full copy leaving is exactly what someone in a stolen session would
    // want — and the owner is the only person who can tell that apart from themselves.
    await notify?.({ email: String(data.account['email']), event: 'data_exported' }).catch(
      () => undefined,
    );

    const day = data.exportedAt.slice(0, 10);
    return reply
      .header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="gundam-tcg-hub-export-${day}.json"`)
      .send(data);
  });

  app.post('/v1/account/delete', HOURLY, async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:write');
    const subject = request.subject;

    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const self = await getSelfProfile(db, subject.userId);
    if (!self) return reply.code(404).send({ error: 'not_found' });

    // Typing the address is the "are you sure": it cannot be done by a stray click, and it
    // cannot be done by a script that only has a session and not the account's details.
    if (parsed.data.confirm.trim().toLowerCase() !== self.email.toLowerCase()) {
      return reply.code(400).send({ error: 'confirmation_mismatch' });
    }

    // An admin is demoted by an operator first (SR-X.9). A stolen admin session deleting the
    // account would take the audit trail's most important actor with it, and the platform
    // could lose its last admin to one request.
    if (subject.role === 'admin') {
      return reply.code(409).send({ error: 'admin_cannot_self_delete' });
    }

    requireFreshSession(subject, ACCOUNT_DATA_MAX_AGE_MS);
    // The ADR-025 ladder once more: an account someone protected with a passkey is not
    // destroyed by whoever holds its inbox.
    if ((await countPasskeys(db, subject.userId)) > 0 && subject.authMethod !== 'passkey') {
      throw new PasskeyRequiredError();
    }

    const email = await deleteAccount(db, subject.userId);
    if (email === null) return reply.code(404).send({ error: 'not_found' });

    await notify?.({ email, event: 'account_deleted' }).catch(() => undefined);
    return reply.header('cache-control', 'no-store').send({ deleted: true });
  });
}
