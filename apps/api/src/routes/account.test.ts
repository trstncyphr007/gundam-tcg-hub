import { createAuth } from '@gth/auth';
import { seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';

const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let app: FastifyInstance;

/** Magic links are captured here instead of being emailed. */
const sentLinks: { email: string; url: string }[] = [];

/**
 * Build an app with its own auth instance. The rate limiter keeps per-IP counters in memory,
 * and every injected request shares an IP, so tests that flood it need their own instance.
 */
async function makeApp(): Promise<FastifyInstance> {
  const auth = createAuth(tdb.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://127.0.0.1:4000', 'http://127.0.0.1:3000'],
    production: false,
    // Mirrors the production setup behind Caddy, and lets each test act as its own client IP.
    trustProxyHeaders: true,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
  });
  return buildApp(config, { db: tdb.db, writeDb: tdb.db, auth });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  app = await makeApp();
});

afterAll(async () => {
  await app.close();
  await tdb.close();
});

/** The session cookie from a response, or undefined when none was issued. */
function sessionCookieOf(res: { headers: Record<string, unknown> }): string | undefined {
  const raw = res.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('\n') : typeof raw === 'string' ? raw : '';
  return /gth\.session_token=[^;\s]+/.exec(joined)?.[0];
}

let clientIpCounter = 0;
/** A distinct client IP per caller, so one test's requests never spend another's rate budget. */
function nextClientIp(): string {
  clientIpCounter += 1;
  return `203.0.113.${String(clientIpCounter % 250)}`;
}

/** Complete a magic-link sign-in and return the session cookie plus the raw Set-Cookie header. */
async function signIn(
  email: string,
  target: FastifyInstance = app,
): Promise<{ cookie: string; setCookie: string }> {
  const before = sentLinks.length;
  const ip = nextClientIp();
  const requested = await target.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: 'http://127.0.0.1:3000', 'x-forwarded-for': ip },
    payload: { email, callbackURL: '/' },
  });
  expect(requested.statusCode).toBe(200);

  const link = sentLinks.at(before);
  expect(link, 'a magic link should have been sent').toBeDefined();
  const verifyPath = new URL(link?.url ?? '').pathname + new URL(link?.url ?? '').search;

  const verified = await target.inject({
    method: 'GET',
    url: verifyPath,
    headers: { 'x-forwarded-for': ip },
  });
  expect([200, 302]).toContain(verified.statusCode);

  const raw = verified.headers['set-cookie'];
  const setCookie = Array.isArray(raw) ? raw.join('\n') : String(raw);
  const token = setCookie.match(/(gth\.session_token=[^;]+)/)?.[1];
  expect(token, `session cookie missing in: ${setCookie}`).toBeDefined();
  return { cookie: String(token), setCookie };
}

describe('magic-link sign-in (FR-1.10)', () => {
  it('issues a session and exposes the account at /v1/me', async () => {
    const { cookie } = await signIn('pilot@example.com');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const body = me.json<{ email: string; role: string; displayName: string | null }>();
    expect(body.email).toBe('pilot@example.com');
    expect(body.role).toBe('user');
    expect(me.headers['cache-control']).toBe('no-store');
  });

  it('sets a hardened session cookie (SR-1.7)', async () => {
    const { setCookie } = await signIn('cookie-check@example.com');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
  });

  it('burns the link after one use (SR-X.2)', async () => {
    const email = 'single-use@example.com';
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { 'x-forwarded-for': nextClientIp() },
      payload: { email, callbackURL: '/' },
    });
    const link = sentLinks.at(-1);
    const url = new URL(String(link?.url));
    const path = url.pathname + url.search;

    const first = await app.inject({ method: 'GET', url: path });
    expect([200, 302]).toContain(first.statusCode);
    expect(sessionCookieOf(first)).toBeDefined();

    // Replay: the provider redirects to an error page rather than 4xx; what matters is
    // that no second session is minted.
    const second = await app.inject({ method: 'GET', url: path });
    expect(sessionCookieOf(second), 'replayed link must not create a session').toBeUndefined();
    expect(second.headers.location ?? '').toMatch(/error/i);
  });

  it('rejects a forged or tampered token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/magic-link/verify?token=not-a-real-token&callbackURL=/',
    });
    expect(sessionCookieOf(res), 'forged token must not create a session').toBeUndefined();
    expect(res.headers.location ?? '').toMatch(/error/i);
  });

  it('rate-limits link requests from one client (SR-1.9)', async () => {
    // Own instance + one fixed IP: this is the flood, and it must not spend other tests' budget.
    const isolated = await makeApp();
    const attackerIp = '198.51.100.7';
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const res = await isolated.inject({
          method: 'POST',
          url: '/api/auth/sign-in/magic-link',
          headers: { 'x-forwarded-for': attackerIp },
          payload: { email: `flood${String(i)}@example.com`, callbackURL: '/' },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).toContain(429);
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(5);
    } finally {
      await isolated.close();
    }
  });
});

