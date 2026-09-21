import { describe, expect, it } from 'vitest';
import {
  type ChainedPull,
  GENESIS_HASH,
  SHUFFLE_ALGORITHM,
  canonicalise,
  commitmentFor,
  deriveShuffle,
  hashPull,
  verifyChain,
  verifyShuffle,
} from './fairness.js';

const SERVER_SEED = 'a'.repeat(64);
const CLIENT_SEED = 'block-hash-882341';
const BREAK_ID = '11111111-2222-3333-4444-555555555555';

describe('the commitment (FR-4.2)', () => {
  it('is sha256 of the seed — a fixed, checkable value', async () => {
    // Known answer. Anyone can confirm it: `printf 'a%.0s' {1..64} | sha256sum`.
    // If this line ever changes, so has the meaning of every commitment we have published.
    await expect(commitmentFor('a'.repeat(64))).resolves.toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    );
  });

  it('reveals nothing: one character changes the whole thing', async () => {
    const a = await commitmentFor('a'.repeat(64));
    const b = await commitmentFor(`${'a'.repeat(63)}b`);
    expect(a).not.toBe(b);
    // Avalanche: they should differ in most positions, not just the last character.
    let differing = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a.charAt(i) !== b.charAt(i)) differing += 1;
    }
    expect(differing).toBeGreaterThan(40);
  });
});

describe('the shuffle (FR-4.2, AC-4.1)', () => {
  it('is a permutation, not a sample', async () => {
    const order = await deriveShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      count: 24,
    });
    expect(order).toHaveLength(24);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it('is deterministic — the known answer this whole scheme rests on', async () => {
    const once = await deriveShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      count: 12,
    });
    const twice = await deriveShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      count: 12,
    });
    expect(once).toEqual(twice);

    // Pinned. A change here means a break verified last month no longer verifies, which is
    // only ever acceptable alongside a bump to SHUFFLE_ALGORITHM.
    expect(SHUFFLE_ALGORITHM).toBe('v1');
    expect(once).toEqual([9, 4, 5, 3, 1, 7, 11, 2, 10, 0, 6, 8]);
  });

  it.each([
    ['a different server seed', { serverSeed: 'b'.repeat(64) }],
    ['a different client seed', { clientSeed: 'something-else' }],
    ['a different break', { breakId: '99999999-2222-3333-4444-555555555555' }],
  ])('changes completely with %s', async (_label, override) => {
    const base = { serverSeed: SERVER_SEED, clientSeed: CLIENT_SEED, breakId: BREAK_ID, count: 20 };
    const a = await deriveShuffle(base);
    const b = await deriveShuffle({ ...base, ...override });
    expect(a).not.toEqual(b);
  });

  it('includes the break id, so one pair of seeds cannot be replayed', async () => {
    // Without this, somebody who watched break A could predict break B from the same seeds.
    const a = await deriveShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: 'break-a',
      count: 16,
    });
    const b = await deriveShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: 'break-b',
      count: 16,
    });
    expect(a).not.toEqual(b);
  });

  it('handles the degenerate sizes without special-casing', async () => {
    const one = await deriveShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      count: 1,
    });
    expect(one).toEqual([0]);
  });

  it.each([0, -1, 1.5])('refuses a count of %s', async (count) => {
    await expect(
      deriveShuffle({
        serverSeed: SERVER_SEED,
        clientSeed: CLIENT_SEED,
        breakId: BREAK_ID,
        count,
      }),
    ).rejects.toThrow();
  });

  it('is close to uniform', async () => {
    // Not a proof of fairness — a smoke test that the rejection sampling is not obviously
    // skewed. Where does slot 0 land across many seeds?
    const counts = new Array<number>(8).fill(0);
    for (let i = 0; i < 400; i += 1) {
      const order = await deriveShuffle({
        serverSeed: `seed-${String(i)}`,
        clientSeed: CLIENT_SEED,
        breakId: BREAK_ID,
        count: 8,
      });
      counts[order.indexOf(0)] = (counts[order.indexOf(0)] ?? 0) + 1;
    }
    // 400 draws over 8 positions: 50 each on average. Loose bounds — this catches a broken
    // generator, not a subtle bias, and pretending otherwise would be false comfort.
    for (const count of counts) {
      expect(count).toBeGreaterThan(20);
      expect(count).toBeLessThan(90);
    }
  });
});

