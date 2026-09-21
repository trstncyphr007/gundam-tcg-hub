import type { Subject } from './authorize.js';

/**
 * Step-up for admin actions (SR-1.10, SR-5.9, ADR-024, ADR-025).
 *
 * Two separate requirements, checked in this order and reported separately, because each has
 * a different fix:
 *
 *  1. **The session was opened with a passkey** — one that verified the person with a PIN or
 *     biometric (ADR-025). That is what makes the gate multi-factor: the device, and the
 *     person holding it. A session from a magic link or Discord proves control of an inbox or
 *     an account, which is one factor however recent. → `PasskeyRequiredError`
 *  2. **It was opened recently** — within twelve hours. A passkey session opened last week on
 *     another machine is still a stolen-cookie risk. → `StepUpRequiredError`
 *
 * A passkey proves *who*; freshness proves *now*. Admin actions want both.
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

export class PasskeyRequiredError extends Error {
  constructor() {
    super('this action needs a session opened with a passkey');
    this.name = 'PasskeyRequiredError';
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

/**
 * The admin gate: a passkey session, opened within the window.
 *
 * The method is checked first. An admin signed in by email ten minutes ago is not asked to
 * "sign in again" — which would send them round the same email loop forever — but to sign in
 * *with a passkey*, which is the thing actually missing.
 */
export function requireAdminStepUp(
  subject: Pick<Subject, 'authenticatedAt' | 'authMethod'> | null,
  maxAgeMs: number = ADMIN_STEP_UP_MAX_AGE_MS,
  now: Date = new Date(),
): void {
  if (subject?.authMethod !== 'passkey') throw new PasskeyRequiredError();
  requireFreshSession(subject, maxAgeMs, now);
}