describe('session enforcement', () => {
  it('rejects anonymous access to account endpoints', async () => {
    for (const url of ['/v1/me', '/v1/admin/ping']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthenticated' });
    }
    const patch = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      payload: { displayName: 'anon' },
    });
    expect(patch.statusCode).toBe(401);
  });

  it('rejects a forged session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: 'gth.session_token=forged.signature' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('invalidates the session on sign-out', async () => {
    const { cookie } = await signIn('bye@example.com');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).statusCode,
    ).toBe(200);

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
    });
    expect(out.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe('profile updates', () => {
  it('updates only the display name', async () => {
    const { cookie } = await signIn('profile@example.com');
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { cookie },
      payload: { displayName: 'TRSTN' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ displayName: string }>().displayName).toBe('TRSTN');
  });

  it('validates the display name', async () => {
    const { cookie } = await signIn('validate@example.com');
    for (const displayName of ['a', 'x'.repeat(41), '<script>', 'bad\u0000name']) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/me',
        headers: { cookie },
        payload: { displayName },
      });
      expect(res.statusCode, `should reject ${JSON.stringify(displayName)}`).toBe(400);
    }
  });

  it('rejects unknown fields, so role cannot ride along (SR-X.9)', async () => {
    const { cookie } = await signIn('escalate@example.com');
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { cookie },
      payload: { displayName: 'Nice Try', role: 'admin' },
    });
    expect(res.statusCode).toBe(400);

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.json<{ role: string }>().role).toBe('user');
  });

  it('ignores role in the auth provider’s own update endpoint', async () => {
    const { cookie } = await signIn('escalate2@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/auth/update-user',
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
      payload: { role: 'admin', name: 'Still Ordinary' },
    });
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.json<{ role: string }>().role).toBe('user');
  });
});

describe('role gating (SR-X.6)', () => {
  it('403s for a non-admin and 200s once promoted', async () => {
    const email = 'promote@example.com';
    const { cookie } = await signIn(email);

    const before = await app.inject({ method: 'GET', url: '/v1/admin/ping', headers: { cookie } });
    expect(before.statusCode).toBe(403);
    expect(before.json()).toEqual({ error: 'forbidden' });

    // Only an operator/admin path can do this; here we simulate it directly in the database.
    await tdb.db.execute(`update app.users set role = 'admin' where email = '${email}'`);

    const after = await app.inject({ method: 'GET', url: '/v1/admin/ping', headers: { cookie } });
    expect(after.statusCode).toBe(200);
  });
});

describe('audit trail (SR-X.21)', () => {
  it('records sign-in events', async () => {
    await signIn('audited@example.com');
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.audit_log where action = 'auth.session.created'`,
    );
    expect(rows[0]?.n ?? 0).toBeGreaterThan(0);
  });
});
