import type { Auth, Role, Subject } from '@gth/auth';
import { fromNodeHeaders, toNodeHandler } from '@gth/auth';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved once per request; null when anonymous. Never trust client-sent identity. */
    subject: Subject | null;
  }
}

const ROLE_VALUES = new Set(['user', 'creator', 'seller', 'admin']);

function toRole(value: unknown): Role {
  return typeof value === 'string' && ROLE_VALUES.has(value) ? (value as Role) : 'user';
}

/**
 * Mounts Better Auth at /api/auth/* and resolves the caller's session for every request.
 * Registered inside its own encapsulation so the raw-body parser cannot leak to JSON routes.
 */
const authPluginImpl: FastifyPluginAsync<{ auth: Auth }> = async (app, opts) => {
  const { auth } = opts;

  app.decorateRequest('subject', null);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.raw.headers),
    });
    request.subject = session
      ? { userId: session.user.id, role: toRole((session.user as { role?: unknown }).role) }
      : null;
  });

  await app.register((scope: FastifyInstance, _opts: unknown, done: () => void) => {
    // Better Auth reads the raw body itself; stop Fastify from consuming it first.
    // Encapsulated here, so JSON parsing still works for every other route.
    for (const mime of ['application/json', 'application/x-www-form-urlencoded']) {
      scope.addContentTypeParser(mime, (_req, _payload, cb) => {
        cb(null, null);
      });
    }

    const handler = toNodeHandler(auth);
    scope.all('/api/auth/*', async (request, reply) => {
      reply.hijack();
      await handler(request.raw, reply.raw);
    });
    done();
  });
};

export const authPlugin = fp(authPluginImpl, { name: 'gth-auth' });
