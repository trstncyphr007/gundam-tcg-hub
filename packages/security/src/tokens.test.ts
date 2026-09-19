import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, safeEqual, verifyToken } from './tokens.js';

const pepper = 'p'.repeat(32);

describe('generateToken', () => {
  it('produces url-safe tokens of the requested entropy', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken()));
    expect(tokens.size).toBe(1000);
  });

  it('refuses weak or invalid sizes', () => {
    expect(() => generateToken(8)).toThrow(RangeError);
    expect(() => generateToken(16.5)).toThrow(RangeError);
  });
});

describe('hashToken / verifyToken', () => {
  it('is deterministic for the same pepper and differs across peppers', () => {
    const token = generateToken();
    expect(hashToken(token, pepper)).toBe(hashToken(token, pepper));
    expect(hashToken(token, pepper)).not.toBe(hashToken(token, 'q'.repeat(32)));
    expect(hashToken(token, pepper)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not contain the token', () => {
    const token = generateToken();
    expect(hashToken(token, pepper)).not.toContain(token);
  });

  it('rejects a short pepper', () => {
    expect(() => hashToken('t', 'short')).toThrow(RangeError);
  });

  it('verifies the right token and rejects others', () => {
    const token = generateToken();
    const stored = hashToken(token, pepper);
    expect(verifyToken(token, stored, pepper)).toBe(true);
    expect(verifyToken(generateToken(), stored, pepper)).toBe(false);
    expect(verifyToken(token, stored.slice(1), pepper)).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
