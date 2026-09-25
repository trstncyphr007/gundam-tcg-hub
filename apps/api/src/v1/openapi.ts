import { z } from 'zod';
import type { PublicRoute } from './registry.js';
import { errorSchema } from './schemas.js';

/**
 * Build the OpenAPI 3.1 document from the route registry (FR-3.6).
 *
 * **Deviation from the plan, taken on purpose.** §5 names `@fastify/swagger` plus
 * `fastify-type-provider-zod`. Neither is used, for three reasons:
 *
 *  1. zod 4 emits JSON Schema draft 2020-12 natively, and that dialect *is* OpenAPI 3.1's
 *     schema language. The conversion those packages exist to perform is now in the library
 *     we already depend on.
 *  2. A hosted docs viewer (Swagger UI, Scalar) loads third-party script from a CDN, which
 *     our own CSP forbids (SR-X.16). Vendoring one would mean shipping and patching a large
 *     bundle for a documentation page.
 *  3. Two fewer dependencies on the path that authenticates and serves everything (SG3).
 *
 * The cost is this file: roughly a hundred lines that must track the OpenAPI object shape.
 * It is covered by tests that parse the output, and the trigger to revisit is a real need
 * for request-body schemas across many methods — today every public route is a GET.
 */

export interface OpenApiInfo {
  title: string;
  version: string;
  description: string;
  serverUrl: string;
  contactUrl: string;
  licenceName: string;
  licenceUrl: string;
}

interface JsonSchema {
  [key: string]: unknown;
}

function toJson(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io }) as JsonSchema;
  // $schema belongs on a standalone document, not on a component inside another one.
  delete json['$schema'];
  return json;
}

/** `/v1/cards/:id` → `/v1/cards/{id}`, which is what OpenAPI expects. */
export function toTemplatePath(fastifyPath: string): string {
  return fastifyPath.replaceAll(/:([A-Za-z0-9_]+)/gu, '{$1}');
}

function parameters(route: PublicRoute): unknown[] {
  const out: unknown[] = [];

  for (const [location, schema] of [
    ['path', route.params],
    ['query', route.query],
  ] as const) {
    if (!schema) continue;
    const json = toJson(schema, 'input');
    const properties = (json['properties'] ?? {}) as Record<string, JsonSchema>;
    const required = new Set((json['required'] as string[] | undefined) ?? []);

    for (const [name, property] of Object.entries(properties)) {
      const { description, ...rest } = property;
      out.push({
        name,
        in: location,
        // A path parameter is always required, whatever the schema says.
        required: location === 'path' || required.has(name),
        ...(typeof description === 'string' ? { description } : {}),
        schema: rest,
      });
    }
  }

  return out;
}

const errorResponse = {
  description: 'Something was wrong with the request, or the thing asked for is not here.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

export function buildOpenApiDocument(
  routes: readonly PublicRoute[],
  info: OpenApiInfo,
): Record<string, unknown> {
  // fromEntries rather than assigning by computed key: the linter is right that a dynamic
  // property write is a sink, and building the object once is clearer anyway.
  const paths = Object.fromEntries(
    routes.map((route) => [
      toTemplatePath(route.path),
      {
        get: {
          operationId: route.operationId,
          summary: route.summary,
          description: route.description,
          tags: route.tags,
          parameters: parameters(route),
          security: [{}, { apiKey: [] }],
          responses: {
            '200': {
              description: 'OK',
              headers: {
                'Cache-Control': { schema: { type: 'string' }, description: route.cache },
                ETag: { schema: { type: 'string' } },
              },
              content: { 'application/json': { schema: toJson(route.response, 'output') } },
            },
            '400': errorResponse,
            '404': errorResponse,
            '429': {
              description:
                'Rate limited. `RateLimit-Reset` and `Retry-After` say how long to wait.',
              headers: {
                'RateLimit-Limit': { schema: { type: 'integer' } },
                'RateLimit-Remaining': { schema: { type: 'integer' } },
                'RateLimit-Reset': { schema: { type: 'integer' }, description: 'Seconds.' },
                'Retry-After': { schema: { type: 'integer' }, description: 'Seconds.' },
              },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        },
      },
    ]),
  );

  return {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      description: info.description,
      contact: { url: info.contactUrl },
      license: { name: info.licenceName, url: info.licenceUrl },
    },
    servers: [{ url: info.serverUrl }],
    paths,
    components: {
      schemas: { Error: toJson(errorSchema, 'output') },
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A key from /account/developer, sent as `Authorization: Bearer gth_live_…`. ' +
            'Optional: without one you share an allowance with everyone at your address.',
        },
      },
    },
    // Anonymous is allowed, so the default is "no security"; a key raises the allowance.
    security: [{}, { apiKey: [] }],
    tags: [
      { name: 'catalog', description: 'Games, sets, cards and sealed products.' },
      { name: 'prices', description: 'The published price index.' },
      { name: 'marketplace', description: 'What is for sale, and by whom it is trusted.' },
      // Undeclared until now, which made the generated document name a tag it never described.
      { name: 'breakers', description: 'Public breaker profiles and their verified breaks.' },
    ],
  };
}
