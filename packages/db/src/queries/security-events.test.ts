import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { getSecuritySummary } from './security-events.js';

/**
 * The refused-attempt summary (SR-X.22), against a log built here from nothing.
 */
const NOW = new Date('2026-09-23T12:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await startTestDatabase();

  const entry = async (action: string, at: string, ipHash: string | null, target: string) => {
    await tdb.db.execute(`
      insert into app.audit_log (actor_id, action, target_type, target_id, ip_hash, at)
      values (null, '${action}', 'auth', '${target}',
              ${ipHash === null ? 'null' : `'${ipHash}'`}, '${at}')`);
  };

  const noisy = 'iph1:2026-09-23:aaaaaaaaaaaaaaaaaaaaaa';
  const quiet = 'iph1:2026-09-23:bbbbbbbbbbbbbbbbbbbbbb';

  // One source grinding at the magic-link endpoint in the last hour.
  for (let i = 0; i < 12; i += 1) {
    await entry('auth.sign_in_failed', minutesAgo(5 + i), noisy, '/magic-link/verify');
  }
  // Someone mistyping, once, yesterday.
  await entry('auth.sign_in_failed', minutesAgo(20 * 60), quiet, '/magic-link/verify');
  // A rate limit, and an older one outside the day.
  await entry('api.rate_limited', minutesAgo(30), noisy, '/v1/cards');
  await entry('api.rate_limited', minutesAgo(3 * 24 * 60), quiet, '/v1/cards');
  // An unrelated action that must not be counted.
  await entry('auth.session.created', minutesAgo(10), noisy, '/sign-in/magic-link');
}, 180_000);

afterAll(async () => {
  await tdb.close();
});

describe('the refused-attempt summary', () => {
  it('counts each watched action over each window, and nothing else', async () => {
    const summary = await getSecuritySummary(tdb.db, NOW);
    const byAction = new Map(summary.counts.map((c) => [c.action, c]));

    expect(byAction.get('auth.sign_in_failed')).toEqual({
      action: 'auth.sign_in_failed',
      lastHour: 12,
      last24h: 13,
      last7d: 13,
    });
    expect(byAction.get('api.rate_limited')).toEqual({
      action: 'api.rate_limited',
      lastHour: 1,
      last24h: 1,
      last7d: 2,
    });
    // Reported as zero rather than missing: a silent hour and a broken hook must not look
    // the same on the page.
    expect(byAction.get('auth.rate_limited')).toEqual({
      action: 'auth.rate_limited',
      lastHour: 0,
      last24h: 0,
      last7d: 0,
    });
    // `auth.session.created` is a success; it has no business in this summary.
    expect(byAction.has('auth.session.created')).toBe(false);
  });

  it('names the busiest source by its day hash, shortened, and never an address', async () => {
    const summary = await getSecuritySummary(tdb.db, NOW);
    expect(summary.noisySources[0]).toMatchObject({ source: 'aaaaaaaa', attempts: 13 });
    // Eight characters of a value that is meaningless tomorrow — not a whole hash, and
    // certainly not an address.
    for (const s of summary.noisySources) {
      expect(s.source).toHaveLength(8);
      expect(s.source).not.toContain('iph1');
    }
  });

  it('says which endpoints are refusing', async () => {
    const summary = await getSecuritySummary(tdb.db, NOW);
    expect(summary.endpoints[0]).toEqual({ endpoint: '/magic-link/verify', attempts: 13 });
  });
});
