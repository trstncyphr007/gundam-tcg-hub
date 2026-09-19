import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MIN_TOKEN_BYTES = 16;
const MIN_PEPPER_LENGTH = 32;

/**
 * Generate an unguessable bearer token (overlay tokens, API key secrets, magic links).
 * Returned once to the user; only its hash is stored (SR-2.1, SR-3.1, SR-X.17).
 */
export function generateToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < MIN_TOKEN_BYTES) {
    throw new RangeError(`token must be an integer of at least ${String(MIN_TOKEN_BYTES)} bytes`);
  }
  return randomBytes(bytes).toString('base64url');
}

/** Keyed hash for storing tokens at rest: HMAC-SHA256 with a server-side pepper. */
export function hashToken(token: string, pepper: string): string {
  if (pepper.length < MIN_PEPPER_LENGTH) {
    throw new RangeError(`pepper must be at least ${String(MIN_PEPPER_LENGTH)} characters`);
  }
  return createHmac('sha256', pepper).update(token, 'utf8').digest('hex');
}

/** Constant-time string comparison (for equal-length inputs). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Check a presented token against a stored hash without timing leaks. */
export function verifyToken(token: string, storedHash: string, pepper: string): boolean {
  return safeEqual(hashToken(token, pepper), storedHash);
}
