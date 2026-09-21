import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for database fields (SR-1.6, SR-4.2, SR-X.17, SR-X.18).
 *
 * Built for one job at first: a break's server seed, which must be unpredictable until the
 * break ends and must stay unpredictable in a database backup, on a disk that gets
 * decommissioned, or in a dump someone emails themselves.
 *
 * AES-256-GCM, so a ciphertext that has been edited fails to decrypt rather than decrypting
 * to something else. Keys carry an id, so they can be rotated: new writes use the active
 * key, old values keep decrypting with the key that wrote them, and nothing has to be
 * re-encrypted in a hurry.
 *
 * Node's `crypto` rather than Web Crypto here, unlike `@gth/core/fairness`: this never runs
 * in a browser, and it never should — the key is a server secret.
 */

/** `v1:<kid>:<iv>:<tag>:<ciphertext>`, all base64url. Self-describing on purpose. */
const FORMAT = 'v1';
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const KEY_BYTES = 32;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export interface KeyRing {
  /** Key id → 32 raw bytes. */
  keys: Map<string, Buffer>;
  /** The key new writes use. Must be present in `keys`. */
  activeKid: string;
}

/**
 * Build a key ring from the environment.
 *
 * `DATA_ENCRYPTION_KEYS` is `{"kid": "<base64 32 bytes>"}` and
 * `DATA_ENCRYPTION_ACTIVE_KID` names the one to write with. Both are validated here rather
 * than at the call site, because a half-configured key ring should fail at boot and not at
 * the first break of the evening.
 */
export function buildKeyRing(keysJson: string, activeKid: string): KeyRing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(keysJson);
  } catch {
    throw new Error('DATA_ENCRYPTION_KEYS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('DATA_ENCRYPTION_KEYS must be an object of {kid: base64key}');
  }

  const keys = new Map<string, Buffer>();
  for (const [kid, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`key ${kid} is not a string`);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(kid)) throw new Error(`key id ${kid} is not a safe id`);
    const raw = Buffer.from(value, 'base64');
    if (raw.length !== KEY_BYTES) {
      throw new Error(
        `key ${kid} is ${String(raw.length)} bytes; AES-256 needs ${String(KEY_BYTES)}`,
      );
    }
    keys.set(kid, raw);
  }

  if (keys.size === 0) throw new Error('DATA_ENCRYPTION_KEYS is empty');
  if (!keys.has(activeKid)) {
    throw new Error(`DATA_ENCRYPTION_ACTIVE_KID "${activeKid}" is not in DATA_ENCRYPTION_KEYS`);
  }
  return { keys, activeKid };
}

/** Encrypt with the active key. The key id travels with the ciphertext so rotation works. */
export function encryptField(ring: KeyRing, plaintext: string): string {
  const key = ring.keys.get(ring.activeKid);
  if (!key) throw new Error('active key missing from the key ring');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT,
    ring.activeKid,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypt, with the key the ciphertext names.
 *
 * Every failure is the same `DecryptionError`: a wrong key, a tampered ciphertext and a
 * malformed value are indistinguishable to the caller on purpose, so error handling cannot
 * become an oracle that tells an attacker which of the three they achieved.
 */
export function decryptField(ring: KeyRing, encoded: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 5 || parts[0] !== FORMAT) {
    throw new DecryptionError('could not decrypt');
  }
  const [, kid, ivPart, tagPart, dataPart] = parts;

  const key = ring.keys.get(String(kid));
  if (!key) throw new DecryptionError('could not decrypt');

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(ivPart), 'base64url'));
    decipher.setAuthTag(Buffer.from(String(tagPart), 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(String(dataPart), 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM's tag check lands here when anything at all has been altered.
    throw new DecryptionError('could not decrypt');
  }
}

/** Which key wrote a value, without decrypting it. For a rotation job to find stragglers. */
export function keyIdOf(encoded: string): string | null {
  const parts = encoded.split(':');
  return parts.length === 5 && parts[0] === FORMAT ? (parts[1] ?? null) : null;
}
