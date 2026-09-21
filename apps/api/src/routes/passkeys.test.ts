import { createAuth } from '@gth/auth';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig, webAuthnProblem } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * Passkey policy through the real auth stack (ADR-025).
 *
 * A full WebAuthn ceremony needs an authenticator, so the ceremonies themselves are exercised
 * end to end in the browser suite with a virtual one. What is tested here is everything this
 * project added around them: what a session records about how it was opened, and the refusals
 * that happen before the plugin ever sees a request.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const ORIGIN = 'http://127.0.0.1:3000';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let member: string;
let memberId: string;
const sentLinks: { email: string; url: string }[] = [];
const notices: { email: string; event: string }[] = [];

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.19.0.${String(ipCounter % 250)}`;
}

async function signIn(email: string): Promise<string> {
  const ip = nextIp();
  const before = sentLinks.length;
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: ORIGIN, 'x-forwarded-for': ip },
    payload: { email, callbackURL: '/' },
  });
  const url = new URL(String(sentLinks.at(before)?.url));
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

/** WebAuthn authenticator data: RP ID hash (32), flags (1), counter (4). */
function authenticatorData(flags: number): string {
  const bytes = new Uint8Array(37);
  bytes.fill(0xab, 0, 32);
  bytes[32] = flags;
  return Buffer.from(bytes).toString('base64url');
}

function assertionBody(flags: number): Record<string, unknown> {
  return {
    response: {
      id: 'credential-id',
      rawId: 'credential-id',
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        authenticatorData: authenticatorData(flags),
        clientDataJSON: Buffer.from('{}').toString('base64url'),
        signature: Buffer.from('not-a-signature').toString('base64url'),
      },
    },
  };
}

async function sessionRow(userId: string): Promise<{ auth_method: string | null } | undefined> {
  const rows = await tdb.db.execute<{ auth_method: string | null }>(
    `select auth_method from app.sessions where user_id = '${userId}' order by created_at desc limit 1`,
  );
  return rows[0];
}

async function givePasskey(userId: string): Promise<void> {
  await tdb.db.execute(`
    insert into app.passkeys (id, name, public_key, user_id, credential_id, counter, device_type, backed_up)
    values ('pk-${userId}', 'Test key', 'public-key', '${userId}', 'cred-${userId}', 0, 'singleDevice', false)
    on conflict do nothing
  `);
}

function error(res: LightMyRequestResponse): string {
  return String(res.json<{ code?: string }>().code);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });

  const auth = createAuth(tdb.db, {
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
  app = await buildApp(config, { db: tdb.db, writeDb: webPool.db, auth });

  member = await signIn('passkey-member@example.com');
  const ids = await tdb.db.execute<{ id: string }>(
    `select id from app.users where email = 'passkey-member@example.com'`,
  );
  memberId = String(ids[0]?.id);
});

afterAll(async () => {
  await app.close();
  await webPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(`delete from app.passkeys`);
  await tdb.db.execute(
    `update app.sessions set created_at = now(), auth_method = 'magic_link' where user_id = '${memberId}'`,
  );
});

/** Pretend the member's session was opened with a passkey. */
async function openedWithPasskey(): Promise<void> {
  await tdb.db.execute(
    `update app.sessions set auth_method = 'passkey' where user_id = '${memberId}'`,
  );
}

describe('how a session was opened (ADR-025)', () => {
  it('records a magic-link sign-in as magic_link', async () => {
    // Set by the server from the endpoint that created the session, never by the client.
    expect((await sessionRow(memberId))?.auth_method).toBe('magic_link');
  });

  it('refuses any value outside the known methods, at the database', async () => {
    let caught: unknown;
    try {
      await tdb.db.execute(
        `update app.sessions set auth_method = 'admin' where user_id = '${memberId}'`,
      );
    } catch (e) {
      caught = e;
    }
    const messages: string[] = [];
    for (let e: unknown = caught; e instanceof Error; e = e.cause) messages.push(e.message);
    expect(messages.join(' | ')).toMatch(/sessions_auth_method_known/);
  });
});

describe('user verification is required, not merely requested (SR-1.10)', () => {
  it('refuses a sign-in assertion without the UV flag, before the plugin sees it', async () => {
    // Present (UP) but not verified — a tap with no PIN or biometric. One factor.
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/verify-authentication',
      headers: { origin: ORIGIN },
      payload: assertionBody(0x01),
    });
    expect(res.statusCode).toBe(400);
    expect(error(res)).toBe('USER_VERIFICATION_REQUIRED');
  });

  it('refuses an assertion with no user presence at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/verify-authentication',
      headers: { origin: ORIGIN },
      payload: assertionBody(0x04),
    });
    expect(error(res)).toBe('USER_PRESENCE_REQUIRED');
  });

  it('lets a verified assertion through to the plugin, which then checks the signature', async () => {
    // UP|UV passes the policy — and is still refused, by the plugin, because there is no
    // real credential or challenge behind it. The policy only ever says "no" early.
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/verify-authentication',
      headers: { origin: ORIGIN },
      payload: assertionBody(0x05),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(error(res)).not.toBe('USER_VERIFICATION_REQUIRED');
  });

  it('refuses a malformed authenticatorData instead of guessing', async () => {
    const body = assertionBody(0x05);
    (
      body as { response: { response: { authenticatorData: string } } }
    ).response.response.authenticatorData = 'not base64url!!';
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/verify-authentication',
      headers: { origin: ORIGIN },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(error(res)).toBe('MALFORMED_CREDENTIAL');
  });
});

describe('who may add a passkey (ADR-025)', () => {
  it('lets a fresh email sign-in start registering the first one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/passkey/generate-register-options',
      headers: { cookie: member, origin: ORIGIN },
    });
    expect(res.statusCode, res.body).toBe(200);
    // And asks the browser for verification rather than settling for presence.
    expect(
      res.json<{ authenticatorSelection: { userVerification: string } }>().authenticatorSelection
        .userVerification,
    ).toBe('required');
  });

  it('refuses a second passkey to a session that was not opened with a passkey', async () => {
    await givePasskey(memberId);
    // Whoever can read the inbox can get this session. They must not be able to add their
    // own passkey and pass the admin gate as the owner.
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/passkey/generate-register-options',
      headers: { cookie: member, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(403);
    expect(error(res)).toBe('PASSKEY_SESSION_REQUIRED');
  });

  it('allows it from a session opened with a passkey', async () => {
    await givePasskey(memberId);
    await openedWithPasskey();
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/passkey/generate-register-options',
      headers: { cookie: member, origin: ORIGIN },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses registration to a session older than ten minutes', async () => {
    await tdb.db.execute(
      `update app.sessions set created_at = now() - interval '11 minutes' where user_id = '${memberId}'`,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/passkey/generate-register-options',
      headers: { cookie: member, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('removing a passkey (ADR-025)', () => {
  it('is refused to a session opened by email, however fresh', async () => {
    // Otherwise the inbox alone is enough: delete the owner's only passkey, which reopens the
    // "first passkey by email" path, enrol your own, and pass the admin gate as the owner.
    await givePasskey(memberId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/delete-passkey',
      headers: { cookie: member, origin: ORIGIN },
      payload: { id: `pk-${memberId}` },
    });
    expect(res.statusCode).toBe(403);
    expect(error(res)).toBe('PASSKEY_SESSION_REQUIRED');
    const [left] = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.passkeys where user_id = '${memberId}'`,
    );
    expect(left?.n).toBe(1);
  });

  it('needs a fresh passkey sign-in, not merely a passkey sign-in', async () => {
    await givePasskey(memberId);
    await openedWithPasskey();
    await tdb.db.execute(
      `update app.sessions set created_at = now() - interval '11 minutes' where user_id = '${memberId}'`,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/delete-passkey',
      headers: { cookie: member, origin: ORIGIN },
      payload: { id: `pk-${memberId}` },
    });
    expect(res.statusCode).toBe(403);
    expect(error(res)).toBe('SESSION_NOT_FRESH');
  });

  it('removes it from a fresh passkey session, and tells the owner', async () => {
    await givePasskey(memberId);
    await openedWithPasskey();
    const before = notices.length;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/delete-passkey',
      headers: { cookie: member, origin: ORIGIN },
      payload: { id: `pk-${memberId}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(notices.slice(before)).toEqual([
      { email: 'passkey-member@example.com', event: 'passkey_removed' },
    ]);

    const [audit] = await tdb.db.execute<{ action: string; actor_id: string }>(
      `select action, actor_id from app.audit_log where action = 'auth.passkey_removed' order by at desc limit 1`,
    );
    expect(audit).toMatchObject({ action: 'auth.passkey_removed', actor_id: memberId });
  });

  it('says nothing to anyone about a refused removal', async () => {
    await givePasskey(memberId);
    await tdb.db.execute(
      `update app.sessions set created_at = now() - interval '11 minutes' where user_id = '${memberId}'`,
    );
    const before = notices.length;
    await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/delete-passkey',
      headers: { cookie: member, origin: ORIGIN },
      payload: { id: `pk-${memberId}` },
    });
    expect(notices.length).toBe(before);
  });
});

describe('who may touch the credentials table (migration 0029)', () => {
  it('keeps the worker out entirely', async () => {
    await givePasskey(memberId);
    let caught: unknown;
    try {
      await workerPool.db.execute(`select * from app.passkeys`);
    } catch (e) {
      caught = e;
    }
    const messages: string[] = [];
    for (let e: unknown = caught; e instanceof Error; e = e.cause) messages.push(e.message);
    expect(messages.join(' | ')).toMatch(/permission denied/i);
  });

  it('lets the web role advance a counter but never rewrite a public key', async () => {
    await givePasskey(memberId);
    await webPool.db.execute(`update app.passkeys set counter = 5 where user_id = '${memberId}'`);

    let caught: unknown;
    try {
      await webPool.db.execute(
        `update app.passkeys set public_key = 'swapped' where user_id = '${memberId}'`,
      );
    } catch (e) {
      caught = e;
    }
    const messages: string[] = [];
    for (let e: unknown = caught; e instanceof Error; e = e.cause) messages.push(e.message);
    // A changed key is a new credential, and has to be registered as one.
    expect(messages.join(' | ')).toMatch(/permission denied/i);
  });
});

describe('relying-party configuration (ADR-025)', () => {
  it('accepts the development defaults', () => {
    expect(
      webAuthnProblem({ WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: 'http://localhost:3000' }),
    ).toBeNull();
  });

  it('accepts a site on a subdomain of the RP ID', () => {
    expect(
      webAuthnProblem({
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ORIGIN: 'https://app.example.com',
      }),
    ).toBeNull();
  });

  it('refuses an IP address, which browsers reject silently at sign-in time', () => {
    expect(
      webAuthnProblem({ WEBAUTHN_RP_ID: '127.0.0.1', WEBAUTHN_ORIGIN: 'http://127.0.0.1:3000' }),
    ).toMatch(/IP address/);
  });

  it('refuses an origin on a different domain, including a lookalike', () => {
    expect(
      webAuthnProblem({
        WEBAUTHN_RP_ID: 'example.com',
        WEBAUTHN_ORIGIN: 'https://evil-example.com',
      }),
    ).toMatch(/subdomain/);
  });

  it('refuses to boot on a relying party that could never work', () => {
    expect(() =>
      loadConfig({
        LOG_LEVEL: 'silent',
        NODE_ENV: 'test',
        WEBAUTHN_RP_ID: '127.0.0.1',
        WEBAUTHN_ORIGIN: 'http://127.0.0.1:3000',
      }),
    ).toThrow(/refusing to start: WEBAUTHN_RP_ID/);
  });

  it('boots a production build on localhost, the way CI runs it', () => {
    // A `localhost` relying party on a real domain fails closed — browsers refuse it — so it
    // is not treated like a leaked secret. CI depends on this.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        LOG_LEVEL: 'silent',
        TOKEN_PEPPER: 'p'.repeat(40),
        BETTER_AUTH_SECRET: 's'.repeat(40),
        DATA_ENCRYPTION_KEYS: `{"k1":"${Buffer.alloc(32, 1).toString('base64')}"}`,
        DATA_ENCRYPTION_ACTIVE_KID: 'k1',
      }),
    ).not.toThrow();
  });
});
