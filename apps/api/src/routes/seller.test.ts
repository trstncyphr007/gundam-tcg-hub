import { createAuth } from '@gth/auth';
import { asUser, createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import type { StripeClient } from '../payments/stripe.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * Becoming a seller (FR-5.1).
 *
 * Stripe is a fake here. What is under test is our half: that one person gets one connected
 * account however many times they click, that the link they are sent to is built from our own
 * configuration, and that the two booleans deciding whether somebody may take money come from
 * Stripe rather than from us.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const ORIGIN = 'http://127.0.0.1:3000';
const APP_BASE = 'http://127.0.0.1:3000';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let seller = '';
const sentLinks: { email: string; url: string }[] = [];

/** What the fake Stripe was asked to do, so a test can count the asking. */
const stripeCalls = { created: 0, links: 0, lastLink: null as Record<string, string> | null };
let accountStatus = { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };

const fakeStripe: StripeClient = {
  createConnectedAccount: ({ userId }) => {
    stripeCalls.created += 1;
    return Promise.resolve({ accountId: `acct_${userId.replace(/[^A-Za-z0-9]/gu, '')}` });
  },
  createOnboardingLink: ({ accountId, returnUrl, refreshUrl }) => {
    stripeCalls.links += 1;
    stripeCalls.lastLink = { accountId, returnUrl, refreshUrl };
    return Promise.resolve({ url: 'https://connect.stripe.com/setup/fake' });
  },
  getAccountStatus: () => Promise.resolve(accountStatus),
  constructEvent: () => {
    throw new Error('not used here');
  },
  createCheckoutSession: () => {
    throw new Error('not used here');
  },
  refundPayment: () => {
    throw new Error('not used here');
  },
  setPayoutSchedule: () => Promise.resolve(),
};

let ipCounter = 0;
async function signIn(email: string): Promise<string> {
  ipCounter += 1;
  const ip = `198.51.102.${String(ipCounter % 250)}`;
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
  return String(/gth\.session_token=[^;\s]+/.exec(joined)?.[0]);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });

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
  });
  app = await buildApp(config, {
    db: tdb.db,
    writeDb: webPool.db,
    auth,
    seller: { db: webPool.db, stripe: fakeStripe, appBaseUrl: APP_BASE },
  });

  ({ cookie: seller } = await newSeller());
}, 180_000);

afterAll(async () => {
  await app.close();
  await webPool.close();
  await tdb.close();
});

/**
 * A seller nobody has used before.
 *
 * One per test, because onboarding is limited to five an hour **per account** and a file that
 * shares one seller across nine tests spends that allowance on itself. The first version did
 * exactly that, and two tests failed on a 429 from a limiter working correctly — which is a
 * better way to find out than in production.
 */
let sellerCounter = 0;
async function newSeller(): Promise<{ cookie: string; id: string }> {
  sellerCounter += 1;
  const email = `onboard-seller-${String(sellerCounter)}@example.com`;
  const cookie = await signIn(email);
  const [row] = await tdb.db.execute<{ id: string }>(
    `select id from app.users where email = '${email}'`,
  );
  return { cookie, id: String(row?.id) };
}

