import { createAuth } from '@gth/auth';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * "Does this address have an account here?" must not be a question this service answers
 * (SR-X.4, ASVS 6.3).
 *
 * The checklist has said **Met** for this since it was written, with the evidence "identical
 * response whether or not the address has an account". Every other row in that file cites a
 * test. This one cited a behaviour, and the only thing standing behind it was a branch in
 * `sign-in-form.tsx` that sets the same status text either way — a *client* deciding what to
 * show, which an attacker is not obliged to run and which says nothing about what the server
 * sent.
 *
 * The property does hold. I assumed it held only by accident — that magic-link sign-up being
 * open is what removes the "unknown account" branch, and that closing it would produce an
 * oracle. **Measured, that is wrong**: with `disableSignUp: true` the server still answers
 * `200 {"status":true}` and still sends the link, so better-auth is withholding the answer
 * deliberately rather than by omission. Writing the guess down as the reason would have been
 * the same mistake this file exists to correct, one layer up.
 *
 * What it guards against is therefore anything that introduces a branch which is *not* there
 * today — a "do not email strangers" hook, a plugin swap, a friendlier error. Proved: adding
 * one refusal for an unregistered address on `/sign-in/magic-link` fails three of these four
 * tests, with `200 {"status":true}` against `404 ""`.
 */
const config: ApiConfig = loadConfig({
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  API_TRUST_PROXY: 'true',
});
const ORIGIN = 'http://127.0.0.1:3000';

/** Signed in during setup, so this one certainly exists. */
const REGISTERED = 'enumeration-known@example.com';
/** Never used, and asserted absent below — otherwise this file compares nothing to nothing. */
const UNREGISTERED = 'enumeration-nobody@example.com';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
const sentLinks: { email: string; url: string }[] = [];

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.18.11.${String(ipCounter % 250)}`;
}

/** Ask for a sign-in link, from its own address so the per-IP limit is never the answer. */
async function requestLink(email: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: ORIGIN, 'x-forwarded-for': nextIp() },
    payload: { email, callbackURL: '/' },
  });
}

async function accountsFor(email: string): Promise<number> {
  const rows = await tdb.db.execute<{ n: number }>(
    `select count(*)::int as n from app.users where email = '${email}'`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Everything the caller can see, minus what legitimately differs between any two responses.
 * `date` is the clock and `set-cookie` carries nothing here; both would make this flaky
 * without telling anybody anything.
 */
function visible(res: LightMyRequestResponse): unknown {
  const headers = Object.fromEntries(
    Object.entries(res.headers)
      .filter(([name]) => name !== 'date')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return { statusCode: res.statusCode, body: res.body, headers };
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
  });
  app = await buildApp(config, { db: tdb.db, writeDb: webPool.db, auth });

  // The account is inserted, not signed up.
  //
  // Signing in to create it is the obvious way and it is a trap: anything that closes
  // magic-link sign-up also breaks the fixture, so REGISTERED never exists, both addresses
  // are unknown, and "identical response" passes by comparing nothing to nothing. Not a
  // hypothetical — it is what this file did on its first run under `disableSignUp: true`, and
  // only the premise test below noticed.
  await tdb.db.execute(
    `insert into app.users (id, name, email) values ('enumeration-known', 'Known', '${REGISTERED}')`,
  );
}, 180_000);

afterAll(async () => {
  await app.close();
  await webPool.close();
  await tdb.close();
});

describe('asking whether an address has an account', () => {
  it('has one address that exists and one that does not', async () => {
    // The premise. Without it the comparison below is between two unregistered addresses,
    // which would pass however the server behaved.
    expect(await accountsFor(REGISTERED)).toBe(1);
    expect(await accountsFor(UNREGISTERED)).toBe(0);
  });

  it('answers a registered and an unregistered address identically', async () => {
    const known = await requestLink(REGISTERED);
    const unknown = await requestLink(UNREGISTERED);

    // Status, body and every header the caller can read. Not "both are 200" — that would
    // still pass if one of them carried a different code in the body.
    expect(visible(unknown)).toEqual(visible(known));
    expect(known.statusCode).toBe(200);
  });

  it('sends a link in both cases, so the inbox is not the oracle either', async () => {
    // An identical HTTP response with an email in one case and silence in the other tells the
    // person holding the address what the response would not.
    const before = sentLinks.length;
    await requestLink(UNREGISTERED);
    expect(sentLinks.slice(before).map((l) => l.email)).toEqual([UNREGISTERED]);
  });

  it('refuses a malformed address the same way regardless', async () => {
    // The other half of the oracle: a validation refusal must be about the shape of what was
    // sent, never about what is behind it.
    const bad = await requestLink('not-an-address');
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('exist');
  });
});
