import { type Database, schema } from '@gth/db';
import { hashIp } from './ip-hash.js';

/**
 * Writing down the attempts that did **not** work (SR-X.21, SR-X.22).
 *
 * Until now the audit log recorded successes only — sessions created, passkeys added — with
 * the stated reason that "a refused request changed nothing worth reporting". True of a
 * mistyped link. Not true of two hundred of them: the shape of the failures is the only thing
 * that distinguishes somebody working through a list of addresses from somebody fumbling
 * their own. SR-X.22 asks for an alert on a spike in failed logins, and there was nothing to
 * count.
 *
 * What a row holds, and deliberately does not:
 *
 *  - **No email address, ever.** Not even hashed. "This address was tried" is precisely the
 *    account-enumeration answer the auth endpoints are built to withhold (SR-X.4), and an
 *    audit log readable by an admin is a worse place to keep it than the attempt itself.
 *  - **The source as that day's hash**, the same form sessions use (ADR-028). Enough to say
 *    "one source, many attempts" within a day; nothing that survives to the next.
 *  - **The endpoint and a short reason code** — never the error message, which can carry
 *    whatever the caller sent.
 */
export const AUTH_FAILURE_ACTION = 'auth.sign_in_failed';
export const AUTH_RATE_LIMIT_ACTION = 'auth.rate_limited';

/** The ways in. A failure anywhere else is a mistake, not an attempt on an account. */
const WATCHED_PREFIXES = [
  '/sign-in/',
  '/magic-link/verify',
  '/passkey/verify-authentication',
  '/callback/',
] as const;

export function isAuthAttemptPath(path: string): boolean {
  return WATCHED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * The client address, only where it can be believed. Behind our own proxy the first
 * X-Forwarded-For entry is the client; anywhere else the header is whatever the caller typed,
 * so it is ignored rather than recorded as fact.
 */
export function clientIp(headers: Headers | undefined, trustProxyHeaders: boolean): string | null {
  if (!trustProxyHeaders) return null;
  const forwarded = headers?.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() ?? null;
}

export interface AttemptOutcome {
  /** HTTP status the endpoint answered with. 429 is recorded as a rate limit, not a failure. */
  status: number;
  /** Better Auth's short code (`INVALID_TOKEN`), never a message. */
  code: string | null;
}

export interface AttemptFailure extends AttemptOutcome {
  path: string;
  headers: Headers | undefined;
}

/**
 * Did this call refuse someone, and why?
 *
 * Read structurally rather than with `instanceof`: the refusal arrives as an error object
 * whose class is not the `APIError` this package imports — same shape, different copy — and
 * an `instanceof` check against it silently matches nothing. That is how the first version of
 * this recorded precisely zero failed sign-ins while looking correct.
 *
 * The two shapes that mean "refused":
 *
 *  - a 4xx or 5xx, with Better Auth's short code in the body;
 *  - a **redirect carrying `?error=`**, which is how the magic-link flow actually refuses. A
 *    bad or expired link answers 302 back to the site with `error=INVALID_TOKEN` in the query
 *    rather than a 4xx, so treating only 4xx as failure would miss the commonest attempt of
 *    all.
 */
export function describeFailure(returned: unknown): AttemptOutcome | null {
  if (returned === null || typeof returned !== 'object') return null;
  const outcome = returned as {
    statusCode?: unknown;
    body?: { code?: unknown } | undefined;
    headers?: { get?: (name: string) => string | null } | undefined;
  };
  const status = typeof outcome.statusCode === 'number' ? outcome.statusCode : null;
  if (status === null) return null;

  if (status >= 400) {
    return { status, code: typeof outcome.body?.code === 'string' ? outcome.body.code : null };
  }

  if (status >= 300) {
    const location = outcome.headers?.get?.('location') ?? null;
    if (location === null) return null;
    try {
      // A base only so a relative Location parses; the host is never read.
      const code = new URL(location, 'https://redirect.invalid').searchParams.get('error');
      return code === null ? null : { status, code };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Record one refused attempt. Never throws and never blocks the response: this reports on
 * something that already happened, and a logging failure must not become an auth failure.
 */
export async function recordFailedAttempt(
  db: Database,
  config: { secret: string; trustProxyHeaders: boolean },
  failure: AttemptFailure,
  now: Date = new Date(),
): Promise<void> {
  const ipHash = hashIp(clientIp(failure.headers, config.trustProxyHeaders), config.secret, now);
  await db
    .insert(schema.auditLog)
    .values({
      actorId: null,
      action: failure.status === 429 ? AUTH_RATE_LIMIT_ACTION : AUTH_FAILURE_ACTION,
      targetType: 'auth',
      // The endpoint, not the identity: which door was tried, not whose.
      targetId: failure.path,
      ipHash,
      diff: { status: failure.status, code: failure.code },
    })
    .catch(() => undefined);
}
