import { describe, expect, it } from 'vitest';
import type { OperationsSummary } from './operations.js';
import { DEFAULT_THRESHOLDS, decideAlerts } from './ops-alerts.js';
import type { SecuritySummary } from './security-events.js';

/**
 * What the watchdog decides to say (SR-X.22). Pure, so every threshold is exercised directly
 * rather than inferred from a dashboard.
 */
const NOW = new Date('2026-09-23T12:00:00Z');
const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

function ops(overrides: Partial<OperationsSummary> = {}): OperationsSummary {
  return {
    generatedAt: NOW,
    retailers: [],
    staleListings: [],
    restocks: { last24h: 0, last7d: 0, recent: [] },
    deliveries: { byChannel: [], pending: 0, oldestPendingAt: null, failures: [] },
    ...overrides,
  };
}

function security(counted: Map<string, number> = new Map(), noisy = 0): SecuritySummary {
  return {
    generatedAt: NOW,
    counts: ['auth.sign_in_failed', 'auth.rate_limited', 'api.rate_limited'].map((action) => ({
      action,
      lastHour: counted.get(action) ?? 0,
      last24h: counted.get(action) ?? 0,
      last7d: counted.get(action) ?? 0,
    })),
    noisySources: noisy > 0 ? [{ source: 'abcd1234', attempts: noisy, lastAt: minutesAgo(5) }] : [],
    endpoints: [],
  };
}

const failedSignIns = (n: number): Map<string, number> => new Map([['auth.sign_in_failed', n]]);

const keys = (findings: { key: string }[]): string[] => findings.map((f) => f.key);

function retailer(name: string, enabled: boolean, lastCheckedAt: Date | null) {
  return {
    id: name,
    name,
    domain: `${name}.example`,
    enabled,
    minIntervalS: 900,
    listings: 3,
    healthy: 0,
    stale: 3,
    neverChecked: 0,
    lastCheckedAt,
  };
}

describe('a quiet system', () => {
  it('says one thing, once a day, so silence is not mistaken for death', () => {
    const findings = decideAlerts(ops(), security(), NOW);
    expect(keys(findings)).toEqual(['watchdog.heartbeat']);
    expect(findings[0]?.text).toContain('All clear');
    // A day, not an hour: this is a dead-man's switch, not a status feed.
    expect(findings[0]?.repeatAfterS).toBe(86_400);
  });
});

describe('failed sign-ins', () => {
  it('stays quiet at ordinary numbers', () => {
    expect(keys(decideAlerts(ops(), security(failedSignIns(12)), NOW))).toEqual([
      'watchdog.heartbeat',
    ]);
  });

  it('speaks at the threshold, not one past it', () => {
    const at = DEFAULT_THRESHOLDS.failedSignInsPerHour;
    expect(keys(decideAlerts(ops(), security(failedSignIns(at - 1)), NOW))).not.toContain(
      'auth.failed_spike',
    );

    const findings = decideAlerts(ops(), security(failedSignIns(at)), NOW);
    expect(keys(findings)).toContain('auth.failed_spike');
    expect(findings.find((f) => f.key === 'auth.failed_spike')?.severity).toBe('critical');
  });

  it('calls out one source grinding away, even when the total is unremarkable', () => {
    const findings = decideAlerts(
      ops(),
      security(failedSignIns(16), DEFAULT_THRESHOLDS.failedSignInsPerSource),
      NOW,
    );
    expect(keys(findings)).toContain('auth.noisy_source');
    // The short hash, never an address.
    expect(findings.find((f) => f.key === 'auth.noisy_source')?.text).toContain('…abcd1234');
  });
});

describe('the things an operator would want waking for', () => {
  it('notices deliveries that have stopped moving', () => {
    const findings = decideAlerts(
      ops({
        deliveries: { byChannel: [], pending: 9, oldestPendingAt: minutesAgo(40), failures: [] },
      }),
      security(),
      NOW,
    );
    const stuck = findings.find((f) => f.key === 'alerts.backlog_stuck');
    expect(stuck?.severity).toBe('critical');
    expect(stuck?.text).toContain('40 minutes old');
  });

  it('leaves a merely busy queue alone', () => {
    const findings = decideAlerts(
      ops({
        deliveries: { byChannel: [], pending: 9, oldestPendingAt: minutesAgo(3), failures: [] },
      }),
      security(),
      NOW,
    );
    expect(keys(findings)).toEqual(['watchdog.heartbeat']);
  });

  it('notices a scanner that has gone silent, and ignores a paused retailer', () => {
    const quiet = decideAlerts(
      ops({ retailers: [retailer('paused', false, minutesAgo(5000))] }),
      security(),
      NOW,
    );
    expect(keys(quiet)).toEqual(['watchdog.heartbeat']);

    const loud = decideAlerts(
      ops({ retailers: [retailer('active', true, minutesAgo(5000))] }),
      security(),
      NOW,
    );
    expect(loud.find((f) => f.key === 'scanner.silent')?.text).toContain('active');
  });

  it('counts a retailer that has never reported as silent', () => {
    const findings = decideAlerts(
      ops({ retailers: [retailer('new-shop', true, null)] }),
      security(),
      NOW,
    );
    expect(keys(findings)).toContain('scanner.silent');
  });

  it('says the watchdog is running rather than "all clear" when something is wrong', () => {
    const findings = decideAlerts(ops(), security(failedSignIns(99)), NOW);
    expect(findings.at(-1)?.text).toContain('need attention');
  });
});
