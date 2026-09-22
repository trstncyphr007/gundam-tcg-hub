import { randomUUID } from 'node:crypto';
import cors, { type FastifyCorsOptions } from '@fastify/cors';
import etag from '@fastify/etag';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Auth, SecurityNotice } from '@gth/auth';
import { ForbiddenError, PasskeyRequiredError, StepUpRequiredError } from '@gth/auth';
import { type Database, pingDatabase } from '@gth/db';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { ApiConfig } from './config.js';
import { ApiKeyError, apiKeyPlugin } from './plugins/api-key.js';
import { authPlugin } from './plugins/auth.js';
import { QuotaStore, quotaPlugin } from './plugins/quota.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAccountDataRoutes } from './routes/account-data.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerDeveloperRoutes } from './routes/developer.js';
import { type BreakDeps, registerBreakRoutes } from './routes/breaks.js';
import { registerCollectionRoutes } from './routes/collections.js';
import { type IngestDeps, registerIngestRoutes } from './routes/ingest.js';
import { type LiveSaleDeps, registerLiveSaleRoutes } from './routes/live-sales.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerWatchRoutes } from './routes/watches.js';
import { renderDocsPage } from './v1/docs.js';
import { buildOpenApiDocument } from './v1/openapi.js';
import { registerPublicRoutes } from './v1/registry.js';
import { publicRoutes } from './v1/routes.js';

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
}

/** Never log credentials or session material (SR-X.20). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/**
 * An overlay token lives in the URL path, so ordinary request logging would write it to
 * disk — and a creator screen-sharing their logs would leak a live overlay (SR-2.2).
 * pino's `redact` only reaches object paths, so the URL is masked here instead.
 */
export function maskOverlayToken(url: string): string {
  return url.replace(/(\/v1\/overlay\/)[^/?#]+/, '$1[REDACTED]');
}

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
                url: maskOverlayToken(request.url),
              }),
            },
          },
    trustProxy: config.API_TRUST_PROXY,
    genReqId: () => randomUUID(),
    bodyLimit: 1_048_576,
    requestTimeout: 15_000,
  });

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

  if (deps.keysDb) {
    await app.register(apiKeyPlugin, {
      keysDb: deps.keysDb,
      tokenPepper: config.TOKEN_PEPPER,
    });
    await app.register(quotaPlugin, { store: quotaStore, applies: (r) => isPublicPath(r.url) });
  }

  // In-memory limiter for now; moves to Valkey when there is more than one instance (SR-X.27).
  await app.register(rateLimit, {
    max: config.API_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    // A request carrying a valid key is counted against that key's quota instead, which is
    // fairer (a whole office shares one address) and attributable (we know whose it was).
    // Boolean(), not `!== null`: when no key plugin is registered the property is undefined,
    // and `undefined !== null` would silently exempt every request from the IP limit.
    allowList: (request) => Boolean(request.apiKey),
  });
  // Conditional GETs for the public catalog (FR-3.6).
  await app.register(etag, { weak: true });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));

  app.setErrorHandler((error, request, reply) => {
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

  // Readiness: can we actually serve traffic? Checks dependencies (Valkey follows in Phase 1).
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

  if (deps.writeDb && deps.auth) {
    registerAccountRoutes(app, deps.writeDb);
    registerSessionRoutes(app, deps.writeDb);
    registerAccountDataRoutes(app, deps.writeDb, deps.notify);
    registerWatchRoutes(app, deps.writeDb);
    registerCollectionRoutes(app, deps.writeDb);
    registerProfileRoutes(app, deps.writeDb);
    if (deps.moderationDb) {
      registerAdminRoutes(app, { db: deps.writeDb, workerDb: deps.moderationDb });
    }
    registerDeveloperRoutes(app, deps.writeDb, {
      tokenPepper: config.TOKEN_PEPPER,
      production: config.NODE_ENV === 'production',
    });
  }
  if (deps.liveSales) registerLiveSaleRoutes(app, deps.liveSales);
  if (deps.ingest) registerIngestRoutes(app, deps.ingest);
  if (deps.breaks) registerBreakRoutes(app, deps.breaks);

  return app;
}
