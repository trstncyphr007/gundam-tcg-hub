import { randomUUID } from 'node:crypto';
import cors, { type FastifyCorsOptions } from '@fastify/cors';
import etag from '@fastify/etag';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Auth, SecurityNotice } from '@gth/auth';
import { ForbiddenError, PasskeyRequiredError, StepUpRequiredError } from '@gth/auth';
import {
  type Database,
  type FlagReader,
  MissingReferenceError,
  consumeApiKeyQuota,
  createFlagReader,
  pingDatabase,
} from '@gth/db';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { ApiConfig } from './config.js';
import { serialiseError } from './log-error.js';
import { logUrl } from './log-url.js';
import { ApiKeyError, apiKeyPlugin } from './plugins/api-key.js';
import { authPlugin } from './plugins/auth.js';
import { killSwitchPlugin } from './plugins/kill-switch.js';
import { QuotaStore, quotaPlugin } from './plugins/quota.js';
import { createRateLimitRecorder } from './plugins/rate-limit-audit.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAccountDataRoutes } from './routes/account-data.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerDeveloperRoutes } from './routes/developer.js';
import { type BreakDeps, registerBreakRoutes } from './routes/breaks.js';
import { registerCollectionRoutes } from './routes/collections.js';
import { type IngestDeps, registerIngestRoutes } from './routes/ingest.js';
import { type LiveSaleDeps, registerLiveSaleRoutes } from './routes/live-sales.js';
import { registerMarketRoutes } from './routes/market.js';
import { type CheckoutDeps, registerCheckoutRoutes } from './routes/checkout.js';
import { type PhotoDeps, registerPhotoRoutes } from './routes/photos.js';
import { registerFulfilmentRoutes } from './routes/fulfilment.js';
import { registerRatingRoutes } from './routes/ratings.js';
import { type SellerDeps, registerSellerRoutes } from './routes/seller.js';
import { type StripeWebhookDeps, registerStripeWebhookRoutes } from './routes/stripe-webhook.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerUnsubscribeRoutes } from './routes/unsubscribe.js';
import { registerWatchRoutes } from './routes/watches.js';
import { renderDocsPage } from './v1/docs.js';
import { buildOpenApiDocument } from './v1/openapi.js';
import { registerPublicRoutes } from './v1/registry.js';
import { publicRoutes } from './v1/routes.js';

/** The methods a 405's `Allow` header may name. Anything else cannot have a route. */
const ALLOWABLE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/**
 * Does a concrete request path match a registered route pattern?
 *
 * `/v1/cards/:id/prices` matches `/v1/cards/<anything>/prices`, and a trailing `*` matches the
 * rest. Deliberately only as clever as the patterns this app actually registers.
 */
export function pathMatchesRoute(pattern: string, path: string): boolean {
  const expected = pattern.split('/');
  const actual = path.split('/');
  for (const [i, segment] of expected.entries()) {
    if (segment === '*') return true;
    // `.at()` rather than an index expression, the same way the pricing maths does it: it is
    // typed `string | undefined`, so a short path is a missing value rather than a surprise.
    const got = actual.at(i);
    if (got === undefined) return false;
    if (segment.startsWith(':')) {
      if (got === '') return false;
      continue;
    }
    if (segment !== got) return false;
  }
  return expected.length === actual.length;
}

/** One registered route, as Fastify received it. */
export interface RouteRecord {
  method: string;
  url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route this instance serves. Filled as routes are registered. */
    routeTable: RouteRecord[];
  }
}

