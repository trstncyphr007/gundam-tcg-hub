import { describe, expect, it } from 'vitest';
import { IP_HASH_PATTERN, hashIp, normalizeIp } from './ip-hash.js';

const SECRET = 'test-secret-at-least-32-characters-long';
const MONDAY = new Date('2026-09-21T09:00:00Z');
const MONDAY_LATE = new Date('2026-09-21T23:59:59Z');
const TUESDAY = new Date('2026-09-22T00:00:01Z');

describe('hashIp (SR-X.24, ADR-028)', () => {
  it('stores a fixed-format value that contains no part of the address', () => {
    const hash = String(hashIp('198.51.100.23', SECRET, MONDAY));
    expect(hash).toMatch(IP_HASH_PATTERN);
    expect(hash).not.toContain('198');
    expect(hash).not.toContain('100.23');
  });

  it('matches the same address within a day, so "same network" can still be seen', () => {
    expect(hashIp('198.51.100.23', SECRET, MONDAY)).toBe(
      hashIp('198.51.100.23', SECRET, MONDAY_LATE),
    );
  });

  it('does not match across days, so nothing can be followed from one day to the next', () => {
    const monday = String(hashIp('198.51.100.23', SECRET, MONDAY))
      .split(':')
      .at(-1);
    const tuesday = String(hashIp('198.51.100.23', SECRET, TUESDAY))
      .split(':')
      .at(-1);
    expect(monday).not.toBe(tuesday);
  });

  it('tells different addresses apart', () => {
    expect(hashIp('198.51.100.23', SECRET, MONDAY)).not.toBe(
      hashIp('198.51.100.24', SECRET, MONDAY),
    );
  });

  it('depends on the server secret, so a database copy alone cannot be reversed', () => {
    expect(hashIp('198.51.100.23', SECRET, MONDAY)).not.toBe(
      hashIp('198.51.100.23', `${SECRET}-other`, MONDAY),
    );
  });

  it('treats one address as one address, however it is spelled', () => {
    expect(hashIp('::ffff:198.51.100.23', SECRET, MONDAY)).toBe(
      hashIp('198.51.100.23', SECRET, MONDAY),
    );
    expect(hashIp('2001:DB8::1', SECRET, MONDAY)).toBe(hashIp('2001:db8::1', SECRET, MONDAY));
    expect(hashIp(' 198.51.100.23 ', SECRET, MONDAY)).toBe(hashIp('198.51.100.23', SECRET, MONDAY));
  });

  it('stores nothing rather than a hash of something that is not an address', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'unknown',
      '198.51.100.23, 10.0.0.1',
      'x'.repeat(500),
    ]) {
      expect(hashIp(raw, SECRET, MONDAY), String(raw)).toBeNull();
    }
  });
});

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6 but leaves real IPv6 alone', () => {
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIp('::ffff:0:1')).toBe('::ffff:0:1');
  });
});
