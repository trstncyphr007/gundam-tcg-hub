import type { Database } from '@gth/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/**
 * One description of a public endpoint, used twice.
 *
 * The routes are registered from this list and the OpenAPI document is generated from the
 * same list, so the published contract cannot describe an endpoint that does not exist or
 * miss one that does. A spec maintained by hand is a spec that is wrong by the second
 * release; this one is wrong only if the code is.
 */
export interface PublicRoute {
  /** Fastify path, e.g. `/v1/cards/:id`. Converted to `{id}` form for the document. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  params?: z.ZodType | undefined;
  query?: z.ZodType | undefined;
  response: z.ZodType;
  /** `Cache-Control` for a successful response. */
  cache: string;
  /** Returning null means 404; the route turns that into the standard error body. */
  handler: (ctx: {
    db: Database;
    params: Record<string, unknown>;
    query: Record<string, unknown>;
    request: FastifyRequest;
  }) => Promise<unknown>;
}

/** Field names and rule codes only: never echo the submitted value back (SR-X.10). */
function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

export function registerPublicRoutes(
  app: FastifyInstance,
  db: Database,
  routes: readonly PublicRoute[],
): void {
  for (const route of routes) {
    app.get(route.path, async (request: FastifyRequest, reply: FastifyReply) => {
      const params = route.params?.safeParse(request.params);
      if (params && !params.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
      }
      const query = route.query?.safeParse(request.query);
      if (query && !query.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(query.error) });
      }

      const result = await route.handler({
        db,
        params: (params?.data ?? {}) as Record<string, unknown>,
        query: (query?.data ?? {}) as Record<string, unknown>,
        request,
      });
      if (result === null) return reply.code(404).send({ error: 'not_found' });

      // `Vary: Authorization` because the response to a keyed request carries RateLimit
      // headers a shared cache must not replay to somebody else.
      return reply
        .header('cache-control', route.cache)
        .header('vary', 'Authorization')
        .send(result);
    });
  }
}
