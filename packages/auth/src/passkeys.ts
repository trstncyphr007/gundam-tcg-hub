import { decodeAttestationObject, parseAuthenticatorData } from '@simplewebauthn/server/helpers';

/**
 * Passkey policy (SR-X.3, SR-1.10, ADR-025).
 *
 * The Better Auth passkey plugin does the WebAuthn ceremony. What it does *not* do, as of
 * 1.7.4, is insist on **user verification**: both registration and sign-in are verified with
 * `requireUserVerification: false`, and the browser is only *asked* for it
 * (`userVerification: "preferred"`). A passkey that skipped its PIN or biometric is then just
 * something you have — one factor, not two — and an admin gate built on it would be MFA in
 * name only.
 *
 * So the UV flag is checked here, from the authenticator data in the request. That is safe to
 * read before the plugin runs because the authenticator **signs** that data: flip the UV bit
 * in transit and the plugin's own signature check rejects the request. Reading it early does
 * not trust the client; it refuses early what the signature would otherwise have let through
 * unexamined.
 */

export type AuthMethod = 'passkey' | 'magic_link' | 'discord';

export class PasskeyPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PasskeyPolicyError';
    this.code = code;
  }
}

interface Flags {
  up: boolean;
  uv: boolean;
}

function bytesFromBase64Url(value: unknown, field: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new PasskeyPolicyError('malformed_credential', `missing or oversized ${field}`);
  }
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) {
    throw new PasskeyPolicyError('malformed_credential', `${field} is not base64url`);
  }
  // Copied into a fresh buffer rather than viewed over Node's pool, so the parsers get an
  // array that owns exactly these bytes and nothing adjacent to them.
  const decoded = Buffer.from(value, 'base64url');
  const bytes = new Uint8Array(decoded.length);
  bytes.set(decoded);
  return bytes;
}

/** Flags from a sign-in assertion's `authenticatorData`. */
export function assertionFlags(authenticatorData: unknown): Flags {
  const bytes = bytesFromBase64Url(authenticatorData, 'authenticatorData');
  try {
    const { flags } = parseAuthenticatorData(bytes);
    return { up: flags.up, uv: flags.uv };
  } catch {
    throw new PasskeyPolicyError('malformed_credential', 'authenticatorData could not be parsed');
  }
}

/** Flags from a registration's `attestationObject` (CBOR, with authData inside). */
export function registrationFlags(attestationObject: unknown): Flags {
  const bytes = bytesFromBase64Url(attestationObject, 'attestationObject');
  try {
    const authData = decodeAttestationObject(bytes).get('authData');
    const { flags } = parseAuthenticatorData(authData);
    return { up: flags.up, uv: flags.uv };
  } catch {
    throw new PasskeyPolicyError('malformed_credential', 'attestationObject could not be parsed');
  }
}

/**
 * Refuse a ceremony without both presence and verification.
 *
 * UP (user present) says someone touched the device; UV (user verified) says it checked who —
 * a PIN, a fingerprint, a face. Only both together make a passkey a second factor.
 */
export function requireVerifiedUser(flags: Flags): void {
  if (!flags.up) {
    throw new PasskeyPolicyError(
      'user_presence_required',
      'the authenticator reported no user presence',
    );
  }
  if (!flags.uv) {
    throw new PasskeyPolicyError(
      'user_verification_required',
      'this passkey did not verify you (PIN, fingerprint or face) — it cannot be used here',
    );
  }
}

/**
 * Which way a session was opened, from the endpoint that opened it.
 *
 * Deliberately a closed list matched on exact paths. An endpoint added to Better Auth later
 * — a new sign-in method, a plugin — creates sessions this function does not recognise, and
 * those come out `null`: never mistaken for a passkey, which is the only answer that grants
 * anything.
 */
export function authMethodForPath(path: string | null | undefined): AuthMethod | null {
  if (path === '/passkey/verify-authentication') return 'passkey';
  if (path === '/magic-link/verify') return 'magic_link';
  if (typeof path === 'string' && path.startsWith('/callback/discord')) return 'discord';
  return null;
}
