/**
 * Where to send someone after they sign in (SR-X.13).
 *
 * A `?next=` parameter is the classic open redirect: a link to our sign-in page that bounces
 * a freshly authenticated user to a lookalike site, which then asks them to "confirm" their
 * details. So the only thing accepted is a path on this origin, and everything else falls
 * back to a fixed page rather than being "cleaned up" — a sanitiser that tries to rescue a
 * hostile value is a sanitiser with a bypass nobody has found yet.
 */

export const DEFAULT_AFTER_SIGN_IN = '/account/watches';

export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return DEFAULT_AFTER_SIGN_IN;

  // Must be a rooted path. `//evil.test` and `/\evil.test` are both rooted *and* read by
  // browsers as scheme-relative URLs to another host, so they are refused by name.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return DEFAULT_AFTER_SIGN_IN;
  }
  // Control characters and backslashes anywhere: browsers normalise some of them away and
  // turn a harmless-looking path into a host.
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f\\]/u.test(raw)) return DEFAULT_AFTER_SIGN_IN;

  // Final check, by the same parser the browser will use: resolved against our own origin,
  // it must still be our own origin.
  const base = 'https://gth.invalid';
  try {
    const resolved = new URL(raw, base);
    if (resolved.origin !== base) return DEFAULT_AFTER_SIGN_IN;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return DEFAULT_AFTER_SIGN_IN;
  }
}
