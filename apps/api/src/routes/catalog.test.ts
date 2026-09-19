import { seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';

const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  app = await buildApp(config, { db: tdb.db });
});

afterAll(async () => {
  await app.close();
  await tdb.close();
});

describe('GET /readyz', () => {
  it('reports database health', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', database: 'ok' });
  });
});

describe('catalog endpoints', () => {
  it('lists games', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/games' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: { slug: string }[] }>().items[0]?.slug).toBe('gundam');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers.etag).toBeDefined();
  });

  it('answers a conditional GET with 304', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/games' });
    const second = await app.inject({
      method: 'GET',
      url: '/v1/games',
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    expect(second.statusCode).toBe(304);
  });

  it('lists sets filtered by game', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/sets?game=gundam' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: { code: string }[] }>().items[0]?.code).toBe('SAMPLE-01');
  });

  it('searches cards and paginates', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/cards?q=pilot' });
    expect(res.json<{ items: { name: string }[] }>().items).toHaveLength(1);

    const page = await app.inject({ method: 'GET', url: '/v1/cards?limit=2' });
    const body = page.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();
  });

  it('returns one card with its variants', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/cards?q=Alpha' });
    const id = list.json<{ items: { id: string }[] }>().items[0]?.id;
    const res = await app.inject({ method: 'GET', url: `/v1/cards/${String(id)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ variants: unknown[] }>().variants).toHaveLength(2);
  });

  it('404s for an unknown card', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/cards/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('lists sealed products', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/products?game=gundam' });
    expect(res.json<{ items: { kind: string }[] }>().items[0]?.kind).toBe('booster_box');
  });
});

describe('input validation (SR-X.10)', () => {
  const badRequests = [
    ['malformed uuid path', '/v1/cards/not-a-uuid'],
    ['malformed cursor', '/v1/cards?cursor=nope'],
    ['limit above the cap', '/v1/cards?limit=1000'],
    ['limit below the floor', '/v1/cards?limit=0'],
    ['non-numeric limit', '/v1/cards?limit=abc'],
    ['unknown parameter', '/v1/cards?admin=true'],
    ['bad game slug', '/v1/sets?game=Robert%27);DROP%20TABLE'],
    ['oversized query', `/v1/cards?q=${'x'.repeat(200)}`],
  ] as const;

  it.each(badRequests)('rejects %s', async (_label, url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_request');
  });

  it('does not echo the offending value back', async () => {
    const secret = 'super-secret-value-123';
    const res = await app.inject({ method: 'GET', url: `/v1/cards?cursor=${secret}` });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(secret);
  });

  it('treats sql metacharacters in q as data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/cards?q=${encodeURIComponent("'; drop table app.cards; --")}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);

    const still = await app.inject({ method: 'GET', url: '/v1/cards' });
    expect(still.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);
  });
});
