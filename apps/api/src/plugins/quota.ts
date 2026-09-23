import { secondsUntilUtcMidnight } from '@gth/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Per-key quotas for the public API (FR-3.7, SR-3.2).
 *
 * The global limiter counts requests per IP, which is the right unit for anonymous traffic
 * and the wrong one for a key: a developer behind one address and a developer behind twenty
 * should get the same allowance, and both should be attributable.
 *
 * ## Two windows, two homes
 *
 * This file used to keep both in memory and say they would move to a shared store "the day a
 * second API container exists". That trigger is right for *sharing* a limit and wrong for
 * *keeping* one, and the difference matters more than it sounds:
 *
 *  - **The minute is a rate limit.** Losing it on restart costs at most one minute of burst
 *    control, which nobody can plan around. Memory is the right home, and being in memory is
 *    what makes it free to check.
 *  - **The day is an accounting fact.** "1,000 requests per day" that resets whenever the
 *    process does is not a daily quota -- it is a per-deploy quota, and deploys are frequent
 *    and attacker-observable. It belongs in the database, and now lives there.
 *
 * The order is also the design. The minute window is checked first and entirely in memory, so
 * the durable counter can never be asked more than `perMinute` times per key per minute: the
 * cheap limit is what protects the expensive one.
 */
export interface QuotaTier {
  perMinute: number;
  perDay: number;
}

/** The only tier today. Named, because a second one should be a table entry, not a branch. */
export const FREE_TIER: QuotaTier = { perMinute: 60, perDay: 1000 };

export const TIERS = new Map<string, QuotaTier>([['free', FREE_TIER]]);

interface Window {
  count: number;
  resetAt: number;
}

export interface QuotaDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the exhausted window rolls over. */
  resetSeconds: number;
}

/**
 * The minute window, plus a day counter kept only as a floor.
 *
 * Fixed windows, not a sliding log. A sliding window is fairer at the boundary and costs a
 * timestamp per request per key; at these volumes the unfairness is a rounding error and the
 * memory is not, so the simpler thing wins until there is evidence otherwise.
 */
export class QuotaStore {
  private readonly minute = new Map<string, Window>();
  private readonly day = new Map<string, Window>();

  /** Counts one request in both windows and returns the running totals. */
  count(keyId: string, now = Date.now()): { minute: number; day: number; minuteResetAt: number } {
    const minute = bump(this.minute, keyId, now, 60_000);
    const day = bump(this.day, keyId, now, 86_400_000);
    return { minute: minute.count, day: day.count, minuteResetAt: minute.resetAt };
  }

  /** Drops windows that have rolled over, so an idle key costs nothing to remember. */
  sweep(now = Date.now()): void {
    for (const store of [this.minute, this.day]) {
      for (const [key, window] of store) {
        if (window.resetAt <= now) store.delete(key);
      }
    }
  }

  reset(): void {
    this.minute.clear();
    this.day.clear();
  }
}

function bump(store: Map<string, Window>, key: string, now: number, span: number): Window {
  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + span };
    store.set(key, fresh);
    return fresh;
  }
  existing.count += 1;
  return existing;
}

/**
 * Turn two counts into an answer and the headers that explain it.
 *
 * `durableDay` is the database's count, or null when it could not answer. The day total is the
 * larger of it and the in-process count, which needs no branch on failure and is correct in
 * both directions: with the database up its count always leads, and with it down the process
 * still enforces a floor rather than nothing at all.
 */
export function decide(
  counts: { minute: number; day: number; minuteResetAt: number },
  tier: QuotaTier,
  durableDay: number | null,
  now = Date.now(),
): QuotaDecision {
  const dayUsed = Math.max(durableDay ?? 0, counts.day);
  const minuteLeft = tier.perMinute - counts.minute;
  const dayLeft = tier.perDay - dayUsed;

  // Report against whichever allowance is closest to running out, so a client watching the
  // headers sees the limit that will actually stop it.
  const tightest =
    minuteLeft <= dayLeft
      ? {
          limit: tier.perMinute,
          remaining: minuteLeft,
          resetSeconds: Math.max(1, Math.ceil((counts.minuteResetAt - now) / 1000)),
        }
      : {
          limit: tier.perDay,
          remaining: dayLeft,
          resetSeconds: secondsUntilUtcMidnight(new Date(now)),
        };

  return {
    allowed: minuteLeft >= 0 && dayLeft >= 0,
    limit: tightest.limit,
    remaining: Math.max(0, tightest.remaining),
    resetSeconds: tightest.resetSeconds,
  };
}

function applyHeaders(reply: FastifyReply, decision: QuotaDecision): void {
  // RateLimit-* per the IETF draft, which is what developer tooling reads.
  void reply.header('ratelimit-limit', String(decision.limit));
  void reply.header('ratelimit-remaining', String(decision.remaining));
  void reply.header('ratelimit-reset', String(decision.resetSeconds));
}

export interface QuotaDeps {
  store: QuotaStore;
  /** Which requests the quota applies to. Everything else is left to the IP limiter. */
  applies: (request: FastifyRequest) => boolean;
  /**
   * Counts one request against the durable day and returns the new total.
   *
   * Optional so an app built without a key pool still limits by the minute. A rejected
   * promise is treated as "no answer": bookkeeping that is unavailable must not become an
   * outage, and the in-process floor is still in force.
   */
  consumeDay?: (keyId: string) => Promise<number | null>;
}

const quotaPluginImpl: FastifyPluginAsync<QuotaDeps> = (app, deps) => {
  const sweeper = setInterval(() => {
    deps.store.sweep();
  }, 60_000);
  // Without unref the timer keeps the process alive, and every test that builds an app hangs.
  sweeper.unref();
  app.addHook('onClose', () => {
    clearInterval(sweeper);
  });

  app.addHook('onRequest', async (request, reply) => {
    const key = request.apiKey;
    if (!key || !deps.applies(request)) return undefined;

    const tier = TIERS.get(key.tier) ?? FREE_TIER;
    const counts = deps.store.count(key.id);

    // The minute first, from memory. A caller who is already over it is refused without the
    // database being touched, which is both the cheap answer and the thing that bounds how
    // often the durable counter can be written.
    if (counts.minute > tier.perMinute) {
      return refuse(reply, decide(counts, tier, null));
    }

    const durableDay = deps.consumeDay
      ? await deps.consumeDay(key.id).catch(() => {
          request.log.warn({ keyId: key.id }, 'daily quota not counted');
          return null;
        })
      : null;

    const decision = decide(counts, tier, durableDay);
    applyHeaders(reply, decision);
    if (decision.allowed) return undefined;
    return refuse(reply, decision);
  });

  return Promise.resolve();
};

function refuse(reply: FastifyReply, decision: QuotaDecision): FastifyReply {
  applyHeaders(reply, decision);
  return reply
    .code(429)
    .header('retry-after', String(decision.resetSeconds))
    .send({ error: 'quota_exceeded', retryAfterSeconds: decision.resetSeconds });
}

export const quotaPlugin = fp(quotaPluginImpl, { name: 'gth-quota' });
