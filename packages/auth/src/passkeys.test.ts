import { describe, expect, it } from 'vitest';
import {
  PasskeyPolicyError,
  assertionFlags,
  authMethodForPath,
  requireVerifiedUser,
} from './passkeys.js';

/**
 * WebAuthn authenticator data: 32 bytes of RP ID hash, 1 byte of flags, 4 bytes of counter.
 * Bit 0 is user presence (UP), bit 2 is user verification (UV).
 */
function authenticatorData(flags: number, counter = 1): string {
  const bytes = new Uint8Array(37);
  bytes.fill(0xab, 0, 32);
  bytes[32] = flags;
  new DataView(bytes.buffer).setUint32(33, counter);
  return Buffer.from(bytes).toString('base64url');
}

const UP = 0x01;
const UV = 0x04;

describe('assertionFlags', () => {
  it('reads presence and verification from the flags byte', () => {
    expect(assertionFlags(authenticatorData(UP | UV))).toEqual({ up: true, uv: true });
    expect(assertionFlags(authenticatorData(UP))).toEqual({ up: true, uv: false });
    expect(assertionFlags(authenticatorData(0))).toEqual({ up: false, uv: false });
  });

  it.each([
    ['nothing', undefined],
    ['an empty string', ''],
    ['not base64url', 'not base64url!!'],
    ['a number', 42],
    ['too short to hold flags', Buffer.from([1, 2, 3]).toString('base64url')],
  ])('refuses %s rather than guessing', (_label, value) => {
    expect(() => assertionFlags(value)).toThrow(PasskeyPolicyError);
  });

  it('refuses an oversized value before parsing it', () => {
    expect(() => assertionFlags('A'.repeat(20_000))).toThrow(PasskeyPolicyError);
  });
});

describe('requireVerifiedUser (SR-1.10)', () => {
  it('passes presence plus verification', () => {
    expect(() => {
      requireVerifiedUser({ up: true, uv: true });
    }).not.toThrow();
  });

  it('refuses a passkey that did not verify the person', () => {
    // A tap without a PIN or biometric is something you have and nothing else — one factor.
    try {
      requireVerifiedUser({ up: true, uv: false });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PasskeyPolicyError);
      expect((error as PasskeyPolicyError).code).toBe('user_verification_required');
    }
  });

  it('refuses one with no user presence at all', () => {
    expect(() => {
      requireVerifiedUser({ up: false, uv: true });
    }).toThrow(/presence/);
  });
});

describe('authMethodForPath', () => {
  it.each([
    ['/passkey/verify-authentication', 'passkey'],
    ['/magic-link/verify', 'magic_link'],
    ['/callback/discord', 'discord'],
  ] as const)('maps %s to %s', (path, method) => {
    expect(authMethodForPath(path)).toBe(method);
  });

  it.each([
    '/passkey/verify-registration', // registering a passkey is not signing in with one
    '/sign-in/magic-link', // requesting a link creates no session
    '/passkey/verify-authentication/extra',
    '/some-future-plugin/sign-in',
    '',
    null,
    undefined,
  ])('does not recognise %s — and never as a passkey', (path) => {
    expect(authMethodForPath(path)).toBeNull();
  });
});
