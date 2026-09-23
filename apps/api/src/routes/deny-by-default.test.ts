import { randomBytes } from 'node:crypto';
import { createAuth } from '@gth/auth';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import { buildKeyRing } from '@gth/security';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * Deny by default, checked against the routes that exist (SR-X.6).
 *
 * The plan asks for exactly this: "Every route declares a required permission, and a lint or
 * test checks that no route lacks one." Neither existed. `.semgrep.yml` has five custom rules
 * and none of them is about authorization, and while most route suites test their own
 * "requires a session" case, nothing stood over the whole set — which is the only place a
 * *newly added* route can go missing.
 *
 * So the check is the inventory itself: every route the application has registered must refuse
 * an anonymous request, unless it appears in the list below. The list is the point. Making a
 * route public becomes a line someone writes down and a reviewer can see, rather than the
 * silent consequence of forgetting one.
 *
 * **What this proves, and what it does not.** It proves no route is *silently* open. It says
 * nothing about whether a route that is open serves the right rows — a 404 for an id that
 * exists nowhere would look identical to a 404 for someone else's private collection. That
 * second property is the two-user matrix in `collections.test.ts` and the row policies
 * underneath it. The two checks are complements, and neither substitutes for the other.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const keyRing = buildKeyRing(JSON.stringify({ k1: randomBytes(32).toString('base64') }), 'k1');

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;

/**
 * Routes that answer without a session, each for a stated reason.
 *
 * Adding to this list is the deliberate act. Nothing reaches it by accident.
 */
const PUBLIC: { route: string; why: string }[] = [
  // Operational.
  { route: 'GET /healthz', why: 'liveness; touches nothing' },
  { route: 'GET /readyz', why: 'readiness; reports dependency health only' },
  { route: 'GET /docs', why: 'the published API documentation (FR-3.6)' },
  { route: 'GET /docs/openapi.json', why: 'the published API description' },

  // The catalogue and price index: the public API this project exists to offer (FR-1.3,
  // FR-3.6). Read-only, and the only routes the nightly fuzzer can see.
  { route: 'GET /v1/games', why: 'public catalogue' },
  { route: 'GET /v1/sets', why: 'public catalogue' },
  { route: 'GET /v1/cards', why: 'public catalogue' },
  { route: 'GET /v1/cards/:id', why: 'public catalogue' },
  { route: 'GET /v1/cards/:id/prices', why: 'public price index' },
  { route: 'GET /v1/products', why: 'public catalogue' },
  { route: 'GET /v1/breakers', why: 'public breaker profiles (FR-4.3)' },
  { route: 'GET /v1/breakers/:handle', why: 'public breaker profile' },

  // Published on purpose, and filtered per row rather than by session. A break that is still
  // a draft is not served at all, which is what stops a commitment being read before it is
  // meant to be (`getPublicBreak` refuses `status = 'draft'`).
  { route: 'GET /v1/breaks/:id/public', why: 'the public break page and its evidence (FR-2.2)' },
  { route: 'GET /v1/breaks/:id/export', why: 'the same log, as CSV or JSON (FR-2.5)' },

  // Visibility lives on the row: private stays private, unlisted and public do not. Answering
  // 404 rather than 401 is deliberate — a 401 would confirm the collection exists.
  { route: 'GET /v1/collections/public', why: 'the public collections index (FR-3.4)' },
  { route: 'GET /v1/collections/:id', why: 'public and unlisted collections' },
  { route: 'GET /v1/collections/:id/value', why: 'as above' },
  { route: 'GET /v1/collections/:id/export', why: 'as above' },

  // Authenticated, but not by a session: the token in the path *is* the credential (SR-2.1),
  // hashed at rest and revocable. OBS has nowhere to keep a cookie.
  { route: 'GET /v1/overlay/:token', why: 'overlay token is the credential' },
  { route: 'GET /v1/overlay/:token/stream', why: 'overlay token is the credential' },
];

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });

  const auth = createAuth(webPool.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: ['http://127.0.0.1:4000'],
    production: false,
    trustProxyHeaders: true,
    passkey: TEST_PASSKEY,
    sendMagicLink: () => Promise.resolve(),
  });

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
    notify: () => Promise.resolve(),
  });
});

afterAll(async () => {
  await app.close();
  await workerPool.close();
  await webPool.close();
  await tdb.close();
});

/** Every route the application registered, as "METHOD /path". */
function registeredRoutes(): string[] {
  return [...new Set(app.routeTable.map((route) => `${route.method} ${route.url}`))].sort();
}

/** A body good enough to reach the handler, so a 400 never stands in for a 401. */
const BODY = {
  name: 'anything',
  title: 'anything',
  channels: ['email'],
  slotCount: 4,
  clientSeed: 'seed',
  cardVariantId: '00000000-0000-4000-8000-000000000000',
  sealedProductId: '00000000-0000-4000-8000-000000000000',
  priceCents: 100,
  costCents: 100,
};

describe('deny by default (SR-X.6)', () => {
  it('refuses an anonymous request to every route that is not declared public', async () => {
    const declared = new Set(PUBLIC.map((entry) => entry.route));
    const open: string[] = [];

    for (const route of registeredRoutes()) {
      if (declared.has(route)) continue;
      // Better Auth owns its own surface and has its own rules; sign-in must stay reachable.
      if (route.includes('/api/auth/')) continue;

      const [method, path] = route.split(' ');
      const url = String(path)
        .replaceAll(':id', '00000000-0000-4000-8000-000000000000')
        .replaceAll(':itemId', '00000000-0000-4000-8000-000000000001')
        .replaceAll(':pullId', '00000000-0000-4000-8000-000000000002')
        .replaceAll(':handle', 'somebody')
        .replaceAll(':token', 'not-a-real-token')
        .replaceAll('*', 'anything');

      const response = await app.inject({
        method: method as 'GET',
        url,
        ...(method === 'GET' || method === 'DELETE' ? {} : { payload: BODY }),
      });
      // 401 exactly, not merely "some refusal". An anonymous caller has not failed a
      // permission check, they have not identified themselves, and only one of those two
      // answers tells a client to go and sign in. Deleting a route's session check happens to
      // leave `authorize()` throwing 403 — denied, but denied for the wrong reason and
      // described wrongly to whoever is on the other end. Insisting on 401 is what makes that
      // visible instead of silently acceptable.
      if (response.statusCode !== 401) {
        open.push(`${route} → ${String(response.statusCode)}`);
      }
    }

    expect(open, 'routes answering an anonymous caller without 401').toEqual([]);
  });

  it('lists nothing as public that no longer exists', () => {
    // A stale exemption is worse than none: it reads as a decision somebody made about a
    // route, long after that route stopped existing.
    const registered = new Set(registeredRoutes());
    const stale = PUBLIC.filter((entry) => !registered.has(entry.route)).map((e) => e.route);
    expect(stale, 'public exemptions for routes that are gone').toEqual([]);
  });
});
