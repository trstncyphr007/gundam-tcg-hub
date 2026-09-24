import { createAuth } from '@gth/auth';
import { seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let app: FastifyInstance;
/** A creator, a second creator, and someone who is only a viewer. */
let creator: string;
let otherCreator: string;
let viewer: string;
const sentLinks: { email: string; url: string }[] = [];

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${String(ipCounter % 250)}`;
}

async function signIn(email: string): Promise<string> {
  const ip = nextIp();
  const before = sentLinks.length;
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: 'http://127.0.0.1:3000', 'x-forwarded-for': ip },
    payload: { email, callbackURL: '/' },
  });
  const link = sentLinks.at(before);
  const url = new URL(String(link?.url));
  const verified = await app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    headers: { 'x-forwarded-for': ip },
  });
  const raw = verified.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('\n') : String(raw);
  const cookie = /gth\.session_token=[^;\s]+/.exec(joined)?.[0];
  expect(cookie, 'sign-in should set a session cookie').toBeDefined();
  return String(cookie);
}

async function save(
  cookie: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/me/profile',
    headers: { cookie },
    payload,
  });
  return { statusCode: res.statusCode, body: res.body };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);

  const auth = createAuth(tdb.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://127.0.0.1:4000', 'http://127.0.0.1:3000'],
    production: false,
    trustProxyHeaders: true,
    passkey: TEST_PASSKEY,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
  });
  app = await buildApp(config, { db: tdb.db, writeDb: tdb.db, auth });

  creator = await signIn('breaker@example.com');
  otherCreator = await signIn('breaker2@example.com');
  viewer = await signIn('viewer@example.com');
  // Creator is an admin-granted role (SR-2.6); there is no self-service path to it, so the
  // test grants it the way an admin would.
  await tdb.db.execute(
    `update app.users set role = 'creator'
      where email in ('breaker@example.com', 'breaker2@example.com')`,
  );
});

afterAll(async () => {
  await app.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(`delete from app.creator_profiles`);
});

describe('the creator’s own profile (FR-4.3)', () => {
  it('requires a session', async () => {
    for (const call of [
      { method: 'GET' as const, url: '/v1/me/profile' },
      { method: 'PUT' as const, url: '/v1/me/profile', payload: {} },
      { method: 'DELETE' as const, url: '/v1/me/profile' },
    ]) {
      expect((await app.inject(call)).statusCode, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('requires the creator role, not merely an account', async () => {
    const res = await save(viewer, { handle: 'viewer', displayName: 'V', published: true });
    expect(res.statusCode).toBe(403);
  });

  it('returns null rather than 404 before one exists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/profile',
      headers: { cookie: creator },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ profile: unknown }>().profile).toBeNull();
  });

  it('saves and reads back', async () => {
    expect(
      (await save(creator, { handle: 'trstn', displayName: 'GUNDAM with TRSTN', published: true }))
        .statusCode,
    ).toBe(200);

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/me/profile',
      headers: { cookie: creator },
    });
    expect(mine.json<{ profile: { handle: string } }>().profile.handle).toBe('trstn');
  });

  it('will not default `published`, because a missing field must never publish anyone', async () => {
    const res = await save(creator, { handle: 'trstn', displayName: 'T' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('published');
  });

  it('rejects an unknown field rather than ignoring it (SR-X.10)', async () => {
    const res = await save(creator, {
      handle: 'trstn',
      displayName: 'T',
      published: true,
      userId: 'somebody-else',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a handle that would shadow a route or read as official', async () => {
    expect(
      (await save(creator, { handle: 'admin', displayName: 'A', published: true })).statusCode,
    ).toBe(409);
  });

  it('reports a taken handle as a conflict, not a server error', async () => {
    await save(creator, { handle: 'trstn', displayName: 'One', published: true });
    const res = await save(otherCreator, { handle: 'trstn', displayName: 'Two', published: true });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('already taken');
  });

  it('deletes', async () => {
    await save(creator, { handle: 'trstn', displayName: 'One', published: true });
    const removed = await app.inject({
      method: 'DELETE',
      url: '/v1/me/profile',
      headers: { cookie: creator },
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: '/v1/me/profile', headers: { cookie: creator } }))
        .statusCode,
    ).toBe(404);
  });
});

describe('the public breaker page (FR-4.3)', () => {
  it('404s an unpublished profile, exactly as it does an unknown one', async () => {
    await save(creator, { handle: 'trstn', displayName: 'T', published: false });
    expect((await app.inject({ method: 'GET', url: '/v1/breakers/trstn' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/breakers/nobody' })).statusCode).toBe(404);
  });

  it('serves a published profile without any authentication', async () => {
    await save(creator, { handle: 'trstn', displayName: 'GUNDAM with TRSTN', published: true });

    const res = await app.inject({ method: 'GET', url: '/v1/breakers/trstn' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ displayName: string; fairness: { badge: string } }>();
    expect(body.displayName).toBe('GUNDAM with TRSTN');
    expect(body.fairness.badge).toBe('none');
  });

  it('names nobody but the creator chose to be named (SR-3.8)', async () => {
    await save(creator, { handle: 'trstn', displayName: 'GUNDAM with TRSTN', published: true });
    const res = await app.inject({ method: 'GET', url: '/v1/breakers/trstn' });
    expect(res.body).not.toContain('breaker@example.com');
  });

  it('lists published profiles and nothing else', async () => {
    await save(creator, { handle: 'shown', displayName: 'Shown', published: true });
    await save(otherCreator, { handle: 'hidden', displayName: 'Hidden', published: false });

    const res = await app.inject({ method: 'GET', url: '/v1/breakers' });
    const handles = res.json<{ items: { handle: string }[] }>().items.map((i) => i.handle);
    // Membership rather than the whole list: the sample seed publishes a placeholder profile
    // of its own, so an exact match would be asserting what the fixture contains instead of
    // what this endpoint does with published and unpublished rows.
    expect(handles).toContain('shown');
    expect(handles).not.toContain('hidden');
  });

  it('rejects a malformed handle at the edge rather than in a query', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/breakers/NOT-A-HANDLE' });
    expect(res.statusCode).toBe(400);
  });

  it('is cross-origin readable, and says so only for the public surface (SR-3.7)', async () => {
    await save(creator, { handle: 'trstn', displayName: 'T', published: true });

    const open = await app.inject({
      method: 'GET',
      url: '/v1/breakers/trstn',
      headers: { origin: 'https://someone-elses-site.invalid' },
    });
    expect(open.headers['access-control-allow-origin']).toBe('*');

    const closed = await app.inject({
      method: 'GET',
      url: '/v1/me/profile',
      headers: { origin: 'https://someone-elses-site.invalid', cookie: creator },
    });
    expect(closed.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('appears in the published OpenAPI document', async () => {
    const spec = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
    const paths = spec.json<{ paths: Record<string, unknown> }>().paths;
    expect(Object.keys(paths)).toContain('/v1/breakers/{handle}');
  });
});
