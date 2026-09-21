import type { Subject } from './authorize.js';

/**
 * Step-up for admin actions (SR-1.10, SR-5.9).
 *
 * **What this is, precisely:** a requirement that the session was *created* recently — that
 * the person signed in within the window, rather than riding a thirty-day session opened on
 * some other day on some other machine. A stolen, weeks-old session cookie cannot moderate
 * anything; its holder has to prove control of the account again, now.
 *
 * **What it is not:** a second factor. SR-1.10 asks for a passkey or TOTP, and this project
 * has neither yet — sign-in is a magic link or Discord, so re-authenticating proves control
 * of the same email or the same Discord account, not of a separate device. That gap is
 * recorded in the ASVS checklist and ADR-024 rather than papered over here. Freshness is the
 * half that could be built honestly today, and it is the half a passkey would sit on top of.
 */

/** SR-1.10's window for admin routes: re-authenticated within the last 12 hours. */
export const ADMIN_STEP_UP_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export class StepUpRequiredError extends Error {
  readonly maxAgeMs: number;
  constructor(maxAgeMs: number) {
    super('this action needs a recent sign-in');
    this.name = 'StepUpRequiredError';
    this.maxAgeMs = maxAgeMs;
  }
}

/**
 * Has this subject authenticated recently enough?
 *
 * A missing timestamp is not fresh. The test harness and any future non-session caller
 * (an API key, a job) have no sign-in time, and "unknown" must never read as "just now".
 */
export function isFreshSession(
  subject: Pick<Subject, 'authenticatedAt'> | null,
  maxAgeMs: number,
  now: Date = new Date(),
): boolean {
  const at = subject?.authenticatedAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return false;
  const age = now.getTime() - at.getTime();
  // A sign-in apparently in the future is clock skew or a forged value; neither is fresh.
  // A few seconds of skew between the database and this process is allowed.
  if (age < -30_000) return false;
  return age <= maxAgeMs;
}

/** Throwing variant for route handlers, alongside `authorize()`. */
export function requireFreshSession(
  subject: Pick<Subject, 'authenticatedAt'> | null,
  maxAgeMs: number = ADMIN_STEP_UP_MAX_AGE_MS,
  now: Date = new Date(),
): void {
  if (!isFreshSession(subject, maxAgeMs, now)) throw new StepUpRequiredError(maxAgeMs);
}
