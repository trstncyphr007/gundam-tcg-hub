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

    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
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
