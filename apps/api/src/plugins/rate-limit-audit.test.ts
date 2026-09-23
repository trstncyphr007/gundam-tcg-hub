import type { Database } from '@gth/db';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_ACTION, createRateLimitRecorder } from './rate-limit-audit.js';

/**
 * The throttle in front of the audit log (SR-X.22, ADR-037).
 *
 * This is the part that stops "you were refused" from becoming a way to write to the audit
 * log at will: being rate limited is, by definition, something a caller can cause as fast as
 * they can send. The logic is small and entirely about limits, which is exactly the kind of
 * code that is easy to leave untested and expensive to get wrong.
 */
interface Written {
  action: string;
  targetId: string | null;
  ipHash: string | null;
  diff: unknown;
}

/** A database that remembers what would have been written, and nothing else. */
function recordingDb(): { db: Database; rows: Written[] } {
  const rows: Written[] = [];
  const db = {
    insert: () => ({
      values: (row: Written) => {
        rows.push(row);
        return Promise.resolve();
      },
    }),
  } as unknown as Database;
  return { db, rows };
}

const request = (url = '/v1/cards'): FastifyRequest =>
  ({ routeOptions: { url }, url }) as unknown as FastifyRequest;

const config = { secret: 'test-secret-at-least-32-characters-long', trustProxy: true };

/** Lets a test move time without waiting for it. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms) => (value += ms) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A distinct caller per number, so a test can make as many as it needs. */
const caller = (n: number): string => `10.0.${String(n % 250)}.${String(n)}`;

describe('recording that a caller was refused', () => {
  it('writes the first refusal, and not the next one', async () => {
    const { db, rows } = recordingDb();
    const time = clock();
    const recorder = createRateLimitRecorder(db, config, time.now);

    recorder.onExceeded(request(), '198.18.0.1');
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe(RATE_LIMIT_ACTION);

    for (let i = 0; i < 50; i += 1) recorder.onExceeded(request(), '198.18.0.1');
    await settle();
    // Fifty more refusals, still one row: the point of the throttle.
    expect(rows).toHaveLength(1);
  });

  it('writes again after the window, carrying how many it stood for', async () => {
    const { db, rows } = recordingDb();
    const time = clock();
    const recorder = createRateLimitRecorder(db, config, time.now);

    recorder.onExceeded(request(), '198.18.0.2');
    for (let i = 0; i < 9; i += 1) recorder.onExceeded(request(), '198.18.0.2');
    await settle();

    time.advance(10 * 60 * 1000 + 1);
    recorder.onExceeded(request(), '198.18.0.2');
    await settle();

    expect(rows).toHaveLength(2);
    // The second row says the nine in between happened, which is the number worth having.
    expect(rows[1]?.diff).toMatchObject({ refusedSincePreviousEntry: 10 });
  });

  it('counts different callers separately', async () => {
    const { db, rows } = recordingDb();
    const recorder = createRateLimitRecorder(db, config, clock().now);

    recorder.onExceeded(request(), '198.18.0.3');
    recorder.onExceeded(request(), '198.18.0.4');
    await settle();
    expect(rows).toHaveLength(2);
  });

  it('records the address as a hash, never as an address', async () => {
    const { db, rows } = recordingDb();
    const recorder = createRateLimitRecorder(db, config, clock().now);

    recorder.onExceeded(request(), '198.18.0.5');
    await settle();
    expect(rows[0]?.ipHash).toMatch(/^iph1:\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(rows[0])).not.toContain('198.18.0.5');
  });

  it('records no source at all when the proxy header cannot be believed', async () => {
    const { db, rows } = recordingDb();
    // Off the proxy, the key is whatever the caller's connection says; hashing it would
    // record a fact we do not have (ADR-028).
    const recorder = createRateLimitRecorder(db, { ...config, trustProxy: false }, clock().now);

    recorder.onExceeded(request(), '198.18.0.6');
    await settle();
    expect(rows[0]?.ipHash).toBeNull();
  });

  it('remembers the route, not the query string', async () => {
    const { db, rows } = recordingDb();
    const recorder = createRateLimitRecorder(db, config, clock().now);

    recorder.onExceeded(request('/v1/cards'), '198.18.0.7');
    await settle();
    expect(rows[0]?.targetId).toBe('/v1/cards');
  });

  it('cannot be grown without limit by a caller who keeps changing address', async () => {
    const { db, rows } = recordingDb();
    const time = clock();
    const recorder = createRateLimitRecorder(db, config, time.now);

    // Twelve thousand distinct callers, against a ceiling of ten thousand. A refused request
    // must not be a way to make the server allocate for ever.
    for (let i = 0; i < 12_000; i += 1) recorder.onExceeded(request(), caller(i));
    await settle();
    expect(rows.length).toBe(12_000);

    // The ceiling is on what is *remembered*, and the limiter itself never depends on it:
    // every caller above still got its refusal recorded.
    time.advance(10 * 60 * 1000 + 1);
    recorder.onExceeded(request(), '198.18.0.1');
    await settle();
    expect(rows.length).toBe(12_001);
  });

  it('costs the same whether it is empty or full', () => {
    // The point of the ceiling is bounded memory; the point of *this* is bounded work. An
    // earlier version scanned the whole map on each miss, so a flood of distinct addresses
    // made every cheap refused request cost ten thousand operations — amplification, inside
    // the guard against amplification.
    const { db } = recordingDb();
    const recorder = createRateLimitRecorder(db, config, clock().now);

    const time = (from: number, to: number): number => {
      const started = performance.now();
      for (let i = from; i < to; i += 1) recorder.onExceeded(request(), caller(i));
      return performance.now() - started;
    };

    const whenEmpty = time(0, 2_000);
    time(2_000, 12_000); // fill past the ceiling
    const whenFull = time(12_000, 14_000);

    // Generous: this is a shape check, not a benchmark. The old implementation was orders of
    // magnitude worse, not fifteen times.
    expect(whenFull).toBeLessThan(Math.max(whenEmpty, 1) * 15);
  });
});
