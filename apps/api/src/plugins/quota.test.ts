import { describe, expect, it } from 'vitest';
import { FREE_TIER, QuotaStore, decide } from './quota.js';

/**
 * The published allowance for a public API key (FR-3.7, SR-3.2).
 *
 * The interesting property is not that 1,001 requests are refused -- it is *which* of the two
 * windows remembers across a restart, and which one is allowed to forget.
 */
const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 24, 10, 0, 0);

const counts = (minute: number, day: number, minuteResetAt = START + MINUTE) => ({
  minute,
  day,
  minuteResetAt,
});

describe('deciding on a request against a key quota', () => {
  it('allows a request inside both windows', () => {
    const decision = decide(counts(1, 1), FREE_TIER, 1, START);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(59);
  });

  it('refuses the request past the minute', () => {
    expect(decide(counts(61, 61), FREE_TIER, 61, START).allowed).toBe(false);
  });

  it('refuses the request past the day', () => {
    const decision = decide(counts(1, 1), FREE_TIER, 1001, START);
    expect(decision.allowed).toBe(false);
    expect(decision.limit).toBe(FREE_TIER.perDay);
  });

  it('believes the database over its own memory', () => {
    // The whole point. This process has served one request; the key spent its allowance
    // before this process started. Memory alone would let it straight through, which is
    // exactly what a restart used to do.
    expect(decide(counts(1, 1), FREE_TIER, 1001, START).allowed).toBe(false);

    // And the boundary is where it is published to be: the thousandth request is the last
    // allowed one, not the first refused one.
    const last = decide(counts(1, 1), FREE_TIER, 1000, START);
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);
  });

  it('still enforces a floor when the database cannot answer', () => {
    // No durable count. What this process has seen is all there is, and it is still a limit:
    // bookkeeping being unavailable must not mean no quota at all.
    expect(decide(counts(1, 1001), FREE_TIER, null, START).allowed).toBe(false);
    expect(decide(counts(1, 5), FREE_TIER, null, START).allowed).toBe(true);
  });

  it('reports whichever limit will actually stop the caller', () => {
    // Nowhere near the day, one away from the minute: a client reading the headers should be
    // told about the minute, because that is the one it is about to hit.
    const nearMinute = decide(counts(59, 59), FREE_TIER, 59, START);
    expect(nearMinute.limit).toBe(FREE_TIER.perMinute);
    expect(nearMinute.resetSeconds).toBe(60);

    // Plenty of minute left, nearly out of day: now the day is the honest answer, and it
    // resets at midnight UTC rather than 24 hours after some forgotten first call.
    const nearDay = decide(counts(1, 999), FREE_TIER, 999, START);
    expect(nearDay.limit).toBe(FREE_TIER.perDay);
    expect(nearDay.resetSeconds).toBe(14 * 60 * 60);
  });

  it('never reports a negative allowance', () => {
    expect(decide(counts(90, 90), FREE_TIER, 90, START).remaining).toBe(0);
  });
});

describe('the in-memory windows', () => {
  it('counts each key separately', () => {
    const store = new QuotaStore();
    store.count('a', START);
    store.count('a', START);
    expect(store.count('b', START).minute).toBe(1);
    expect(store.count('a', START).minute).toBe(3);
  });

  it('rolls the minute over without touching the day', () => {
    const store = new QuotaStore();
    store.count('a', START);
    const later = store.count('a', START + MINUTE + 1);
    expect(later.minute).toBe(1);
    // The day is the same day; only the short window came round.
    expect(later.day).toBe(2);
  });

  it('forgets a key that has gone quiet', () => {
    const store = new QuotaStore();
    store.count('a', START);
    store.sweep(START + 2 * 86_400_000);
    // Nothing observable except that the next call starts from one, which is the point: an
    // idle key must not cost memory for ever.
    expect(store.count('a', START + 2 * 86_400_000).minute).toBe(1);
  });
});
