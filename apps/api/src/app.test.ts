import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { type ApiConfig, loadConfig } from './config.js';

const baseConfig: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health endpoints', () => {
  it('reports liveness and readiness', async () => {
    app = await buildApp(baseConfig);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    // Without a database wired in (unit context) readiness still answers, and says so.
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', database: 'not_configured' });
  });
});

describe('security headers (SR-X.14)', () => {
  it('sets a locked-down CSP and transport headers', async () => {
    app = await buildApp(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('a path that exists, but not with that method', () => {
  /**
   * 405 rather than 404, under `/v1` only.
   *
   * The published document says which methods each path has, so answering 404 for a method it
   * does not have tells a client the resource is gone when it is not. The nightly fuzzer has
   * failed on this every night since it was added, which is how it was found.
   */
  // The `/v1` routes are only registered when there is a database, and registering them is all
  // this needs: a 405 is decided by the router, so no handler ever runs and nothing is queried.
  const withPublicRoutes = async (): Promise<FastifyInstance> =>
    buildApp(baseConfig, { db: {} as never });

  it('answers 405 with an Allow header on a documented path', async () => {
    app = await withPublicRoutes();
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/v1/games' });
      expect(res.statusCode, method).toBe(405);
      expect(res.headers['allow'], method).toContain('GET');
      expect(res.json()).toEqual({ error: 'method_not_allowed' });
    }
  });

  it('answers 405 on a path with a parameter in it', async () => {
    // The case the first version of this got wrong. Fastify's `hasRoute` compares the URL
    // against registered *patterns*, so `/v1/cards/<a-real-id>` does not match
    // `/v1/cards/:id` and every parameterised route kept answering 404.
    app = await withPublicRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cards/00000000-0000-7000-8000-000000000000/prices',
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toContain('GET');
  });

  it('answers 405 for a body-carrying method Fastify refuses before routing', async () => {
    // QUERY is a method Fastify knows, so it is rejected for a missing content-type *before*
    // routing and never reaches the not-found handler. Left alone, the caller is told their
    // header was wrong when the truth is the method does not exist here.
    app = await withPublicRoutes();
    const res = await app.inject({ method: 'QUERY' as 'GET', url: '/v1/games' });
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toContain('GET');
  });

  it('still answers 404 when the path itself does not exist', async () => {
    app = await withPublicRoutes();
    const res = await app.inject({ method: 'POST', url: '/v1/nothing-here' });
    expect(res.statusCode).toBe(404);
  });

  it('leaves everything outside /v1 answering 404, as it is meant to', async () => {
    // The disabled Better Auth endpoints are meant to look absent rather than forbidden
    // (ADR-026). 405 there would undo that by confirming the path exists.
    app = await withPublicRoutes();
    const res = await app.inject({ method: 'POST', url: '/healthz' });
    expect(res.statusCode).toBe(404);
  });
});

describe('error handling', () => {
  it('returns a JSON 404 for unknown routes', async () => {
    app = await buildApp(baseConfig);
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('hides internal error details', async () => {
    app = await buildApp(baseConfig);
    app.get('/boom', () => {
      throw new Error('db password is hunter2');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    expect(res.body).not.toContain('hunter2');
  });

  it('passes client errors through with their code', async () => {
    app = await buildApp(baseConfig);
    app.post('/echo', { schema: { body: { type: 'object', required: ['name'] } } }, () => 'ok');
    const res = await app.inject({ method: 'POST', url: '/echo', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('FST_ERR_VALIDATION');
  });
});

describe('rate limiting (SR-X.27)', () => {
  it('returns 429 with Retry-After once the limit is hit', async () => {
    app = await buildApp({ ...baseConfig, API_RATE_LIMIT_MAX: 2 });
    app.get('/limited', () => 'ok');
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await app.inject({ method: 'GET', url: '/limited' });
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(last?.headers['retry-after']).toBeDefined();
  });

  it('never rate-limits health checks', async () => {
    app = await buildApp({ ...baseConfig, API_RATE_LIMIT_MAX: 1 });
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('config', () => {
  it('fails fast on invalid env', () => {
    expect(() => loadConfig({ API_PORT: 'not-a-port' })).toThrow(/API_PORT/);
  });

  it('parses trust proxy and limits', () => {
    const config = loadConfig({ API_TRUST_PROXY: 'true', API_RATE_LIMIT_MAX: '10' });
    expect(config.API_TRUST_PROXY).toBe(true);
    expect(config.API_RATE_LIMIT_MAX).toBe(10);
  });
});
