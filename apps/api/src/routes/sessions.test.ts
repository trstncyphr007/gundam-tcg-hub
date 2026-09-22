import { type SecurityNotice, createAuth } from '@gth/auth';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { noticeText } from '../mailer.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * Seeing and ending your own sessions, and hearing about new devices (§16.2, SR-X.5, ADR-026).
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const ORIGIN = 'http://127.0.0.1:3000';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
const sentLinks: { email: string; url: string }[] = [];
const notices: SecurityNotice[] = [];

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.18.7.${String(ipCounter % 250)}`;
}

let emailCounter = 0;
function freshEmail(): string {
  emailCounter += 1;
  return `sessions-${String(emailCounter)}@example.com`;
}

/** A full magic-link sign-in from a given browser; returns the session cookie. */
async function signIn(email: string, userAgent = CHROME_WINDOWS): Promise<string> {
  const ip = nextIp();
  const before = sentLinks.length;
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: ORIGIN, 'x-forwarded-for': ip, 'user-agent': userAgent },
    payload: { email, callbackURL: '/' },
  });
  const url = new URL(String(sentLinks.at(before)?.url));
  const verified = await app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    headers: { 'x-forwarded-for': ip, 'user-agent': userAgent },
  });
  const raw = verified.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('\n') : String(raw);
  const cookie = /gth\.session_token=[^;\s]+/.exec(joined)?.[0];
  expect(cookie, 'sign-in should set a session cookie').toBeDefined();
  return String(cookie);
}

async function userIdOf(email: string): Promise<string> {
  const rows = await tdb.db.execute<{ id: string }>(
    `select id from app.users where email = '${email}'`,
  );
  return String(rows[0]?.id);
}

/** The newest session's id for an account — i.e. the one the last `signIn` opened. */
async function newestSessionId(userId: string): Promise<string> {
  const rows = await tdb.db.execute<{ id: string }>(
    `select id from app.sessions where user_id = '${userId}' order by created_at desc limit 1`,
  );
  return String(rows[0]?.id);
}

async function sessionCount(userId: string): Promise<number> {
  const rows = await tdb.db.execute<{ n: number }>(
    `select count(*)::int as n from app.sessions where user_id = '${userId}'`,
  );
  return Number(rows[0]?.n);
}

async function markPasskey(sessionId: string): Promise<void> {
  await tdb.db.execute(`update app.sessions set auth_method = 'passkey' where id = '${sessionId}'`);
}

async function stillSignedIn(cookie: string): Promise<boolean> {
  const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
  return res.statusCode === 200;
}

interface ListedSession {
  id: string;
  device: string;
  method: string | null;
  signedInAt: string;
  current: boolean;
}

async function list(cookie: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: '/v1/account/sessions', headers: { cookie } });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });

  const auth = createAuth(webPool.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://127.0.0.1:4000', ORIGIN],
    production: false,
    trustProxyHeaders: true,
    passkey: TEST_PASSKEY,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
    sendSecurityNotice: (notice) => {
      notices.push(notice);
      return Promise.resolve();
    },
  });
  // The web pool, as in production: every write below goes through the grants in 0031.
  app = await buildApp(config, { db: tdb.db, writeDb: webPool.db, auth });
});

afterAll(async () => {
  await app.close();
  await webPool.close();
  await tdb.close();
});

beforeEach(() => {
  notices.length = 0;
});

describe("Better Auth's own session endpoints are gone (ADR-026)", () => {
  it.each([
    ['GET', '/api/auth/list-sessions'],
    ['POST', '/api/auth/revoke-session'],
    ['POST', '/api/auth/revoke-sessions'],
    ['POST', '/api/auth/revoke-other-sessions'],
  ] as const)('%s %s answers 404, even to a fresh session', async (method, url) => {
    const email = freshEmail();
    const other = await signIn(email);
    const cookie = await signIn(email);
    const userId = await userIdOf(email);

    const res = await app.inject({
      method,
      url,
      headers: { cookie, origin: ORIGIN },
      ...(method === 'POST' ? { payload: {} } : {}),
    });
    expect(res.statusCode).toBe(404);
    // And nothing was listed or ended by it.
    expect(res.body).not.toMatch(/token/i);
    expect(await sessionCount(userId)).toBe(2);
    expect(await stillSignedIn(other)).toBe(true);
  });
});

describe('what a leaked session token is worth', () => {
  it('a bare token opens nothing — neither as a cookie nor as a bearer token', async () => {
    // Why the leak above was serious but not yet catastrophic: the cookie is the token *plus*
    // an HMAC under the server secret, and no bearer plugin is enabled. This pins both, so
    // enabling one later fails here instead of silently making every leaked token a login.
    const email = freshEmail();
    const cookie = await signIn(email);
    const [row] = await tdb.db.execute<{ token: string }>(
      `select token from app.sessions where user_id = '${await userIdOf(email)}'`,
    );
    const token = String(row?.token);
    expect(cookie).not.toBe(`gth.session_token=${token}`);

    for (const headers of [
      { cookie: `gth.session_token=${token}` },
      { authorization: `Bearer ${token}` },
    ]) {
      const res = await app.inject({ method: 'GET', url: '/v1/me', headers });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('listing your sessions', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/account/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('shows each session by device and method, and which one is this', async () => {
    const email = freshEmail();
    await signIn(email, FIREFOX_LINUX);
    const cookie = await signIn(email, CHROME_WINDOWS);

    const res = await list(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { sessions } = res.json<{ sessions: ListedSession[] }>();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.device).sort()).toEqual(['Chrome on Windows', 'Firefox on Linux']);
    expect(sessions.every((s) => s.method === 'magic_link')).toBe(true);
    const current = sessions.filter((s) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0]?.device).toBe('Chrome on Windows');
  });

  it('gives out nothing that could open a session: no token, no raw user agent, no IP', async () => {
    const email = freshEmail();
    const cookie = await signIn(email, CHROME_WINDOWS);
    const userId = await userIdOf(email);
    const [row] = await tdb.db.execute<{ token: string; ip_address: string | null }>(
      `select token, ip_address from app.sessions where user_id = '${userId}'`,
    );

    const body = (await list(cookie)).body;
    expect(body).not.toContain(String(row?.token));
    expect(body).not.toMatch(/token/i);
    expect(body).not.toContain('Mozilla/5.0');
    if (row?.ip_address) expect(body).not.toContain(row.ip_address);
  });

  it("never shows another account's sessions", async () => {
    const mine = await signIn(freshEmail());
    const theirEmail = freshEmail();
    await signIn(theirEmail);
    const theirs = await newestSessionId(await userIdOf(theirEmail));

    const { sessions } = (await list(mine)).json<{ sessions: ListedSession[] }>();
    expect(sessions.map((s) => s.id)).not.toContain(theirs);
    expect(sessions).toHaveLength(1);
  });
});

describe('ending one session', () => {
  it('ends another session of yours, which is signed out at once, and audits it', async () => {
    const email = freshEmail();
    const other = await signIn(email, FIREFOX_LINUX);
    const userId = await userIdOf(email);
    const otherId = await newestSessionId(userId);
    const cookie = await signIn(email, CHROME_WINDOWS);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/account/sessions/${otherId}/revoke`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(204);
    expect(await stillSignedIn(other)).toBe(false);
    expect(await stillSignedIn(cookie)).toBe(true);

    const [audit] = await tdb.db.execute<{ actor_id: string; diff: { count: number } }>(
      `select actor_id, diff from app.audit_log
        where action = 'auth.session_revoked' and target_id = '${userId}'`,
    );
    expect(audit).toMatchObject({ actor_id: userId, diff: { count: 1 } });
  });

  it("answers 404 for another account's session, and leaves it alone", async () => {
    const mine = await signIn(freshEmail());
    const theirEmail = freshEmail();
    const theirCookie = await signIn(theirEmail);
    const theirs = await newestSessionId(await userIdOf(theirEmail));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/account/sessions/${theirs}/revoke`,
      headers: { cookie: mine },
    });
    expect(res.statusCode).toBe(404);
    expect(await stillSignedIn(theirCookie)).toBe(true);
  });

  it('answers the same 404 for an id that does not exist, or is not an id at all', async () => {
    const cookie = await signIn(freshEmail());
    for (const id of ['doesnotexist123', "x'%20or%201=1--", '..%2F..%2Fetc']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/account/sessions/${id}/revoke`,
        headers: { cookie },
      });
      expect(res.statusCode, id).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('will not let an email session end a passkey session', async () => {
    // Otherwise whoever holds the inbox could keep signing the owner out of the console.
    const email = freshEmail();
    const passkeyCookie = await signIn(email, SAFARI_IPHONE);
    const userId = await userIdOf(email);
    const passkeyId = await newestSessionId(userId);
    await markPasskey(passkeyId);
    const emailCookie = await signIn(email, CHROME_WINDOWS);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/account/sessions/${passkeyId}/revoke`,
      headers: { cookie: emailCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'passkey_session_required' });
    expect(await stillSignedIn(passkeyCookie)).toBe(true);
  });

  it('lets a passkey session end any session, passkey ones included', async () => {
    const email = freshEmail();
    const firstCookie = await signIn(email, SAFARI_IPHONE);
    const userId = await userIdOf(email);
    const firstId = await newestSessionId(userId);
    await markPasskey(firstId);
    const currentCookie = await signIn(email, CHROME_WINDOWS);
    await markPasskey(await newestSessionId(userId));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/account/sessions/${firstId}/revoke`,
      headers: { cookie: currentCookie },
    });
    expect(res.statusCode, res.body).toBe(204);
    expect(await stillSignedIn(firstCookie)).toBe(false);
  });
});

