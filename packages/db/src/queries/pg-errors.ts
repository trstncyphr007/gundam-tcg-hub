/**
 * Postgres constraint violations, told apart from real faults.
 *
 * A constraint firing is usually the database doing its job about something ordinary: a handle
 * already taken, a product deleted while a page sat open in a tab. Left alone the driver's
 * error travels up to the route, misses every `instanceof` on the way, and is answered as
 * `500 internal_error` — which says we broke, tells the caller nothing they can act on, and is
 * a 5xx the API fuzzing gate exists to catch (AC-3.4).
 *
 * These were written out by hand in two files with slightly different shapes before being
 * collected here, which is how the third and fourth places came to be missing one.
 */

/**
 * Walk the `cause` chain looking for a SQLSTATE.
 *
 * Drizzle wraps the driver's error in one of its own, so the code lives on the original.
 * Checking only the outer error quietly never matches — the failure mode being that the guard
 * looks present in review and does nothing at runtime.
 */
function hasSqlState(error: unknown, state: string): boolean {
  for (let current: unknown = error; current != null;) {
    const fields = current as { code?: unknown; cause?: unknown };
    if (fields.code === state) return true;
    current = fields.cause;
  }
  return false;
}

/**
 * `23505`: a unique index refused a duplicate.
 *
 * Pass `constraint` when more than one unique index on the table could fire and they mean
 * different things to the caller; leave it off when the table has one and the answer is the
 * same either way. Naming the constraint is a contract with Postgres; matching the message
 * text would be a contract with a string.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (constraint === undefined) return hasSqlState(error, '23505');
  for (let current: unknown = error; current != null;) {
    const fields = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (fields.code === '23505' && fields.constraint_name === constraint) return true;
    current = fields.cause;
  }
  return false;
}

/** `23503`: a foreign key points at a row that is not there. */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasSqlState(error, '23503');
}

/**
 * `42501`: the database said no.
 *
 * Covers both "permission denied for table" (a missing grant) and "new row violates row-level
 * security policy" (a failed `WITH CHECK`). Postgres gives them the same SQLSTATE, because from
 * the caller's side they are the same answer.
 *
 * Worth knowing, because the two halves of row-level security fail differently: a row excluded
 * by `USING` is simply absent and the statement succeeds having done nothing, while a row
 * refused by `WITH CHECK` **raises**. Code that assumes the first and gets the second turns a
 * policy working exactly as designed into an unhandled 500.
 */
export function isInsufficientPrivilege(error: unknown): boolean {
  return hasSqlState(error, '42501');
}

/**
 * A row referred to by a request does not exist.
 *
 * Carried as a type rather than a status so the query layer stays free of HTTP, and thrown
 * where a foreign key would otherwise have surfaced raw. Routes answer it with 404.
 */
export class MissingReferenceError extends Error {
  constructor(what = 'the record referred to') {
    super(`no such ${what}`);
    this.name = 'MissingReferenceError';
  }
}