beforeEach(async () => {
  // `audit_log` too: it is append-only with no DELETE for anybody, so entries from the last
  // test would otherwise be counted by the next one. TRUNCATE is the owner's privilege and
  // bypasses both the missing grant and the policies.
  await tdb.db.execute(
    `truncate app.orders, app.listings, app.seller_accounts, app.audit_log cascade`,
  );
  stripeCalls.created = 0;
  stripeCalls.links = 0;
  stripeCalls.lastLink = null;
  accountStatus = { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
});

describe('before onboarding', () => {
  it('needs a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/seller' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/seller/onboard',
          headers: { origin: ORIGIN },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('says plainly that nothing has started', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/seller', headers: { cookie: seller } });
    expect(res.json()).toEqual({
      onboarded: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      displayName: null,
    });
  });
});

describe('starting onboarding', () => {
  it('creates one connected account and hands back Stripe’s link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/seller/onboard',
      headers: { cookie: seller, origin: ORIGIN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ url: string }>().url).toBe('https://connect.stripe.com/setup/fake');
    expect(stripeCalls.created).toBe(1);
  });

  it('does not start a second account when somebody comes back', async () => {
    // Stripe's onboarding can be abandoned half way and resumed. Creating a new account each
    // time would leave a trail of half-finished ones and no answer to which is theirs.
    for (let i = 0; i < 3; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/v1/seller/onboard',
        headers: { cookie: seller, origin: ORIGIN },
      });
    }
    expect(stripeCalls.created).toBe(1);
    expect(stripeCalls.links).toBe(3);
  });

  it('sends them back to our own site, not anywhere a request asked', async () => {
    // An onboarding link that redirects wherever a request named would be a phishing page
    // with our name on it. Both URLs come from configuration.
    await app.inject({
      method: 'POST',
      url: '/v1/seller/onboard',
      headers: { cookie: seller, origin: ORIGIN },
      payload: { returnUrl: 'https://evil.test/steal' },
    });
    expect(stripeCalls.lastLink?.returnUrl).toBe(`${APP_BASE}/account/selling?onboarded=1`);
    expect(stripeCalls.lastLink?.refreshUrl).toBe(`${APP_BASE}/account/selling`);
  });

  it('writes an audit entry the first time and not on every retry', async () => {
    const who = await newSeller();
    for (let i = 0; i < 2; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/v1/seller/onboard',
        headers: { cookie: who.cookie, origin: ORIGIN },
      });
    }
    const rows = await tdb.db.execute<{ action: string }>(
      `select action from app.audit_log where action = 'seller.onboarding_started'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('is limited to five an hour, per account', async () => {
    // Creating a connected account is a round trip to Stripe, and the only legitimate reason
    // to do it twice is the first one failing. Five leaves room for that and none for a
    // script. Per account, so one person cannot spend everybody's allowance.
    const who = await newSeller();
    const codes: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/seller/onboard',
        headers: { cookie: who.cookie, origin: ORIGIN },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);

    // And somebody else is unaffected, which is what "per account" means.
    const other = await newSeller();
    const theirs = await app.inject({
      method: 'POST',
      url: '/v1/seller/onboard',
      headers: { cookie: other.cookie, origin: ORIGIN },
    });
    expect(theirs.statusCode).toBe(200);
  });
});

describe('what the account may do', () => {
  it('is Stripe’s answer, not a row we wrote', async () => {
    const who = await newSeller();
    await app.inject({
      method: 'POST',
      url: '/v1/seller/onboard',
      headers: { cookie: who.cookie, origin: ORIGIN },
    });

    // Our own row still says false for both — the webhook that fills it does not exist yet.
    //
    // Read through `asUser` on the web pool, not as the migrator: `seller_accounts` FORCE's
    // row-level security and its policies name app_web and app_worker, so the schema owner
    // matches none of them and quietly selects nothing.
    const stored = await asUser(webPool.db, who.id, (tx) =>
      tx.execute<{ charges_enabled: boolean }>(`select charges_enabled from app.seller_accounts`),
    );
    expect(stored[0]?.charges_enabled).toBe(false);

    // Stripe says otherwise, and Stripe is the one who knows.
    accountStatus = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
    const res = await app.inject({
      method: 'GET',
      url: '/v1/seller',
      headers: { cookie: who.cookie },
    });
    expect(res.json()).toEqual({
      onboarded: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      displayName: null,
    });
  });

  it('never returns the Stripe account id to the browser', async () => {
    // It is Stripe's identifier for somebody's business and a page has no use for it.
    await app.inject({
      method: 'POST',
      url: '/v1/seller/onboard',
      headers: { cookie: seller, origin: ORIGIN },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/seller', headers: { cookie: seller } });
    expect(res.body).not.toContain('acct_');
  });
});

describe('a session cannot promote itself', () => {
  it('has no grant on the two columns that decide it', async () => {
    // Not "no route for it": migration 0041 gives the web role INSERT on five columns and
    // `charges_enabled` is not among them, so the capability is outside the grant rather than
    // outside the code path.
    await app.inject({
      method: 'POST',
      url: '/v1/seller/onboard',
      headers: { cookie: seller, origin: ORIGIN },
    });

    let refused = false;
    try {
      await webPool.db.execute(`update app.seller_accounts set charges_enabled = true`);
    } catch {
      refused = true;
    }
    expect(refused, 'the web role should not be able to grant itself charges').toBe(true);
  });
});
