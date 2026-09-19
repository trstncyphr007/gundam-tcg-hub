import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiConfig } from './config.js';

/** Never log credentials or session material (SR-X.20). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

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

export async function buildApp(config: ApiConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : { level: config.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
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

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));

  app.setErrorHandler((error, request, reply) => {
    const { status, code, message } = describeError(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      // Never leak internals (messages, stacks) on server errors.
      return reply.code(status).send({ error: 'internal_error' });
    }
    return reply.code(status).send({ error: code, message });
  });

  app.get('/healthz', { config: { rateLimit: false } }, () => ({ status: 'ok' }));
  // Phase 1 adds dependency checks (Postgres, Valkey) here.
  app.get('/readyz', { config: { rateLimit: false } }, () => ({ status: 'ready' }));

  return app;
}
