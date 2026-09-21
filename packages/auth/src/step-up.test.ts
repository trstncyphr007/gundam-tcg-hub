import { describe, expect, it } from 'vitest';
import {
  ADMIN_STEP_UP_MAX_AGE_MS,
  StepUpRequiredError,
  isFreshSession,
  requireFreshSession,
} from './step-up.js';

const now = new Date('2026-09-22T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(now.getTime() - h * 60 * 60 * 1000);

describe('isFreshSession (SR-1.10)', () => {
  it('uses the plan’s twelve-hour window for admin actions', () => {
    expect(ADMIN_STEP_UP_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('accepts a sign-in inside the window', () => {
    expect(isFreshSession({ authenticatedAt: hoursAgo(1) }, ADMIN_STEP_UP_MAX_AGE_MS, now)).toBe(
      true,
    );
    expect(isFreshSession({ authenticatedAt: hoursAgo(12) }, ADMIN_STEP_UP_MAX_AGE_MS, now)).toBe(
      true,
    );
  });

  it('refuses one outside it, however valid the session otherwise is', () => {
    // A thirty-day session opened three days ago is a perfectly good session. It is not
    // evidence that the person holding it is the account owner today.
    expect(
      isFreshSession({ authenticatedAt: hoursAgo(12.01) }, ADMIN_STEP_UP_MAX_AGE_MS, now),
    ).toBe(false);
    expect(isFreshSession({ authenticatedAt: hoursAgo(72) }, ADMIN_STEP_UP_MAX_AGE_MS, now)).toBe(
      false,
    );
  });

  it('treats an unknown sign-in time as stale, never as “just now”', () => {
    expect(isFreshSession({}, ADMIN_STEP_UP_MAX_AGE_MS, now)).toBe(false);
    expect(isFreshSession(null, ADMIN_STEP_UP_MAX_AGE_MS, now)).toBe(false);
    expect(
      isFreshSession({ authenticatedAt: new Date('not a date') }, ADMIN_STEP_UP_MAX_AGE_MS, now),
    ).toBe(false);
  });

  it('refuses a sign-in dated in the future, beyond a little clock skew', () => {
    const skewed = new Date(now.getTime() + 10_000);
    const forged = new Date(now.getTime() + 60 * 60 * 1000);
    expect(isFreshSession({ authenticatedAt: skewed }, ADMIN_STEP_UP_MAX_AGE_MS, now)).toBe(true);
    expect(isFreshSession({ authenticatedAt: forged }, ADMIN_STEP_UP_MAX_AGE_MS, now)).toBe(false);
  });
});

describe('requireFreshSession', () => {
  it('throws a StepUpRequiredError carrying the window', () => {
    try {
      requireFreshSession({ authenticatedAt: hoursAgo(24) }, ADMIN_STEP_UP_MAX_AGE_MS, now);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(StepUpRequiredError);
      expect((error as StepUpRequiredError).maxAgeMs).toBe(ADMIN_STEP_UP_MAX_AGE_MS);
    }
  });

  it('passes quietly when fresh', () => {
    expect(() => {
      requireFreshSession({ authenticatedAt: hoursAgo(1) }, ADMIN_STEP_UP_MAX_AGE_MS, now);
    }).not.toThrow();
  });
});
