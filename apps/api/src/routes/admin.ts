import { authorize, requireAdminStepUp } from '@gth/auth';
import {
  type Database,
  MAX_REASON_LENGTH,
  ModerationError,
  decideFlag,
  decideReport,
  getModerationQueue,
  getOperationsSummary,
  normaliseReason,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * The admin moderation console's API (SR-3.5, SR-4.4, SR-1.10, SR-5.9).
 *
 * Every route here demands four things, in this order, and fails closed on each:
 *
 *   1. a session                                 → 401
 *   2. the admin role                            → 403 `forbidden`
 *   3. a session opened with a verified passkey  → 403 `passkey_required`
 *   4. opened within the last twelve hours       → 403 `step_up_required`
 *
 * The last two are distinct from the second on purpose. The caller *is* allowed; the session
 * they hold is not enough for this. The client's fix is "sign in with your passkey", not
 * "you cannot do this", and the errors say so (ADR-024, ADR-025).
 *
 * Reads use the web pool. Decisions run on the **worker** pool — the only role that may mark
 * a price as counting (migration 0027) — and every one of them is audited with its reason.
 */

export interface AdminDeps {
  /** Web pool: reading the queues and writing the audit log. */
  db: Database;
  /** Worker pool: the one role permitted to change whether a price counts. */
  workerDb: Database;
}

const idParamSchema = z.object({ id: z.uuid() }).strict();

const reportDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().max(MAX_REASON_LENGTH + 50),
  })
  .strict();

const flagDecisionSchema = z
  .object({
    decision: z.enum(['clear', 'reject']),
    reason: z.string().max(MAX_REASON_LENGTH + 50),
  })
  .strict();

function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/** All four gates, as one call, so no route can forget one. */
function guard(request: FastifyRequest, reply: FastifyReply): string | null {
  if (!request.subject) {
    void reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  authorize(request.subject, 'admin:access');
  requireAdminStepUp(request.subject);
  return request.subject.userId;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, workerDb } = deps;

  app.get('/v1/admin/moderation', async (request, reply) => {
    const actor = guard(request, reply);
    if (actor === null) return reply;

    const queue = await getModerationQueue(db);
    return reply.header('cache-control', 'no-store').send(queue);
  });

  // Scanner health, restocks and alert delivery at a glance (FR-1.12). Read-only and
  // aggregate — no user appears in it — but behind the same four gates: which retailers are
  // being watched, and how the alerting is failing, is not for the public.
  app.get('/v1/admin/operations', async (request, reply) => {
    const actor = guard(request, reply);
    if (actor === null) return reply;

    const summary = await getOperationsSummary(db);
    return reply.header('cache-control', 'no-store').send(summary);
  });

  app.post(
    '/v1/admin/reports/:id/decision',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const actor = guard(request, reply);
      if (actor === null) return reply;

      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = reportDecisionSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
      }

      let reason: string;
      try {
        reason = normaliseReason(body.data.reason);
      } catch (error) {
        if (error instanceof ModerationError) {
          return reply.code(400).send({ error: 'invalid_request', reason: error.message });
        }
        throw error;
      }

      const decided = await decideReport(workerDb, params.data.id, body.data.decision);
      if (!decided) {
        // Already decided — most likely by another admin a moment ago. A conflict, not a
        // not-found: the row exists, it has just moved on.
        return reply.code(409).send({ error: 'already_decided' });
      }

      await writeAuditLog(db, {
        actorId: actor,
        action: `moderation.report.${body.data.decision}`,
        targetType: 'price_observation',
        targetId: params.data.id,
        diff: { decision: body.data.decision, reason },
      });
      return reply
        .header('cache-control', 'no-store')
        .send({ id: params.data.id, decision: body.data.decision });
    },
  );

  app.post(
    '/v1/admin/flags/:id/decision',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const actor = guard(request, reply);
      if (actor === null) return reply;

      const params = idParamSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_found' });
      const body = flagDecisionSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
      }

      let reason: string;
      try {
        reason = normaliseReason(body.data.reason);
      } catch (error) {
        if (error instanceof ModerationError) {
          return reply.code(400).send({ error: 'invalid_request', reason: error.message });
        }
        throw error;
      }

      const decided = await decideFlag(workerDb, params.data.id, body.data.decision);
      if (!decided) return reply.code(409).send({ error: 'already_decided' });

      await writeAuditLog(db, {
        actorId: actor,
        action: `moderation.flag.${body.data.decision}`,
        targetType: 'price_observation',
        targetId: params.data.id,
        diff: { decision: body.data.decision, reason },
      });
      return reply
        .header('cache-control', 'no-store')
        .send({ id: params.data.id, decision: body.data.decision });
    },
  );
}