describe('signing out everywhere else', () => {
  it('from an email session: ends the others, keeps passkey sessions, and says so', async () => {
    const email = freshEmail();
    const passkeyCookie = await signIn(email, SAFARI_IPHONE);
    const userId = await userIdOf(email);
    await markPasskey(await newestSessionId(userId));
    const otherEmail = await signIn(email, FIREFOX_LINUX);
    const cookie = await signIn(email, CHROME_WINDOWS);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/sessions/revoke-others',
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ revoked: 1, keptPasskeySessions: 1 });
    expect(await stillSignedIn(otherEmail)).toBe(false);
    expect(await stillSignedIn(passkeyCookie)).toBe(true);
    expect(await stillSignedIn(cookie)).toBe(true);
  });

  it('ends sessions from before ADR-025 too, whose method is unknown', async () => {
    const email = freshEmail();
    const legacy = await signIn(email, FIREFOX_LINUX);
    const userId = await userIdOf(email);
    await tdb.db.execute(
      `update app.sessions set auth_method = null where id = '${await newestSessionId(userId)}'`,
    );
    const cookie = await signIn(email, CHROME_WINDOWS);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/sessions/revoke-others',
      headers: { cookie },
    });
    expect(res.json()).toEqual({ revoked: 1, keptPasskeySessions: 0 });
    expect(await stillSignedIn(legacy)).toBe(false);
  });

  it('from a passkey session: ends every other session', async () => {
    const email = freshEmail();
    const passkeyCookie = await signIn(email, SAFARI_IPHONE);
    const userId = await userIdOf(email);
    await markPasskey(await newestSessionId(userId));
    const cookie = await signIn(email, CHROME_WINDOWS);
    await markPasskey(await newestSessionId(userId));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/account/sessions/revoke-others',
      headers: { cookie },
    });
    expect(res.json()).toEqual({ revoked: 1, keptPasskeySessions: 0 });
    expect(await stillSignedIn(passkeyCookie)).toBe(false);
    expect(await stillSignedIn(cookie)).toBe(true);
    expect(await sessionCount(userId)).toBe(1);
  });
});