export interface AppDeps {
  /** Read-only connection for public catalog endpoints (least privilege). */
  db?: Database | undefined;
  /** Read-write connection (app_web) for account data; required alongside `auth`. */
  writeDb?: Database | undefined;
  auth?: Auth | undefined;
  /** Scanner ingestion, which runs on the app_worker role. */
  ingest?: IngestDeps | undefined;
  /** Creator breaks and the OBS overlay (Phase 2). */
  breaks?: BreakDeps | undefined;
  /** The live-sale logger (Phase 4). Runs on the web role; ingestion is the worker's. */
  liveSales?: LiveSaleDeps | undefined;
  /**
   * The pool that may read `key_hash`, for verifying presented API keys. This is the worker
   * role: the web role has no SELECT privilege on that column at all (migration 0017).
   */
  keysDb?: Database | undefined;
  /**
   * The pool moderation decisions run on — the worker role, the only one that may change
   * whether a price counts (migration 0027). Without it the admin console is not mounted at
   * all, rather than mounted and quietly unable to decide anything.
   */
  moderationDb?: Database | undefined;
  /** Security emails sent outside a Better Auth flow: export and deletion (ADR-027). */
  notify?: ((notice: SecurityNotice) => Promise<void>) | undefined;
  /**
   * Kill switches (§22, ADR-039). Built from `db` when not supplied; injectable so a test can
   * hand in one with no cache and watch a flip take effect immediately.
   */
  flags?: FlagReader | undefined;
  /**
   * The marketplace's payment side (Phase 5). Absent means the seller routes are not mounted
   * at all, rather than mounted and quietly unable to do anything — the same shape as
   * `moderationDb`. Without Stripe configured there is no marketplace, and a route that
   * answers 500 because a key is missing is worse than one that is not there.
   */
  seller?: SellerDeps | undefined;
  /**
   * Buying (FR-5.3). Separate from `seller` because the two answer different questions and a
   * deployment could reasonably have one without the other — listings can exist before anybody
   * can be paid, and the route that takes money should be the last one mounted, not the first.
   */
  checkout?: CheckoutDeps | undefined;
  /**
   * Listing photos (FR-5.2, SR-5.5). Absent when no bucket is configured, which means the
   * upload routes are not mounted rather than mounted and unable to store anything.
   */
  photos?: PhotoDeps | undefined;
  /**
   * Stripe's webhooks (SR-5.2). Runs on the worker role and needs the raw body, so it is
   * registered in its own scope. Absent means the endpoint does not exist — better than one
   * that exists and cannot verify anything.
   */
  stripeWebhook?: StripeWebhookDeps | undefined;
}

/** Never log credentials or session material (SR-X.20). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

type FastifyCorsCallback = (error: Error | null, options: FastifyCorsOptions) => void;

/** The documented, cross-origin-readable surface. Everything else stays same-origin. */
const PUBLIC_PATHS = publicRoutes.map((route) => route.path);

export function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (path === '/docs' || path === '/docs/openapi.json') return true;
  // Compare segment by segment so `:id` matches one segment and nothing else — a prefix
  // check would make `/v1/cards/x/secret` look public.
  const segments = path.split('/').filter((s) => s.length > 0);
  return PUBLIC_PATHS.some((pattern) => {
    const expected = pattern.split('/').filter((s) => s.length > 0);
    if (expected.length !== segments.length) return false;
    return expected.every((part, i) => part.startsWith(':') || part === segments.at(i));
  });
}

/** Fastify types handler errors as `unknown`; pull out only what we trust. */
function describeError(error: unknown): { status: number; code: string; message: string } {
  const fields = (typeof error === 'object' && error !== null ? error : {}) as Record<
    string,
    unknown
  >;
  const { statusCode, code, message } = fields;
  const status =
    typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  return {
    status,
    code: typeof code === 'string' ? code : 'bad_request',
    message: typeof message === 'string' ? message : 'Bad request',
  };
}

