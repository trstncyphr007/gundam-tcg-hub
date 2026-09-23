import { type Database, writeAuditLog } from '@gth/db';
import { hashIp } from '@gth/auth';
import type { FastifyRequest } from 'fastify';

/**
 * Remember that a caller was rate limited (SR-X.22).
 *
 * The limiter answers 429 and forgets, so "one address has been refused two thousand times
 * this hour" was not a fact anything could state. It is the difference between a busy client
 * and somebody grinding, and the plan asks for an alert on exactly that.
 *
 * **Throttled on purpose.** A row per refused request would let anyone who can be refused
 * write to the audit log as fast as they can send — an amplification, and a fast way to fill
 * a table that is deliberately hard to delete from. One row per caller per window instead,
 * carrying the count seen so far, which is the useful number anyway.
 */
export const RATE_LIMIT_ACTION = 'api.rate_limited';

/** How long one caller's refusals collapse into a single row. */
const WINDOW_MS = 10 * 60 * 1000;
/** A ceiling on what the throttle itself can hold, so it cannot be grown without limit. */
const MAX_TRACKED = 10_000;

interface Seen {
  at: number;
  count: number;
}

export interface RateLimitRecorder {
  onExceeded: (request: FastifyRequest, key: string) => void;
  /** Exposed for tests; the server never calls it. */
  reset: () => void;
}

export function createRateLimitRecorder(
  db: Database,
  config: { secret: string; trustProxy: boolean },
  now: () => number = Date.now,
): RateLimitRecorder {
  const seen = new Map<string, Seen>();

  return {
    onExceeded(request, key) {
      const at = now();
      const previous = seen.get(key);
      if (previous && at - previous.at < WINDOW_MS) {
        previous.count += 1;
        return;
      }

      // At the ceiling, drop the entry that has been there longest. A Map iterates in
      // insertion order, so that is the first key — O(1).
      //
      // This used to sweep the whole map for expired entries and then scan a copy of it to
      // find the oldest, on every refused request from a caller it had not just seen. Ten
      // thousand operations and an allocation, caused by one cheap request, in the component
      // whose entire job is to stop a refused request from costing anything. Writing the test
      // for the ceiling is what made it obvious.
      //
      // Stale entries are no longer swept: they are evicted in turn, and one that is revisited
      // is handled by the window check above. Full means "stop counting", never "stop
      // limiting" — the limiter does not consult any of this.
      if (seen.size >= MAX_TRACKED) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }

      const refusedSince = previous?.count ?? 0;
      seen.set(key, { at, count: 1 });

      // The key is the caller's address (or an API key id when one was used), so it is
      // hashed the same way sessions are rather than written down (ADR-028). An api key
      // prefix is not an address and hashes to null, which is fine: the audit row still says
      // a caller was refused, and the key's own quota records the rest.
      void writeAuditLog(db, {
        action: RATE_LIMIT_ACTION,
        targetType: 'request',
        targetId: request.routeOptions.url ?? request.url.split('?')[0] ?? null,
        ipHash: hashIp(config.trustProxy ? key : null, config.secret),
        diff: { refusedSincePreviousEntry: refusedSince },
      }).catch(() => undefined);
    },
    reset() {
      seen.clear();
    },
  };
}