describe('a sign-in from a new device (SR-X.5)', () => {
  it("says nothing about an account's first device, or about one it already knows", async () => {
    const email = freshEmail();
    await signIn(email, CHROME_WINDOWS);
    await signIn(email, CHROME_WINDOWS);
    // A browser update is not a new device.
    await signIn(email, CHROME_WINDOWS.replace('140.0.0.0', '141.0.7390.54'));
    expect(notices).toEqual([]);
  });

  it('tells the owner about a device the account has not used before', async () => {
    const email = freshEmail();
    await signIn(email, CHROME_WINDOWS);
    await signIn(email, FIREFOX_LINUX);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      email,
      event: 'new_sign_in',
      device: 'Firefox on Linux',
      method: 'magic_link',
    });

    // Once only: the second sign-in from it is from a known device.
    await signIn(email, FIREFOX_LINUX);
    expect(notices).toHaveLength(1);
  });

  it('does not put the raw user agent in front of anyone', async () => {
    const email = freshEmail();
    await signIn(email, CHROME_WINDOWS);
    await signIn(email, 'Firefox/1.0 <a href="https://evil.test">click here</a>');

    const notice = notices[0];
    expect(notice).toBeDefined();
    if (notice?.event !== 'new_sign_in') throw new Error('expected a new_sign_in notice');
    expect(notice.device).toBe('Firefox');
    const { body } = noticeText(notice);
    expect(body).not.toContain('evil.test');
    expect(body).not.toContain('<');
  });

  it('still signs the person in when the notice cannot be sent', async () => {
    const failing = createAuth(webPool.db, {
      baseURL: 'http://127.0.0.1:4000',
      secret: 'test-secret-at-least-32-characters-long',
      trustedOrigins: ['http://127.0.0.1:4000', ORIGIN],
      production: false,
      trustProxyHeaders: true,
      passkey: TEST_PASSKEY,
      sendMagicLink: ({ email, url }) => {
        sentLinks.push({ email, url });
        return Promise.resolve();
      },
      sendSecurityNotice: () => Promise.reject(new Error('smtp down')),
    });
    const brokenMail = await buildApp(config, { db: tdb.db, writeDb: webPool.db, auth: failing });
    try {
      const email = freshEmail();
      const saved = app;
      app = brokenMail;
      try {
        await signIn(email, CHROME_WINDOWS);
        const cookie = await signIn(email, FIREFOX_LINUX);
        expect(await stillSignedIn(cookie)).toBe(true);
      } finally {
        app = saved;
      }
    } finally {
      await brokenMail.close();
    }
  });
});

