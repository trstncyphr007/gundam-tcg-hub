import { createHash } from 'node:crypto';

/**
 * How often one *address* may be asked for a sign-in link (SR-1.9).
 *
 * The plan has promised "10 per minute per IP **and 5 per minute per account identifier**"
 * since it was written. Only the first half existed: better-auth's limiter keys on the client
 * address, so the per-identifier half was never enforced anywhere.
 *
 * What that leaves open is not really about our accounts. Anyone who can rotate source
 * addresses could point the sign-in form at *somebody else's* inbox and have us deliver, from
 * our domain, as many emails as they liked. The victim is the person whose address was typed,
 * and the cost is our deliverability and a spam complaint we would deserve.
 *
 * ## Choices worth knowing about
 *
 * **Keyed by a hash of the address**, never the address. The counter has no need for the
 * plaintext, and a table of addresses in memory is a table of addresses somebody could read
 * out of a core dump. This matches ADR-037, which keeps addresses out of the failure log for
 * the same reason.
 *
 * **Bounded, and it fails open when full.** Somebody naming a million addresses must not grow
 * this without limit. Expired entries are swept first; if the map is still at its cap the
 * oldest is dropped. That means a flood can dilute the limit — and the alternative, refusing
 * when full, would let one attacker lock every user out of signing in. A weakened limit beats
 * a self-inflicted outage.
 *
 * **In process memory**, like every other limit here since Valkey was removed (ADR-042). Per
 * instance, reset by a deploy. Said plainly rather than implied to be more.
 */
export interface IdentifierLimiter {
  /** True if this request is within the allowance. False means refuse it. */
  take: (identifier: string) => boolean;
  /** Entries currently held. For tests and for anyone wondering what this costs. */
  size: () => number;
}

export interface IdentifierLimitOptions {
  /** Requests allowed per window for one identifier. */
  max?: number;
  windowMs?: number;
  /** Most identifiers tracked at once. Beyond this the oldest is dropped. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Same address, different spelling, same counter — and the counter never holds the address.
 *
 * Exported so that last part is testable: a claim about what is *not* in memory cannot be
 * checked through the public surface of a closure.
 */
export function keyFor(identifier: string): string {
  return createHash('sha256').update(identifier.trim().toLowerCase()).digest('base64');
}

export function createIdentifierLimiter(options: IdentifierLimitOptions = {}): IdentifierLimiter {
  const { max = 5, windowMs = 60_000, maxEntries = 10_000, now = Date.now } = options;
  const seen = new Map<string, { count: number; resetAt: number }>();

  const sweep = (at: number): void => {
    for (const [key, entry] of seen) if (entry.resetAt <= at) seen.delete(key);
  };

  return {
    take: (identifier) => {
      const at = now();
      const key = keyFor(identifier);
      const entry = seen.get(key);

      if (entry && entry.resetAt > at) {
        if (entry.count >= max) return false;
        entry.count += 1;
        return true;
      }

      if (seen.size >= maxEntries) {
        sweep(at);
        // Map iteration is insertion-ordered, so the first key is the oldest.
        if (seen.size >= maxEntries) {
          const oldest = seen.keys().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
      }
      seen.set(key, { count: 1, resetAt: at + windowMs });
      return true;
    },
    size: () => seen.size,
  };
}
