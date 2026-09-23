import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { logUrl } from './log-url.js';
import { loadConfig } from './config.js';

/**
 * Nothing that opens an account may be written to a log (SR-X.20, SR-X.23, SR-2.2).
 *
 * The overlay token was thought about: it sits in the path, and `logUrl` masks it. The **query
 * string was not**, and that is where the more dangerous one travels —
 * `/api/auth/magic-link/verify?token=…` carries a single-use credential good for fifteen
 * minutes and a whole account. It was being written out in full, on every sign-in.
 *
 * A log is not a private place. It goes to a shipper, a dashboard, a support bundle, a
 * screen-share, and it outlives the fifteen minutes by months.
 */
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what reaches the log', () => {
  it('never writes a magic-link token, even though it rides in the URL', async () => {
    // The real pipeline, not the helper: pino, the serializer, the stream. A helper that is
    // correct but not wired in would pass a narrower test and leak in production.
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const app = await buildApp(config, {});
    try {
      await app.inject({
        method: 'GET',
        url: '/api/auth/magic-link/verify?token=SUPERSECRETMAGICLINKTOKEN&callbackURL=%2Fx',
      });
    } finally {
      await app.close();
    }

    const log = written.join('');
    expect(log).not.toContain('SUPERSECRETMAGICLINKTOKEN');
    // The path is still there: knowing that somebody tried to verify a link is the whole
    // point of the line, and is not a secret.
    expect(log).toContain('/api/auth/magic-link/verify');
  });
});

describe('logUrl', () => {
  it('drops the query string entirely', () => {
    expect(logUrl('/api/auth/magic-link/verify?token=abc123&callbackURL=/x')).toBe(
      '/api/auth/magic-link/verify?[REDACTED]',
    );
  });

  it('keeps a URL that has no query string untouched', () => {
    expect(logUrl('/v1/cards')).toBe('/v1/cards');
  });

  it('still masks an overlay token in the path', () => {
    expect(logUrl('/v1/overlay/abcdef123456')).toBe('/v1/overlay/[REDACTED]');
    expect(logUrl('/v1/overlay/abcdef123456/stream')).toBe('/v1/overlay/[REDACTED]/stream');
  });

  it('masks the token and drops the query when a URL has both', () => {
    expect(logUrl('/v1/overlay/abcdef123456/stream?since=4')).toBe(
      '/v1/overlay/[REDACTED]/stream?[REDACTED]',
    );
  });

  it('says a query was present rather than hiding that fact', () => {
    // "?[REDACTED]" and not silence: a request with parameters and one without are different
    // events, and someone reading a log to work out what happened needs to tell them apart.
    expect(logUrl('/v1/cards?q=zaku')).toBe('/v1/cards?[REDACTED]');
  });
});
