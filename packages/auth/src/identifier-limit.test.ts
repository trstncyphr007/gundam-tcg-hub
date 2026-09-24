import { describe, expect, it } from 'vitest';
import { createIdentifierLimiter, keyFor } from './identifier-limit.js';

/**
 * The per-address half of SR-1.9, which the plan promised and nothing enforced.
 *
 * The interesting cases are not "does it count to five". They are the ones where a naive
 * counter becomes a weapon: an attacker naming endless addresses to exhaust memory, and an
 * attacker using the limit itself to lock everybody out.
 */
describe('how often one address may be asked for a sign-in link', () => {
  const at = (start = 0) => {
    let clock = start;
    return { now: () => clock, advance: (ms: number) => (clock += ms) };
  };

  it('allows the allowance and refuses the one after it', () => {
    const clock = at();
    const limiter = createIdentifierLimiter({ max: 5, windowMs: 60_000, now: clock.now });

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.take('pilot@example.test'), `request ${String(i + 1)}`).toBe(true);
    }
    expect(limiter.take('pilot@example.test')).toBe(false);
  });

  it('counts one address, not everybody', () => {
    const clock = at();
    const limiter = createIdentifierLimiter({ max: 2, windowMs: 60_000, now: clock.now });

    expect(limiter.take('one@example.test')).toBe(true);
    expect(limiter.take('one@example.test')).toBe(true);
    expect(limiter.take('one@example.test')).toBe(false);
    // Somebody else's sign-in is not collateral damage.
    expect(limiter.take('two@example.test')).toBe(true);
  });

  it('treats the same address written differently as the same address', () => {
    const clock = at();
    const limiter = createIdentifierLimiter({ max: 1, windowMs: 60_000, now: clock.now });

    expect(limiter.take('Pilot@Example.test')).toBe(true);
    expect(limiter.take('  pilot@example.test  ')).toBe(false);
  });

  it('forgets when the window has passed', () => {
    const clock = at();
    const limiter = createIdentifierLimiter({ max: 1, windowMs: 60_000, now: clock.now });

    expect(limiter.take('pilot@example.test')).toBe(true);
    expect(limiter.take('pilot@example.test')).toBe(false);
    clock.advance(60_001);
    expect(limiter.take('pilot@example.test')).toBe(true);
  });

  it('does not grow without limit when an attacker names endless addresses', () => {
    const limiter = createIdentifierLimiter({ max: 5, windowMs: 60_000, maxEntries: 50 });

    for (let i = 0; i < 5_000; i += 1) limiter.take(`flood-${String(i)}@example.test`);

    expect(limiter.size()).toBeLessThanOrEqual(50);
  });

  it('keeps letting people sign in when it is full, rather than refusing everyone', () => {
    // The trade that decides the design. Refusing while full would let one attacker deny
    // sign-in to every user in the system — a limiter that becomes the outage it exists to
    // prevent. A diluted limit is the lesser failure, and it is chosen, not accidental.
    const limiter = createIdentifierLimiter({ max: 5, windowMs: 60_000, maxEntries: 10 });

    for (let i = 0; i < 1_000; i += 1) limiter.take(`flood-${String(i)}@example.test`);

    expect(limiter.take('somebody-real@example.test')).toBe(true);
  });

  it('counts an address without keeping it', () => {
    // A table of addresses in memory is a table of addresses somebody can read out of a core
    // dump. The counter never needs the plaintext, so it never has it — ADR-037's reasoning,
    // applied to the second place addresses could otherwise accumulate.
    //
    // Asserted on the key function, because what is *absent* from a closure cannot be checked
    // through its public surface: a test that stringified the limiter would pass whatever the
    // map held.
    const key = keyFor('private-address@example.test');

    expect(key).not.toContain('private-address');
    expect(key).not.toContain('example.test');
    // Still a stable key, or the counter would count nothing.
    expect(keyFor('Private-Address@Example.test ')).toBe(key);
    expect(keyFor('someone-else@example.test')).not.toBe(key);
  });
});
