import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { escapeHtml, renderDocsPage } from './docs.js';
import { buildOpenApiDocument, toTemplatePath } from './openapi.js';
import { publicRoutes } from './routes.js';

const info = {
  title: 'Gundam TCG Hub API',
  version: '1.0.0',
  description: 'Test document.',
  serverUrl: 'https://api.example.test',
  contactUrl: 'https://example.test/about',
  licenceName: 'CC BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
};

const spec = buildOpenApiDocument(publicRoutes, info) as {
  openapi: string;
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  security: unknown[];
};

describe('path templates', () => {
  it.each([
    ['/v1/cards', '/v1/cards'],
    ['/v1/cards/:id', '/v1/cards/{id}'],
    ['/v1/cards/:id/prices', '/v1/cards/{id}/prices'],
  ])('%s becomes %s', (fastify, template) => {
    expect(toTemplatePath(fastify)).toBe(template);
  });
});

describe('the OpenAPI document (FR-3.6)', () => {
  it('is 3.1, which is what makes the schemas plain JSON Schema', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it('describes every registered route, and only those', () => {
    // The document and the router are generated from one list, so this is really asserting
    // that the generator does not drop or invent an endpoint.
    const documented = Object.keys(spec.paths).sort();
    const registered = publicRoutes.map((r) => toTemplatePath(r.path)).sort();
    expect(documented).toEqual(registered);
  });

  it('gives every operation an id, a summary and a tag', () => {
    for (const [path, methods] of Object.entries(spec.paths)) {
      const get = methods['get'] as Record<string, unknown>;
      expect(get['operationId'], path).toBeTruthy();
      expect(get['summary'], path).toBeTruthy();
      expect(get['tags'], path).not.toHaveLength(0);
    }
  });

  it('marks path parameters required, whatever the schema said', () => {
    const params = spec.paths['/v1/cards/{id}']?.['get']?.['parameters'] as {
      name: string;
      in: string;
      required: boolean;
    }[];
    const id = params.find((p) => p.name === 'id');
    expect(id).toMatchObject({ in: 'path', required: true });
  });

  it('documents optional query parameters as optional', () => {
    const params = spec.paths['/v1/cards']?.['get']?.['parameters'] as {
      name: string;
      in: string;
      required: boolean;
    }[];
    expect(params.find((p) => p.name === 'q')).toMatchObject({ in: 'query', required: false });
    expect(params.find((p) => p.name === 'limit')?.required).toBe(false);
  });

  it('carries the parameter descriptions from the schemas, not a second copy of them', () => {
    const params = spec.paths['/v1/cards']?.['get']?.['parameters'] as {
      name: string;
      description?: string;
    }[];
    expect(params.find((p) => p.name === 'cursor')?.description).toContain('nextCursor');
  });

  it('says a key is optional rather than required', () => {
    // Anonymous access is the point: an API you must sign up for is an API nobody tries.
    expect(spec.security).toContainEqual({});
    expect(spec.security).toContainEqual({ apiKey: [] });
    expect(spec.components.securitySchemes['apiKey']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('documents 429 with the headers a client needs to back off', () => {
    const responses = spec.paths['/v1/cards']?.['get']?.['responses'] as Record<
      string,
      { headers?: Record<string, unknown> }
    >;
    expect(Object.keys(responses['429']?.headers ?? {})).toEqual(
      expect.arrayContaining(['RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After']),
    );
  });

  it('inlines response schemas rather than pointing at components that might not exist', () => {
    const content = spec.paths['/v1/cards']?.['get']?.['responses'] as Record<
      string,
      { content: Record<string, { schema: Record<string, unknown> }> }
    >;
    const schema = content['200']?.content['application/json']?.schema;
    expect(schema?.['type']).toBe('object');
    // No stray $schema key: that belongs on a standalone document, not a nested one.
    expect(schema).not.toHaveProperty('$schema');
  });

  it('resolves the one $ref it does use', () => {
    expect(spec.components.schemas['Error']).toBeDefined();
  });

  it('survives JSON round-tripping, which is how it is actually served', () => {
    expect(() => JSON.parse(JSON.stringify(spec)) as unknown).not.toThrow();
  });
});

describe('schema generation from zod', () => {
  it('emits draft 2020-12, the dialect OpenAPI 3.1 uses', () => {
    const json = z.toJSONSchema(z.object({ a: z.string() }), { target: 'draft-2020-12' });
    expect(json).toHaveProperty('type', 'object');
  });

  it('keeps integer cents as integers, not numbers', () => {
    // A price that arrives as a float is a price that cannot be reconciled.
    const prices = spec.paths['/v1/cards/{id}/prices']?.['get']?.['responses'] as Record<
      string,
      { content: Record<string, { schema: Record<string, unknown> }> }
    >;
    const schema = prices['200']?.content['application/json']?.schema as {
      properties: { points: { items: { properties: Record<string, { type: string }> } } };
    };
    expect(schema.properties.points.items.properties['medianCents']?.type).toBe('integer');
  });
});

describe('the docs page', () => {
  const html = renderDocsPage(spec);

  it('loads no script at all, so it needs no exception to our own CSP', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('cdn.');
    expect(html.toLowerCase()).not.toContain('onload=');
  });

  it('lists every documented endpoint', () => {
    for (const route of publicRoutes) {
      expect(html).toContain(toTemplatePath(route.path));
    }
  });

  it('links the machine-readable document', () => {
    expect(html).toContain('/docs/openapi.json');
  });

  it('escapes what it interpolates', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    const hostile = renderDocsPage({
      info: { title: '</title><script>alert(1)</script>', version: '1', description: '' },
      paths: {},
      servers: [],
    });
    expect(hostile).not.toContain('<script>');
  });
});
