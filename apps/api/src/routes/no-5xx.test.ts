import { randomBytes } from 'node:crypto';
import { createAuth } from '@gth/auth';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import { buildKeyRing } from '@gth/security';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import type { StripeClient } from '../payments/stripe.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * No signed-in request produces a 5xx (AC-3.4).
 *
 * The plan asks for this and the nightly fuzzer enforces it — against the **public** OpenAPI
 * document, which describes eight read-only GETs. The API has twenty-eight authenticated write
 * routes, and Schemathesis sees none of them: it has no session, and they are not in the
 * document it is pointed at.
 *
 * That is exactly where the misses were. Six routes answered `500 internal_error` for a
 * well-formed id that named nothing (#64) — every one of them behind a session, every one
 * invisible to the gate meant to catch precisely that.
 *
 * So the gate is brought inside, where sessions already work. The rule is deliberately weak
 * and absolute: **whatever a signed-in caller sends, the answer is the caller's problem, never
 * ours.** A 400, 403, 404 or 409 is all fine. A 5xx is a bug, because it says we broke, it is
 * what monitoring pages somebody about, and it buries real faults among false ones.
 *
 * The ids below are syntactically perfect and reference nothing. That is the shape that got
 * through last time: too well-formed for validation to reject, too absent for the database to
 * accept.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const ORIGIN = 'http://127.0.0.1:3000';
const keyRing = buildKeyRing(JSON.stringify({ k1: randomBytes(32).toString('base64') }), 'k1');

/** Well-formed, and nothing is there. */
const GHOST = '00000000-0000-4000-8000-000000000000';
const GHOST_2 = '00000000-0000-4000-8000-000000000001';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let cookie: string;
let adminCookie: string;
const sentLinks: { email: string; url: string }[] = [];

let counter = 0;
async function signIn(email: string): Promise<string> {
  counter += 1;
  const ip = `198.18.7.${String(counter % 250)}`;
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

interface Call {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  payload?: Record<string, unknown>;
  /** Which session to send. Defaults to the creator. */
  as?: 'creator' | 'admin' | 'anonymous';
}

/**
 * Every write route, with an id that names nothing and a body good enough to get past
 * validation — otherwise the request stops at a 400 and proves nothing about what lies behind
 * it.
 */
const WRITES: Call[] = [
  { method: 'POST', url: '/v1/watches', payload: { sealedProductId: GHOST, channels: ['email'] } },
  {
    method: 'POST',
    url: '/v1/watches',
    payload: { retailerProductId: GHOST, channels: ['email'] },
  },
  { method: 'DELETE', url: `/v1/watches/${GHOST}` },

  { method: 'POST', url: '/v1/collections', payload: { name: 'A binder' } },
  { method: 'PATCH', url: `/v1/collections/${GHOST}`, payload: { name: 'Renamed' } },
  { method: 'DELETE', url: `/v1/collections/${GHOST}` },
  { method: 'POST', url: `/v1/collections/${GHOST}/items`, payload: { cardVariantId: GHOST_2 } },
  {
    method: 'PATCH',
    url: `/v1/collections/${GHOST}/items/${GHOST_2}`,
    payload: { quantity: 3 },
  },
  { method: 'DELETE', url: `/v1/collections/${GHOST}/items/${GHOST_2}` },

  {
    method: 'POST',
    url: '/v1/breaks',
    payload: { title: 'A break', sealedProductId: GHOST, costCents: 1000 },
  },
  { method: 'POST', url: `/v1/breaks/${GHOST}/status`, payload: { status: 'live' } },
  { method: 'POST', url: `/v1/breaks/${GHOST}/packs`, payload: { packsOpened: 12 } },
  { method: 'POST', url: `/v1/breaks/${GHOST}/vod`, payload: { vodUrl: 'https://example.test/v' } },
  { method: 'POST', url: `/v1/breaks/${GHOST}/overlay-token` },
  { method: 'POST', url: `/v1/breaks/${GHOST}/commit`, payload: { slotCount: 8 } },
  { method: 'POST', url: `/v1/breaks/${GHOST}/client-seed`, payload: { clientSeed: 'chat' } },
  { method: 'POST', url: `/v1/breaks/${GHOST}/reveal` },
  {
    method: 'PUT',
    url: `/v1/pulls/${GHOST}/evidence`,
    payload: { offsetSeconds: 30 },
  },
  { method: 'DELETE', url: `/v1/pulls/${GHOST}/evidence` },

  { method: 'POST', url: '/v1/live-sales', payload: { cardVariantId: GHOST, priceCents: 1500 } },
  { method: 'DELETE', url: `/v1/live-sales/${GHOST}` },

  {
    method: 'POST',
    url: '/v1/listings',
    payload: { cardVariantId: GHOST, condition: 'nm', priceCents: 2500 },
  },
  { method: 'PATCH', url: `/v1/listings/${GHOST}`, payload: { priceCents: 2500, quantity: 1 } },
  { method: 'POST', url: `/v1/listings/${GHOST}/status`, payload: { status: 'active' } },
  { method: 'DELETE', url: `/v1/listings/${GHOST}` },

  { method: 'POST', url: '/v1/seller/onboard' },

  // Buying something that is not there. The interesting sweep is the one *after* this — a
  // real listing whose seller Stripe has never heard of — which `checkout.test.ts` covers
  // because it needs a second user to own the listing.
  { method: 'POST', url: `/v1/listings/${GHOST}/buy` },

  {
    method: 'POST',
    url: `/v1/listings/${GHOST}/photos`,
    payload: { contentType: 'image/jpeg', contentLength: 1000 },
  },
  { method: 'POST', url: `/v1/listings/${GHOST}/photos/${GHOST}/complete` },
  { method: 'PATCH', url: `/v1/listings/${GHOST}/photos`, payload: { photoIds: [GHOST] } },
  { method: 'DELETE', url: `/v1/listings/${GHOST}/photos/${GHOST}` },

  {
    method: 'POST',
    url: `/v1/orders/${GHOST}/ship`,
    payload: { carrier: 'Royal Mail', trackingNumber: 'AB123456789GB' },
  },
  { method: 'POST', url: `/v1/orders/${GHOST}/cancel`, payload: {} },
  { method: 'POST', url: `/v1/orders/${GHOST}/dispute`, payload: { reason: 'nothing arrived' } },

  // Admin. Reached with an admin session, so the refusal is on the merits rather than
  // stopping at the role check with the code behind it unvisited.
  {
    method: 'POST',
    url: `/v1/admin/orders/${GHOST}/deliver`,
    payload: { reason: 'carrier confirmed' },
    as: 'admin',
  },
  {
    method: 'POST',
    url: `/v1/admin/orders/${GHOST}/complete`,
    payload: { reason: 'resolved' },
    as: 'admin',
  },

  // Unsigned, which is what every caller who is not Stripe looks like.
  { method: 'POST', url: '/v1/webhooks/stripe', payload: { id: 'evt_x', type: 'account.updated' } },

  {
    method: 'POST',
    url: '/v1/developer/keys',
    payload: { name: 'A key', scopes: ['catalog:read'] },
  },
  { method: 'DELETE', url: `/v1/developer/keys/${GHOST}` },

  { method: 'PATCH', url: '/v1/me', payload: { displayName: 'Someone' } },
  {
    method: 'PUT',
    url: '/v1/me/profile',
    payload: { handle: 'someone', displayName: 'Someone', published: false },
  },
  { method: 'DELETE', url: '/v1/me/profile' },

  { method: 'POST', url: `/v1/account/sessions/${GHOST}/revoke` },
  { method: 'POST', url: '/v1/account/sessions/revoke-others' },
  { method: 'POST', url: '/v1/account/delete', payload: { email: 'nobody@example.test' } },

  // No session by design (SR-1.12). Sent a token that is not one: it must answer, not break.
  { method: 'POST', url: '/v1/unsubscribe?t=not-a-signed-link', as: 'anonymous' },

  // Admin. Reached with an admin session below, so the refusal is on the merits of the
  // request rather than stopping at the role check with the code behind it unvisited.
  {
    method: 'POST',
    url: `/v1/admin/reports/${GHOST}/decision`,
    payload: { decision: 'approve' },
    as: 'admin',
  },
];

/**
 * A Stripe that answers without a network.
 *
 * So the payment routes are *in* this sweep rather than absent from it: routes that only exist
 * when a secret is configured are exactly the ones that never get swept, and this file's whole
 * argument is that the unswept routes are where the 5xx are.
 *
 * `constructEvent` throws because nothing this sweep sends is signed, and that is the path a
 * webhook request takes here. 400 is the right answer and passes the rule, which is only that
 * we never blame ourselves for what a caller sent.
 */
function fakeStripe(): StripeClient {
  return {
    createConnectedAccount: () => Promise.resolve({ accountId: 'acct_no5xx' }),
    createOnboardingLink: () => Promise.resolve({ url: 'https://connect.stripe.test/x' }),
    getAccountStatus: () =>
      Promise.resolve({ chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false }),
    constructEvent: () => {
      throw new Error('no signature');
    },
    createCheckoutSession: () =>
      Promise.resolve({ id: 'cs_no5xx', url: 'https://checkout.stripe.test/x' }),
  };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });

  const auth = createAuth(webPool.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: ['http://127.0.0.1:4000', ORIGIN],
    production: false,
    trustProxyHeaders: true,
    passkey: TEST_PASSKEY,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
  });

  // Everything mounted at once: a route that is absent answers 404, which would pass this
  // test while testing nothing.
  app = await buildApp(config, {
    db: tdb.db,
    writeDb: webPool.db,
    auth,
    keysDb: workerPool.db,
    moderationDb: workerPool.db,
    breaks: {
      db: webPool.db,
      tokenPepper: config.TOKEN_PEPPER,
      keyRing,
      secretsDb: workerPool.db,
    },
    liveSales: { db: webPool.db, keyRing },
    // A fake Stripe, so the seller routes are *in* this sweep rather than absent from it.
    // Routes that only exist when a secret is configured are exactly the ones that never get
    // swept, and this file's whole argument is that the unswept routes are where the 5xx are.
    seller: { db: webPool.db, stripe: fakeStripe(), appBaseUrl: 'http://127.0.0.1:3000' },
    stripeWebhook: { workerDb: workerPool.db, stripe: fakeStripe() },
    checkout: {
      db: webPool.db,
      stripe: fakeStripe(),
      appBaseUrl: 'http://127.0.0.1:3000',
      feeBps: 500,
    },
    /**
     * A storage that answers without a bucket.
     *
     * Every id in this sweep is a ghost, so each photo route refuses at the database long
     * before it reaches storage — which is the point: what is being swept is the refusal path,
     * and that path must not be a 5xx. A real bucket here would add two containers to prove
     * nothing extra.
     */
    photos: {
      db: webPool.db,
      workerDb: workerPool.db,
      storage: {
        ensureBucket: () => Promise.resolve(),
        presignUpload: () => ({ url: 'https://bucket.test/upload', expiresInSeconds: 900 }),
        presignView: () => ({ url: 'https://bucket.test/view', expiresInSeconds: 300 }),
        getObject: () => Promise.reject(new Error('not reached in this sweep')),
        putObject: () => Promise.resolve(),
        deleteObject: () => Promise.resolve(),
      },
    },
    notify: () => Promise.resolve(),
  });

  // Roles are set directly, the way an operator would: they cannot be granted through the
  // app (SR-2.6). Without them every creator route would stop at the role check and leave
  // the code behind it unvisited, which is where the bugs live.
  cookie = await signIn('no5xx@example.com');
  await tdb.db.execute(`update app.users set role = 'creator' where email = 'no5xx@example.com'`);
  adminCookie = await signIn('no5xx-admin@example.com');
  await tdb.db.execute(
    `update app.users set role = 'admin' where email = 'no5xx-admin@example.com'`,
  );
});

