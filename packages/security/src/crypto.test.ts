import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, buildKeyRing, decryptField, encryptField, keyIdOf } from './crypto.js';

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');
const ring = buildKeyRing(JSON.stringify({ k1: keyA }), 'k1');

describe('field encryption (SR-1.6, SR-4.2)', () => {
  it('round-trips', () => {
    const secret = 'a'.repeat(64);
    expect(decryptField(ring, encryptField(ring, secret))).toBe(secret);
  });

  it('never produces the same ciphertext twice', () => {
    // A fresh IV each time. Otherwise two breaks with the same seed would be visibly the
    // same in the database, which leaks exactly what this is protecting.
    const a = encryptField(ring, 'same input');
    const b = encryptField(ring, 'same input');
    expect(a).not.toBe(b);
    expect(decryptField(ring, a)).toBe(decryptField(ring, b));
  });

  it('does not leak the plaintext into the encoding', () => {
    const encrypted = encryptField(ring, 'gundam-barbatos-lupus-rex');
    expect(encrypted).not.toContain('gundam');
    expect(encrypted).not.toContain('barbatos');
  });

  it('refuses a ciphertext that has been altered', () => {
    // GCM's whole point: an edited ciphertext fails, rather than decrypting to something
    // else that the application then believes.
    const encrypted = encryptField(ring, 'the real seed');
    const parts = encrypted.split(':');
    const data = Buffer.from(String(parts[4]), 'base64url');
    data[0] = (data[0] ?? 0) ^ 0xff;
    parts[4] = data.toString('base64url');

    expect(() => decryptField(ring, parts.join(':'))).toThrow(DecryptionError);
  });

  it('refuses a truncated authentication tag', () => {
    // Node will verify a shorter tag if you let it, and a short tag is far easier to forge.
    // The length is pinned when the cipher is created and checked before it is used, so an
    // attacker does not get to choose how much authentication happens.
    const parts = encryptField(ring, 'the real seed').split(':');
    const tag = Buffer.from(String(parts[3]), 'base64url');
    parts[3] = tag.subarray(0, 8).toString('base64url');
    expect(() => decryptField(ring, parts.join(':'))).toThrow(DecryptionError);
  });

  it('refuses an initialisation vector of the wrong length', () => {
    const parts = encryptField(ring, 'the real seed').split(':');
    parts[2] = Buffer.alloc(8).toString('base64url');
    expect(() => decryptField(ring, parts.join(':'))).toThrow(DecryptionError);
  });

  it('refuses a swapped authentication tag', () => {
    const a = encryptField(ring, 'seed one').split(':');
    const b = encryptField(ring, 'seed two').split(':');
    a[3] = String(b[3]);
    expect(() => decryptField(ring, a.join(':'))).toThrow(DecryptionError);
  });

  it.each([
    ['empty', ''],
    ['not our format', 'just-a-string'],
    ['wrong version', 'v9:k1:aa:bb:cc'],
    ['too few parts', 'v1:k1:aa:bb'],
  ])('refuses a %s value', (_label, value) => {
    expect(() => decryptField(ring, value)).toThrow(DecryptionError);
  });

  it('says the same thing however it failed', () => {
    // Wrong key, tampered data and malformed input must be indistinguishable: a specific
    // error message is an oracle telling an attacker which of the three they managed.
    const other = buildKeyRing(JSON.stringify({ k1: keyB }), 'k1');
    const messages = new Set<string>();
    for (const attempt of [
      () => decryptField(other, encryptField(ring, 'x')),
      () => decryptField(ring, 'v1:k1:aa:bb:cc'),
      () => decryptField(ring, 'nonsense'),
    ]) {
      try {
        attempt();
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });
});

describe('key rotation (SR-X.18)', () => {
  it('reads a value written by an older key', () => {
    const old = buildKeyRing(JSON.stringify({ k1: keyA }), 'k1');
    const encrypted = encryptField(old, 'written under k1');

    // k2 is now active; k1 is kept so old rows still open.
    const rotated = buildKeyRing(JSON.stringify({ k1: keyA, k2: keyB }), 'k2');
    expect(decryptField(rotated, encrypted)).toBe('written under k1');
    // ...and new writes use the new key.
    expect(keyIdOf(encryptField(rotated, 'fresh'))).toBe('k2');
  });

  it('exposes which key wrote a value, so a rotation job can find stragglers', () => {
    expect(keyIdOf(encryptField(ring, 'x'))).toBe('k1');
    expect(keyIdOf('not-a-ciphertext')).toBeNull();
  });

  it('cannot read a value whose key has been retired', () => {
    const encrypted = encryptField(ring, 'written under k1');
    const withoutK1 = buildKeyRing(JSON.stringify({ k2: keyB }), 'k2');
    expect(() => decryptField(withoutK1, encrypted)).toThrow(DecryptionError);
  });
});

describe('building the key ring', () => {
  it.each([
    ['not JSON', 'nope', 'k1'],
    ['an array', '[]', 'k1'],
    ['an empty object', '{}', 'k1'],
    ['a key that is too short', JSON.stringify({ k1: Buffer.alloc(16).toString('base64') }), 'k1'],
    ['an unsafe key id', JSON.stringify({ 'k 1': keyA }), 'k 1'],
    ['an active kid that is absent', JSON.stringify({ k1: keyA }), 'k2'],
  ])('refuses %s', (_label, json, kid) => {
    // Fail at boot, loudly, rather than at the first break of the evening.
    expect(() => buildKeyRing(json, kid)).toThrow();
  });

  it('accepts a well-formed ring', () => {
    const built = buildKeyRing(JSON.stringify({ k1: keyA, k2: keyB }), 'k2');
    expect(built.activeKid).toBe('k2');
    expect(built.keys.size).toBe(2);
  });
});
