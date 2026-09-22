import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * IP addresses at rest, as salted hashes with a daily-rotating salt (SR-X.24, ADR-028).
 *
 * The plan's rule: an IP address is personal data, so it is kept only as long as it is
 * useful and only in a form that cannot be reversed. Sessions record where a sign-in came
 * from for one reason — so the owner, or someone reviewing an incident, can tell that two
 * sign-ins on the same day came from the same network. A hash under that day's key answers
 * exactly that and nothing more:
 *
 *  - the same address on the same day hashes the same, so same-day comparison still works;
 *  - on another day it hashes differently, so there is no way to follow an address, or a
 *    person, across days — which is the part of an IP log that makes it a tracking log;
 *  - the key is derived from the server secret, so a database copy on its own cannot be
 *    brute-forced back to addresses (all of IPv4 is only four billion guesses otherwise).
 *
 * The day is part of the stored value because a reader has to know which values may be
 * compared. It says nothing the session's own `created_at` does not.
 */
export const IP_HASH_PREFIX = 'iph1';

/** One stored form: `iph1:<day>:<22 base64url chars>` — 128 bits is plenty to not collide. */
export const IP_HASH_PATTERN = /^iph1:\d{4}-\d{2}-\d{2}:[A-Za-z0-9_-]{22}$/;

/**
 * One spelling per address. An IPv4 address that arrives as IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
 * is the same address, and IPv6 is case-insensitive; without this, one network would hash to
 * several values and "same network" would quietly stop matching.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) === 0 ? null : ip;
}

export function hashIp(
  raw: string | null | undefined,
  secret: string,
  now: Date = new Date(),
): string | null {
  const ip = normalizeIp(raw);
  if (ip === null) return null;
  const day = now.toISOString().slice(0, 10);
  // A separate key per day, derived rather than stored: nothing to rotate by hand, and
  // yesterday's key cannot be recovered from today's.
  const dayKey = createHmac('sha256', secret).update(`gth:ip-hash:v1:${day}`).digest();
  const digest = createHmac('sha256', dayKey)
    .update(ip)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
  return `${IP_HASH_PREFIX}:${day}:${digest}`;
}
