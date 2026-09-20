import { authorize } from '@gth/auth';
import {
  type ApiKeyScope,
  type Database,
  KeyLimitError,
  MAX_KEYS_PER_USER,
  SELF_SERVE_SCOPES,
  createUserApiKey,
  listApiKeys,
  revokeUserApiKey,
  writeAuditLog,
} from '@gth/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    scopes: z
      .array(z.enum(SELF_SERVE_SCOPES as unknown as [ApiKeyScope, ...ApiKeyScope[]]))
      .min(1)
      .max(SELF_SERVE_SCOPES.length),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() }).strict();

/** Field names and rule codes only: never echo the submitted value back (SR-X.10). */
function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

export interface DeveloperDeps {
  tokenPepper: string;
  production: boolean;
}

/**
 * Self-serve API keys (FR-3.7).
 *
 * Session-authenticated, never key-authenticated: a key cannot be used to mint another key.
 * That would turn a leaked read-only key into a foothold that outlives its own revocation.
 */
export function registerDeveloperRoutes(
  app: FastifyInstance,
  db: Database,
  deps: DeveloperDeps,
): void {
  app.get('/v1/developer/keys', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:read');

    const items = await listApiKeys(db, request.subject.userId);
    return reply.header('cache-control', 'no-store').send({
      items,
      limit: MAX_KEYS_PER_USER,
      scopes: SELF_SERVE_SCOPES,
    });
  });

  app.post('/v1/developer/keys', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:write');

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(parsed.error) });
    }

    let created;
    try {
      created = await createUserApiKey(db, request.subject.userId, {
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        pepper: deps.tokenPepper,
        production: deps.production,
      });
    } catch (error) {
      if (error instanceof KeyLimitError) {
        return reply.code(409).send({ error: 'key_limit_reached', limit: MAX_KEYS_PER_USER });
      }
      throw error;
    }

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: created.key.id,
      // The prefix is the public half and is safe to record; the secret is not written
      // anywhere, including here.
      diff: { prefix: created.key.prefix, scopes: created.key.scopes },
    });

    // The only moment the plaintext exists. It is returned once and never again — there is
    // nothing stored that could reproduce it.
    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send({ ...created.key, key: created.plaintext });
  });

  app.delete('/v1/developer/keys/:id', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'account:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    // 404 for both "no such key" and "not yours": never confirm another user's ids exist.
    const revoked = await revokeUserApiKey(db, request.subject.userId, params.data.id);
    if (!revoked) return reply.code(404).send({ error: 'not_found' });

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: params.data.id,
    });
    return reply.code(204).header('cache-control', 'no-store').send();
  });
}
