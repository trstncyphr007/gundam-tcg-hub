import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A link that proves what it refers to, without a session (SR-1.12, SR-X.17).
 *
 * An unsubscribe link has to work for somebody who is not signed in, has not been signed in for
 * months, and is clicking from a mail client that will not carry a cookie. It also has to be
 * unforgeable, because the thing on the other end of it acts on somebody's account.
 *
 * So the link carries the id and a signature over it, and nothing else: `<id>.<mac>`. Nothing
 * is stored — there is no row to look up, nothing to expire, and no table that grows with every
 * email sent. The pepper is the only secret, and rotating it invalidates every outstanding link
 * at once, which is the correct behaviour for a credential you cannot revoke individually.
 *
 * **The purpose is part of what is signed.** A signature over a bare id would let a link minted
 * for one action be presented for another, if a second signed link is ever added. Binding the
 * purpose costs nothing now and closes that door before it exists.
 *
 * Not a substitute for a session. These links identify *one* thing to do to *one* row, and the
 * endpoints that accept them must do no more than that.
 */
const SEPARATOR = '.';

function mac(purpose: string, id: string, pepper: string): string {
  if (pepper.length < 32) throw new RangeError('pepper must be at least 32 characters');
  return createHmac('sha256', pepper).update(`${purpose}:${id}`, 'utf8').digest('base64url');
}

/** `<id>.<signature>`, safe in a URL and in an email header. */
export function signLink(purpose: string, id: string, pepper: string): string {
  if (id.includes(SEPARATOR)) throw new RangeError('id must not contain a separator');
  return `${id}${SEPARATOR}${mac(purpose, id, pepper)}`;
}

/**
 * The id a signed link refers to, or null.
 *
 * Null for every kind of failure — missing, malformed, wrong purpose, bad signature — because
 * the caller has nothing useful to do with the difference and an endpoint that reported it
 * would be telling a stranger which of their guesses was closest.
 */
export function verifyLink(purpose: string, value: string, pepper: string): string | null {
  const cut = value.lastIndexOf(SEPARATOR);
  if (cut <= 0 || cut === value.length - 1) return null;
  const id = value.slice(0, cut);
  const presented = Buffer.from(value.slice(cut + 1), 'utf8');
  const expected = Buffer.from(mac(purpose, id, pepper), 'utf8');
  if (presented.length !== expected.length) return null;
  return timingSafeEqual(presented, expected) ? id : null;
}