export async function buildApp(config: ApiConfig, deps: AppDeps = {}): Promise<FastifyInstance> {
  const quotaStore = new QuotaStore();
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
            serializers: {
              req: (request: { id: string; method: string; url: string }) => ({
                id: request.id,
                method: request.method,
                url: logUrl(request.url),
              }),
              // pino's default copies an error's own properties, which for a driver error
              // means the failing statement and everything bound to it (see log-error.ts).
              err: serialiseError,
            },
          },
    trustProxy: config.API_TRUST_PROXY,
    genReqId: () => randomUUID(),
    bodyLimit: 1_048_576,
    requestTimeout: 15_000,
  });

  /**
   * What this application actually serves, recorded as it is built (SR-X.6).
   *
   * Every route, exactly as Fastify received it. `printRoutes` renders a radix tree meant for
   * a human — it splits shared prefixes across lines and merges differently-named parameters
   * into `:key|:id` — so reconstructing paths from it is guesswork that is wrong in exactly
   * the cases that matter. This is the register itself.
   *
   * It exists so a check can be made against the routes that are here rather than the ones
   * someone remembered: `deny-by-default.test.ts` requires each of these to refuse an
   * anonymous caller unless it is written down as public.
   */
  const routes: RouteRecord[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push({ method, url: route.url });
    }
  });
  app.decorate('routeTable', routes);

  // JSON API: lock the browser down completely (SR-X.14).
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  });

  /**
   * Permissions-Policy, which helmet does not set (SR-X.14).
   *
   * The web app has carried this since Phase 1; the API never did, and nobody noticed because
   * the API serves JSON — until `/docs`, which is a **page**, proxied under the web origin.
   * The nightly scan found it there. The same list as the web app, so a browser sees one
   * answer whichever half of the site served it.
   */
  app.addHook('onSend', async (_request, reply, payload) => {
    void reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    return payload;
  });

  /**
   * CORS for the public API only (SR-3.7).
   *
   * Any origin, `GET` only, **no credentials**. That combination is what makes a wildcard
   * origin safe: a page on another site can read public catalog data, and cannot make the
   * browser attach anyone's session cookie while doing it. Session-authenticated routes
   * carry no CORS headers at all, so a cross-origin page cannot call them even with
   * `credentials: 'include'`.
   */
  await app.register(cors, () => (request: FastifyRequest, callback: FastifyCorsCallback) => {
    // Per request, because the answer differs by path: only the documented public surface
    // is cross-origin readable. A session route gets no CORS headers at all, so a page on
    // another site cannot call it even with `credentials: 'include'`.
    callback(null, {
      // `'*'`, not `true`: `true` reflects whatever Origin was sent, which means the answer
      // varies by caller and a shared cache has to be told so. A genuinely public,
      // credential-less API can just say "anyone".
      origin: isPublicPath(request.url) ? '*' : false,
      methods: ['GET', 'HEAD', 'OPTIONS'],
      credentials: false,
      allowedHeaders: ['authorization', 'content-type', 'if-none-match'],
      exposedHeaders: ['etag', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'],
      maxAge: 86_400,
    });
  });

  // The kill switch the incident runbook promises (§22, ADR-039). Registered before the key
  // and quota plugins: a switched-off API should not spend a caller's quota telling them so.
  const flags = deps.flags ?? (deps.db ? createFlagReader(deps.db) : null);
  if (flags) {
    await app.register(killSwitchPlugin, {
      flags,
      // The public surface only. The console, auth and /healthz stay up, so an admin can sign
      // in and turn it back on — and so the orchestrator does not restart a container that is
      // being held closed on purpose.
      applies: (request) => isPublicPath(request.url),
    });
  }

  if (deps.keysDb) {
    const keysDb = deps.keysDb;
    await app.register(apiKeyPlugin, {
      keysDb,
      tokenPepper: config.TOKEN_PEPPER,
    });
    await app.register(quotaPlugin, {
      store: quotaStore,
      applies: (r) => isPublicPath(r.url),
      // The pool that verified the key counts the request, on the same narrow column grant
      // (migration 0040). The day is kept there so a restart cannot refill it; the minute
      // stays in memory, where losing it costs nothing worth having.
      consumeDay: (keyId) => consumeApiKeyQuota(keysDb, keyId),
    });
  }

  // In-memory limiter. Per-process, which is right for one instance and wrong for two; a
  // shared store is what a second one needs (SR-X.27, ADR-042). The per-day key quota does
  // not wait for that — it is in Postgres, because a restart was refilling it.
  // A refusal used to be answered and forgotten, so "this caller has been refused two
  // thousand times this hour" was not a fact anything could state (SR-X.22). Recorded only
  // when there is a pool to record it on, and throttled per caller so being refused cannot
  // become a way to write to the audit log at will.
  const rateLimitRecorder = deps.writeDb
    ? createRateLimitRecorder(deps.writeDb, {
        secret: config.BETTER_AUTH_SECRET,
        trustProxy: config.API_TRUST_PROXY,
      })
    : null;

  await app.register(rateLimit, {
    max: config.API_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    ...(rateLimitRecorder ? { onExceeded: rateLimitRecorder.onExceeded } : {}),
    // A request carrying a valid key is counted against that key's quota instead, which is
    // fairer (a whole office shares one address) and attributable (we know whose it was).
    // Boolean(), not `!== null`: when no key plugin is registered the property is undefined,
    // and `undefined !== null` would silently exempt every request from the IP limit.
    allowList: (request) => Boolean(request.apiKey),
  });
  // Conditional GETs for the public catalog (FR-3.6).
  await app.register(etag, { weak: true });

  /**
   * Which methods this path does answer, for the `Allow` header on a 405.
   *
   * Read from `routeTable` — the list this app already keeps of every route it registered —
   * rather than from Fastify's `hasRoute`, which compares the URL against registered
   * *patterns* and so says no for `/v1/cards/<a-real-id>` against `/v1/cards/:id`. That gap
   * is invisible on a path with no parameters, which is exactly how the first version of this
   * passed its own test and still failed the fuzzer on three routes.
   */
  function otherMethodsFor(instance: FastifyInstance, url: string): string[] {
    const path = url.split('?')[0] ?? url;
    const methods = new Set<string>();
    for (const route of instance.routeTable) {
      if (pathMatchesRoute(route.url, path)) methods.add(route.method.toUpperCase());
    }
    return [...methods].filter((m) => ALLOWABLE_METHODS.includes(m as never)).sort();
  }

  app.setNotFoundHandler((request, reply) => {
    // A path that exists, but not with this method, is 405 — and only under `/v1`, which is
    // the surface with a published document promising exactly which methods it has.
    //
    // Everywhere else keeps answering 404 on purpose: the disabled Better Auth endpoints are
    // meant to look absent rather than forbidden, because "forbidden" invites finding a way
    // round (ADR-026), and 405 would undo that. Under `/v1` there is nothing to conceal —
    // every method is in `/docs/openapi.json` — and a caller deserves to be told the
    // difference between "no such thing" and "not like that".
    const allowed = request.url.startsWith('/v1/') ? otherMethodsFor(app, request.url) : [];
    if (allowed.length > 0) {
      return reply
        .code(405)
        .header('allow', allowed.join(', '))
        .send({ error: 'method_not_allowed' });
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  app.setErrorHandler((error, request, reply) => {
    // A body-carrying method Fastify knows about — QUERY, say — is refused for a missing
    // content-type *before* routing, so it never reaches the not-found handler above and the
    // caller is told the wrong thing: that their header was wrong, when the truth is the
    // method does not exist here. Only when this path really has no route for that method.
    if (
      (error as { code?: string }).code === 'FST_ERR_ROUTE_MISSING_CONTENT_TYPE' &&
      request.url.startsWith('/v1/')
    ) {
      const allowed = otherMethodsFor(app, request.url);
      if (allowed.length > 0 && !allowed.includes(request.method.toUpperCase())) {
        return reply
          .code(405)
          .header('allow', allowed.join(', '))
          .send({ error: 'method_not_allowed' });
      }
    }
    // Authorization failures are expected outcomes, not server faults (SR-X.6).
    if (error instanceof ForbiddenError) {
      request.log.warn({ action: error.action, userId: request.subject?.userId }, 'forbidden');
      return reply.code(403).send({ error: 'forbidden' });
    }
    // Distinct from `forbidden` on purpose: this caller is allowed, just not with a session
    // this old. The client needs to know that the fix is "sign in again", not "give up".
    if (error instanceof StepUpRequiredError) {
      return reply
        .code(403)
        .header('cache-control', 'no-store')
        .send({ error: 'step_up_required', maxAgeSeconds: Math.floor(error.maxAgeMs / 1000) });
    }
    // Also distinct: the session is fine and recent, just not opened with a passkey. The fix
    // is "sign in with your passkey" — asking for another email link would loop forever.
    if (error instanceof PasskeyRequiredError) {
      return reply
        .code(403)
        .header('cache-control', 'no-store')
        .send({ error: 'passkey_required' });
    }
    // A rejected key is the caller's problem, not ours, and must never log the key itself.
    if (error instanceof ApiKeyError) {
      return reply.code(error.status).send({ error: error.message });
    }
    // A request naming a row that is not there. Handled here rather than at each call site
    // because it arrives the same way from every one of them: a page open in a tab while the
    // catalogue changed underneath it. Answered as 404 without a message — which row is
    // missing is the caller's own id echoed back, and 404 for both "gone" and "never yours"
    // is what keeps the two indistinguishable (SR-3.3).
    if (error instanceof MissingReferenceError) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const { status, code, message } = describeError(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      // Never leak internals (messages, stacks) on server errors.
      return reply.code(status).send({ error: 'internal_error' });
    }
    return reply.code(status).send({ error: code, message });
  });

  // Liveness: is the process up? Never touches dependencies.
  // `no-store` because a cached health check is a lie: a proxy could keep answering "ok"
  // for a process that has already fallen over.
  app.get('/healthz', { config: { rateLimit: false } }, (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ status: 'ok' }),
  );

  // Readiness: can we actually serve traffic? Postgres is the only dependency there is.
  app.get('/readyz', { config: { rateLimit: false } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!deps.db) return { status: 'ready', database: 'not_configured' };
    try {
      await pingDatabase(deps.db);
      return { status: 'ready', database: 'ok' };
    } catch (error) {
      request.log.error({ err: error }, 'readiness check failed');
      return reply.code(503).send({ status: 'unready', database: 'unavailable' });
    }
  });

  if (deps.auth) await app.register(authPlugin, { auth: deps.auth });

  if (deps.db) {
    // One definition of the public surface, used to register the routes and to generate the
    // document that describes them (FR-3.6).
    registerPublicRoutes(app, deps.db, publicRoutes);

    const spec = buildOpenApiDocument(publicRoutes, {
      title: 'Gundam TCG Hub API',
      version: '1.0.0',
      description:
        'An independent catalog and price index for the Gundam Card Game. ' +
        'Read-only, free, and documented. Prices are a trimmed median of observed sales; ' +
        'nothing is published below three observations.',
      serverUrl: config.API_BASE_URL,
      contactUrl: `${config.APP_BASE_URL}/about`,
      // The index is ours to license; attribution is the whole ask (open item O5).
      licenceName: 'CC BY 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    });

    app.get('/docs/openapi.json', (_request, reply) =>
      reply.header('cache-control', 'public, max-age=300').send(spec),
    );
    app.get('/docs', (_request, reply) =>
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'public, max-age=300')
        // The page carries no script of its own and loads nothing from anywhere else, so it
        // is served under the same locked-down policy as the rest of the API.
        .send(renderDocsPage(spec)),
    );
  }

  if (deps.writeDb) {
    // No session and no auth needed: the signature in the link is what identifies the watch
    // (SR-1.12). Mounted whenever there is a write pool, because an email that goes out with
    // an unsubscribe header the server cannot honour is worse than one without it.
    await registerUnsubscribeRoutes(app, {
      db: deps.writeDb,
      tokenPepper: config.TOKEN_PEPPER,
      watchesUrl: `${config.APP_BASE_URL}/account/watches`,
    });
  }

  // No session, deliberately: the signature is what authenticates this, and Stripe has no
  // cookie. It is mounted independently of `auth` for the same reason — a webhook endpoint
  // that only exists when sign-in is configured would be missing on exactly the deployment
  // that still takes payments.
  if (deps.stripeWebhook) {
    await registerStripeWebhookRoutes(app, deps.stripeWebhook);
  }

  if (deps.writeDb && deps.auth) {
    registerAccountRoutes(app, deps.writeDb);
    registerSessionRoutes(app, deps.writeDb);
    registerAccountDataRoutes(app, deps.writeDb, deps.notify);
    registerWatchRoutes(app, deps.writeDb);
    registerCollectionRoutes(app, deps.writeDb);
    registerProfileRoutes(app, deps.writeDb);
    registerMarketRoutes(app, deps.writeDb);
    /**
     * Shipping, cancelling and disputing (FR-5.4).
     *
     * Mounted whenever there is a session and a write pool, unlike checkout: an order that
     * already exists has to remain movable even on a deployment where Stripe has since been
     * unconfigured. A seller who cannot mark a paid order shipped because a key was rotated
     * is a seller whose buyer is waiting for nothing.
     */
    registerFulfilmentRoutes(app, { db: deps.writeDb });
    // Reputation (FR-5.7). Mounted with the rest of the session routes: a rating needs no
    // Stripe and no bucket, only a completed order — and the policy is what decides that.
    registerRatingRoutes(app, { db: deps.writeDb });
    if (deps.seller) registerSellerRoutes(app, deps.seller);
    if (deps.checkout) {
      registerCheckoutRoutes(app, { ...deps.checkout, ...(flags ? { flags } : {}) });
    }
    if (deps.photos) registerPhotoRoutes(app, deps.photos);
    if (deps.moderationDb) {
      registerAdminRoutes(app, {
        db: deps.writeDb,
        workerDb: deps.moderationDb,
        ...(flags ? { flags } : {}),
        // The refund route exists only when there is something to refund with. It is taken
        // from the checkout deps rather than configured twice: one Stripe client per process,
        // built from one key.
        ...(deps.checkout ? { stripe: deps.checkout.stripe } : {}),
      });
    }
    registerDeveloperRoutes(app, deps.writeDb, {
      tokenPepper: config.TOKEN_PEPPER,
      production: config.NODE_ENV === 'production',
    });
  }
  if (deps.liveSales) registerLiveSaleRoutes(app, deps.liveSales);
  if (deps.ingest) {
    registerIngestRoutes(app, { ...deps.ingest, ...(flags ? { flags } : {}) });
  }
  if (deps.breaks) registerBreakRoutes(app, deps.breaks);

  return app;
}