describe('verifying a published result (AC-4.1)', () => {
  it('accepts the real thing', async () => {
    const order = await deriveShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      count: 10,
    });
    const result = await verifyShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      commitment: await commitmentFor(SERVER_SEED),
      claimedOrder: order,
    });
    expect(result).toEqual({ valid: true, commitmentMatches: true, orderMatches: true });
  });

  it('catches a seed swapped after the fact — the failure that matters', async () => {
    // A seed chosen *after* seeing the outcome is the whole thing commit–reveal exists to
    // prevent. The published commitment will not match it.
    const order = await deriveShuffle({
      serverSeed: 'b'.repeat(64),
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      count: 10,
    });
    const result = await verifyShuffle({
      serverSeed: 'b'.repeat(64),
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      commitment: await commitmentFor(SERVER_SEED), // committed to a different seed
      claimedOrder: order,
    });
    expect(result.commitmentMatches).toBe(false);
    expect(result.valid).toBe(false);
    // The order is internally consistent; only the commitment gives it away.
    expect(result.orderMatches).toBe(true);
  });

  it('catches a doctored order', async () => {
    const order = await deriveShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      count: 10,
    });
    const doctored = [...order];
    [doctored[0], doctored[1]] = [doctored[1] as number, doctored[0] as number];

    const result = await verifyShuffle({
      serverSeed: SERVER_SEED,
      clientSeed: CLIENT_SEED,
      breakId: BREAK_ID,
      commitment: await commitmentFor(SERVER_SEED),
      claimedOrder: doctored,
    });
    expect(result.commitmentMatches).toBe(true);
    expect(result.orderMatches).toBe(false);
    expect(result.valid).toBe(false);
  });
});

describe('the pull-log hash chain (SR-4.1, AC-4.2)', () => {
  const pull = (seq: number, value: number): ChainedPull => ({
    seq,
    cardVariantId: null,
    label: `Card ${String(seq)}`,
    valueCentsAtPull: value,
    valueSource: 'manual',
    pulledAt: `2026-09-21T10:0${String(seq)}:00.000Z`,
  });

  async function chainOf(pulls: ChainedPull[]) {
    const rows: (ChainedPull & { prevHash: string; rowHash: string })[] = [];
    let prev = GENESIS_HASH;
    for (const p of pulls) {
      const rowHash = await hashPull(prev, p);
      rows.push({ ...p, prevHash: prev, rowHash });
      prev = rowHash;
    }
    return rows;
  }

  it('canonicalises regardless of key order', () => {
    // Two servers building the same row in a different order must hash it identically, or a
    // valid chain reads as tampered with.
    const a: ChainedPull = {
      seq: 1,
      cardVariantId: null,
      label: 'x',
      valueCentsAtPull: 5,
      valueSource: 'manual',
      pulledAt: '2026-09-21T10:00:00.000Z',
    };
    const b = {
      pulledAt: '2026-09-21T10:00:00.000Z',
      valueSource: 'manual',
      valueCentsAtPull: 5,
      label: 'x',
      cardVariantId: null,
      seq: 1,
    } as ChainedPull;
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it('produces a fixed first hash — checkable by hand', async () => {
    // sha256(GENESIS_HASH ‖ canonical(row)). Pinned so a change to the canonical form, the
    // fields committed to, or the genesis value cannot slip through unnoticed.
    await expect(hashPull(GENESIS_HASH, pull(1, 100))).resolves.toBe(
      '92b7be44f88d4cafa621e3fc8c9b0b42f4847e84bbc510ed53c72aa36e5b98c9',
    );
  });

  it('verifies an untouched chain', async () => {
    const rows = await chainOf([pull(1, 100), pull(2, 250), pull(3, 900)]);
    await expect(verifyChain(rows)).resolves.toEqual({ valid: true, brokenAtSeq: null });
  });

  it('names the pull where a value was edited', async () => {
    const rows = await chainOf([pull(1, 100), pull(2, 250), pull(3, 900)]);
    // Somebody inflates pull 2 after the fact.
    const tampered = rows.map((r) => (r.seq === 2 ? { ...r, valueCentsAtPull: 99_900 } : r));
    await expect(verifyChain(tampered)).resolves.toEqual({ valid: false, brokenAtSeq: 2 });
  });

  it('catches a pull removed from the middle', async () => {
    const rows = await chainOf([pull(1, 100), pull(2, 250), pull(3, 900)]);
    const missing = [rows[0], rows[2]].filter((r) => r !== undefined);
    await expect(verifyChain(missing)).resolves.toEqual({ valid: false, brokenAtSeq: 3 });
  });

  it('catches a chain that does not start at the beginning', async () => {
    const rows = await chainOf([pull(1, 100), pull(2, 250)]);
    await expect(verifyChain(rows.slice(1))).resolves.toEqual({ valid: false, brokenAtSeq: 2 });
  });

  it('is empty-safe', async () => {
    await expect(verifyChain([])).resolves.toEqual({ valid: true, brokenAtSeq: null });
  });
});
