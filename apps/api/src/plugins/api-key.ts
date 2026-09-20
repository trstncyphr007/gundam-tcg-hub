import { type ApiKeyScope, type Database, findActiveApiKey, touchApiKey } from '@gth/db';
import { hashToken, safeEqual } from '@gth/security';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved once per request; null when no key was presented. */
    apiKey: AuthenticatedKey | null;
  }
}

export interface AuthenticatedKey {
  id: string;
  prefix: string;
  scopes: ApiKeyScope[];
  tier: string;
  ownerId: string | null;
}

/** `gth_live_<prefix>_<secret>` — the prefix is a public handle, the secret never stored. */
export const API_KEY_PATTERN = /^gth_(?:live|test)_([a-z0-9]{8})_([A-Za-z0-9_-]{32,})$/;

export interface ApiKeyDeps {
  /**
   * The pool whose role may read `key_hash`. That is the worker role and only the worker
   * role: the web role has no SELECT privilege on the column (migration 0017), so
   * verification cannot accidentally be moved onto the tier that serves sessions.
   */
  keysDb: Database;
  tokenPepper: string;
}

export class ApiKeyError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'ApiKeyError';
    this.status = status;
  }
}

/**
 * Verify a presented key, or return null when none was presented.
 *
 * Throws only when a key *was* offered and is not usable, so "no key" and "a bad key" stay
 * distinguishable: the public API allows the first and must refuse the second.
 */
export async function authenticateApiKey(
  request: FastifyRequest,
  deps: ApiKeyDeps,
): Promise<AuthenticatedKey | null> {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;

  const presented = header.slice('Bearer '.length).trim();
  const match = API_KEY_PATTERN.exec(presented);
  // A malformed key is a refusal, not an anonymous request: someone meant to authenticate
  // and failed, and serving them anyway would hide a broken integration from its owner.
  if (!match) throw new ApiKeyError(401, 'invalid_api_key');
  const [, prefix, secret] = match;

  const key = await findActiveApiKey(deps.keysDb, String(prefix));
  if (!key) throw new ApiKeyError(401, 'invalid_api_key');
  // Constant-time compare of keyed hashes; a wrong secret leaks no timing signal.
  if (!safeEqual(hashToken(String(secret), deps.tokenPepper), key.keyHash)) {
    throw new ApiKeyError(401, 'invalid_api_key');
  }

  // Fire-and-forget: a failed bookkeeping write must not fail the request it describes, and
  // the value is approximate by nature (SR-3.1).
  void touchApiKey(deps.keysDb, key.id).catch(() => undefined);

  return {
    id: key.id,
    prefix: key.prefix,
    scopes: key.scopes,
    tier: key.tier,
    ownerId: key.ownerId,
  };
}

/** Throws unless the key carries the scope. A request with no key has no scopes at all. */
export function requireScope(key: AuthenticatedKey | null, scope: ApiKeyScope): void {
  if (!key) throw new ApiKeyError(401, 'api_key_required');
  if (!key.scopes.includes(scope)) throw new ApiKeyError(403, 'insufficient_scope');
}

/**
 * Resolves an API key for every request, without requiring one.
 *
 * Deliberately separate from the session plugin: a key and a session are different kinds of
 * caller and must never be confused for one another. Nothing here consults `request.subject`,
 * and no route may treat a key as a signed-in user.
 */
const apiKeyPluginImpl: FastifyPluginAsync<ApiKeyDeps> = (app, deps) => {
  app.decorateRequest('apiKey', null);

  app.addHook('onRequest', async (request, reply) => {
    try {
      request.apiKey = await authenticateApiKey(request, deps);
    } catch (error) {
      if (error instanceof ApiKeyError) {
        // The key itself must never reach a log line, here or anywhere (SR-3.1).
        request.log.warn({ route: request.url }, 'api key rejected');
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
    return undefined;
  });

  return Promise.resolve();
};

export const apiKeyPlugin = fp(apiKeyPluginImpl, { name: 'gth-api-key' });