afterAll(async () => {
  await app.close();
  await workerPool.close();
  await webPool.close();
  await tdb.close();
});

const describeCall = (call: Call): string => `${call.method} ${call.url}`;

describe('no signed-in request answers 5xx (AC-3.4)', () => {
  it.each(WRITES.map((call) => [describeCall(call), call] as const))('%s', async (_name, call) => {
    const res: LightMyRequestResponse = await app.inject({
      method: call.method,
      url: call.url,
      headers:
        call.as === 'anonymous'
          ? { origin: ORIGIN }
          : { cookie: call.as === 'admin' ? adminCookie : cookie, origin: ORIGIN },
      ...(call.payload ? { payload: call.payload } : {}),
    });
    expect(res.statusCode, `${describeCall(call)} → ${res.body}`).toBeLessThan(500);
    // A route that is public by design has no session to be in force.
    if (call.as === 'anonymous') return;
    // The session must really be in force. Without this the sweep could quietly become
    // thirty 401s — every one of them under 500, and every one of them proving nothing.
    expect(res.statusCode, `${describeCall(call)} did not accept the session`).not.toBe(401);
  });

  it('covers every write route the app actually has', () => {
    // The sweep is a hand-written list, so it can rot. This compares it against the routes
    // Fastify really registered: a new write route has to be added here, or this fails and
    // says which one. Without it the file would keep passing while going quietly out of date.
    const registered = new Set<string>();
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /^.*?([/\S]+) \((.+)\)$/.exec(line.trim());
      if (!match) continue;
      const [, path, methods] = match;
      for (const method of String(methods).split(', ')) {
        if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) continue;
        if (!String(path).startsWith('/v1/')) continue; // auth routes are Better Auth's own
        registered.add(`${method} ${String(path)}`);
      }
    }

    const swept = new Set(
      WRITES.map((call) => {
        const path = (call.url.split('?')[0] ?? call.url)
          .replaceAll(GHOST, ':id')
          .replaceAll(GHOST_2, ':id')
          .replace(/^\/v1\/admin\/reports\/:id\//, '/v1/admin/reports/:id/')
          // Fastify names the parameters; normalise to compare shapes rather than spelling.
          .replace(/\/:id\/items\/:id$/, '/:id/items/:itemId')
          .replace(/^\/v1\/pulls\/:id\//, '/v1/pulls/:pullId/');
        return `${call.method} ${path}`;
      }),
    );

    const missing = [...registered].filter((route) => !swept.has(route)).sort();
    expect(missing, 'write routes not covered by the 5xx sweep').toEqual([]);
  });
});