describe('who may touch the device history (migration 0031)', () => {
  it('lets the web role add a device and bump it, but never delete or rename one', async () => {
    const email = freshEmail();
    await signIn(email, CHROME_WINDOWS);
    const userId = await userIdOf(email);

    async function asWeb(statement: string): Promise<string | null> {
      try {
        await webPool.db.transaction(async (tx) => {
          await tx.execute(`select set_config('app.user_id', '${userId}', true)`);
          await tx.execute(statement);
        });
        return null;
      } catch (e) {
        const messages: string[] = [];
        for (let c: unknown = e; c instanceof Error; c = c.cause) messages.push(c.message);
        return messages.join(' | ');
      }
    }

    expect(
      await asWeb(
        `update app.sign_in_devices set last_seen_at = now() where user_id = '${userId}'`,
      ),
    ).toBeNull();
    expect(await asWeb(`delete from app.sign_in_devices where user_id = '${userId}'`)).toMatch(
      /permission denied/i,
    );
    expect(
      await asWeb(`update app.sign_in_devices set device = 'x' where user_id = '${userId}'`),
    ).toMatch(/permission denied/i);
  });

  it("will not record a device against someone else's account", async () => {
    const mine = freshEmail();
    await signIn(mine);
    const theirs = freshEmail();
    await signIn(theirs);
    const myId = await userIdOf(mine);
    const theirId = await userIdOf(theirs);

    let caught: unknown;
    try {
      await webPool.db.transaction(async (tx) => {
        await tx.execute(`select set_config('app.user_id', '${myId}', true)`);
        await tx.execute(
          `insert into app.sign_in_devices (user_id, device) values ('${theirId}', 'Planted')`,
        );
      });
    } catch (e) {
      caught = e;
    }
    // Pre-seeding a victim's history is exactly how someone would silence the notice.
    expect(caught).toBeDefined();
    // Counted *as the victim*: the table is FORCE'd, so an undeclared count sees nothing
    // either way and would prove nothing.
    const planted = await tdb.db.transaction(async (tx) => {
      await tx.execute(`select set_config('app.user_id', '${theirId}', true)`);
      return tx.execute<{ n: number }>(
        `select count(*)::int as n from app.sign_in_devices where device = 'Planted'`,
      );
    });
    expect(planted[0]?.n).toBe(0);
  });
});
