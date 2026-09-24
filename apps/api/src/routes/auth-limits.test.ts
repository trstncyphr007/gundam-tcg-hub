import { createAuth } from '@gth/auth';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * The per-address half of SR-1.9: "10 per minute per IP **and 5 per minute per account
 * identifier**".
 *
 * Only the first half existed. better-auth's limiter keys on the caller's address, so anybody
 * able to rotate source addresses could point the sign-in form at a stranger's inbox and have
 * us deliver, from our domain, as many emails as they liked.
 *
 * **Every request below comes from a different IP.** That is the whole point of the fixture:
 * the built-in per-IP limit on this same path is also five a minute, so a test that hammered
 * one address from one IP would pass identically with the new limiter deleted. Changing the IP
 * each time leaves the per-address limiter as the only thing that can refuse.
 */
const config: ApiConfig = loadConfig({
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  API_TRUST_PROXY: 'true',
});
const ORIGIN = 'http://127.0.0.1:3000';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
const sentLinks: { email: string; url: string }[] = [];

let ipCounter = 0;
/** A new source address every time, so the per-IP limiter never reaches its own allowance. */
function nextIp(): string {
  ipCounter += 1;
  return `198.18.${String(Math.floor(ipCounter / 250) % 250)}.${String(ipCounter % 250)}`;
}

async function requestLink(email: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: ORIGIN, 'x-forwarded-for': nextIp() },
    payload: { email, callbackURL: '/' },
  });
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
}, 180_000);

afterAll(async () => {
  await app.close();
  await webPool.close();
  await tdb.close();
});

describe('asking for sign-in links to one address', () => {
  it('is refused past the allowance, however many places it comes from', async () => {
    const victim = 'flooded@example.test';

    for (let i = 0; i < 5; i += 1) {
      const allowed = await requestLink(victim);
      expect(allowed.statusCode, `request ${String(i + 1)} of 5`).toBe(200);
    }

    const refused = await requestLink(victim);
    expect(refused.statusCode).toBe(429);
    // Nothing further was posted into their inbox.
    expect(sentLinks.filter((l) => l.email === victim)).toHaveLength(5);
  });

  it('does not take everybody else down with it', async () => {
    // A per-address limiter that refuses the wrong people is a denial of service wearing a
    // control's clothes. Somebody signing in during the flood above must still get in.
    const bystander = await requestLink('bystander@example.test');
    expect(bystander.statusCode).toBe(200);
  });

  it('says nothing about whether the address has an account', async () => {
    // The refusal happens before anything is looked up, so a flooded registered address and a
    // flooded unregistered one answer identically. `enumeration.test.ts` owns the general
    // property; this pins that the new limiter did not quietly become an oracle.
    const unknown = 'flooded-unknown@example.test';
    for (let i = 0; i < 5; i += 1) await requestLink(unknown);

    const refusedUnknown = await requestLink(unknown);
    const refusedKnown = await requestLink('flooded@example.test');

    expect(refusedUnknown.statusCode).toBe(refusedKnown.statusCode);
    expect(refusedUnknown.body).toBe(refusedKnown.body);
  });
});

describe('adding and removing watches', () => {
  it('is counted per account, not per address', async () => {
    // SR-1.9's other missing half. These routes declared no limit, so they inherited the
    // global 120 a minute keyed on the caller's address: four times looser than promised, and
    // the wrong unit. Unauthenticated here, which is enough — the limiter runs at preHandler,
    // so it is reached before the 401 and the key falls back to the address.
    const ip = nextIp();
    const call = (): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: '/v1/watches',
        headers: { origin: ORIGIN, 'x-forwarded-for': ip },
        payload: { sealedProductId: '00000000-0000-7000-8000-000000000000', channels: ['email'] },
      });

    const codes: number[] = [];
    for (let i = 0; i < 31; i += 1) codes.push((await call()).statusCode);

    // The first thirty get as far as the route (401, no session); the thirty-first is stopped
    // by the limiter. Under the old global limit of 120 this would have been 31 × 401.
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});
