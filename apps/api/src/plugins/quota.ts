import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Per-key quotas for the public API (FR-3.7, SR-3.2).
 *
 * The global limiter counts requests per IP, which is the right unit for anonymous traffic
 * and the wrong one for a key: a developer behind one address and a developer behind twenty
 * should get the same allowance, and both should be attributable.
 *
 * In memory, like the IP limiter it sits beside. That is honest for one instance and wrong
 * for two, so the trigger is written down rather than discovered: **this moves to Valkey the
 * day a second API container exists**, because two processes each granting the full quota is
 * not a quota. The interface below is deliberately the shape a Valkey implementation would
 * have, so that change is a swap and not a rewrite.
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
 * Fixed windows, not a sliding log.
 *
 * A sliding window is fairer at the boundary and costs a timestamp per request per key. At
 * 1,000 requests a day per key the unfairness is a rounding error and the memory is not, so
 * the simpler thing wins until there is evidence otherwise.
 */
export class QuotaStore {
  private readonly minute = new Map<string, Window>();
  private readonly day = new Map<string, Window>();

  /** Counts one request and says whether it may proceed. */
  consume(keyId: string, tier: QuotaTier, now = Date.now()): QuotaDecision {
    const minute = bump(this.minute, keyId, now, 60_000);
    const day = bump(this.day, keyId, now, 86_400_000);

    // Report against whichever allowance is closest to running out, so a client watching the
    // headers sees the limit that will actually stop it.
    const minuteLeft = tier.perMinute - minute.count;
    const dayLeft = tier.perDay - day.count;
    const tightest =
      minuteLeft <= dayLeft
        ? { limit: tier.perMinute, remaining: minuteLeft, resetAt: minute.resetAt }
        : { limit: tier.perDay, remaining: dayLeft, resetAt: day.resetAt };

    return {
      allowed: minuteLeft >= 0 && dayLeft >= 0,
      limit: tightest.limit,
      remaining: Math.max(0, tightest.remaining),
      resetSeconds: Math.max(1, Math.ceil((tightest.resetAt - now) / 1000)),
    };
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
    const decision = deps.store.consume(key.id, tier);
    applyHeaders(reply, decision);
    if (decision.allowed) return undefined;

    return reply
      .code(429)
      .header('retry-after', String(decision.resetSeconds))
      .send({ error: 'quota_exceeded', retryAfterSeconds: decision.resetSeconds });
  });

  return Promise.resolve();
};

export const quotaPlugin = fp(quotaPluginImpl, { name: 'gth-quota' });
