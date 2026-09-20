import { randomUUID } from 'node:crypto';
import etag from '@fastify/etag';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Auth } from '@gth/auth';
import { ForbiddenError } from '@gth/auth';
import { type Database, pingDatabase } from '@gth/db';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiConfig } from './config.js';
import { authPlugin } from './plugins/auth.js';
import { registerAccountRoutes } from './routes/account.js';
import { type BreakDeps, registerBreakRoutes } from './routes/breaks.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { type IngestDeps, registerIngestRoutes } from './routes/ingest.js';
import { registerWatchRoutes } from './routes/watches.js';

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

  // In-memory limiter for now; moves to Valkey when there is more than one instance (SR-X.27).
  await app.register(rateLimit, { max: config.API_RATE_LIMIT_MAX, timeWindow: '1 minute' });
  // Conditional GETs for the public catalog (FR-3.6).
  await app.register(etag, { weak: true });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));

  app.setErrorHandler((error, request, reply) => {
    // Authorization failures are expected outcomes, not server faults (SR-X.6).
    if (error instanceof ForbiddenError) {
      request.log.warn({ action: error.action, userId: request.subject?.userId }, 'forbidden');
      return reply.code(403).send({ error: 'forbidden' });
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
  if (deps.db) registerCatalogRoutes(app, deps.db);
  if (deps.writeDb && deps.auth) {
    registerAccountRoutes(app, deps.writeDb);
    registerWatchRoutes(app, deps.writeDb);
  }
  if (deps.ingest) registerIngestRoutes(app, deps.ingest);
  if (deps.breaks) registerBreakRoutes(app, deps.breaks);

  return app;
}
