/**
 * The most a request's URL may contribute to a log line (SR-X.20, SR-X.23, SR-2.2).
 *
 * Two different credentials travel in a URL, and only one of them had been thought about.
 *
 *  - **The path.** An overlay token is a path segment, so a creator screen-sharing their logs
 *    would leak a live overlay. That case was already masked.
 *  - **The query string.** `/api/auth/magic-link/verify?token=…` carries a single-use
 *    credential good for fifteen minutes and an entire account — and it was being written out
 *    in full, on every sign-in. A log is not a private place: it goes to a shipper, a
 *    dashboard, a support bundle, a screen-share, and it outlives those fifteen minutes by
 *    months.
 *
 * So the query goes, all of it, rather than a list of parameter names we think are dangerous
 * today — the next secret parameter would not be on that list, and nobody would notice. What
 * is lost is a search term and a cursor, neither of which the plan asked to keep: SR-X.20
 * wants the **route**, and a search term is the user's own words, which is its own reason not
 * to write it down.
 *
 * `?[REDACTED]` rather than silence, because a request with parameters and one without are
 * different events and a reader needs to tell them apart.
 *
 * Its own module because pino's `redact` only reaches object paths, so this runs as a
 * serializer in `app.ts` — and the API-key plugin needs it too, which from inside `app.ts`
 * would have been a cycle.
 */
export function logUrl(url: string): string {
  const [path = '', ...query] = url.split('?');
  const masked = path.replace(/(\/v1\/overlay\/)[^/?#]+/, '$1[REDACTED]');
  return query.length > 0 ? `${masked}?[REDACTED]` : masked;
}
