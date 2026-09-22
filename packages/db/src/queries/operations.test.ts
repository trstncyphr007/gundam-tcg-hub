import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { getOperationsSummary } from './operations.js';

/**
 * The operations summary (FR-1.12), against a world built here from nothing, so every count
 * below is one this test put there.
 */
const NOW = new Date('2026-09-23T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

let tdb: TestDatabase;
const ids = { fresh: '', stale: '', never: '', paused: '' };

async function one(sql: string): Promise<string> {
  const rows = await tdb.db.execute<{ id: string }>(sql);
  return String(rows[0]?.id);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  const game = await one(
    `insert into app.games (slug, name) values ('ops-game', 'Ops') returning id`,
  );
  const product = await one(`
    insert into app.sealed_products (game_id, kind, name, slug)
    values ('${game}', 'booster_box', 'Ops Box', 'ops-box') returning id`);

  // Checked every 15 minutes, so stale after 30.
  const active = await one(`
    insert into app.retailers (name, domain, adapter_key, enabled, robots_ok, tos_reviewed_at, min_interval_s)
    values ('Active Shop', 'active.example', 'mock', true, true, now(), 900) returning id`);
  const disabled = await one(`
    insert into app.retailers (name, domain, adapter_key, enabled, min_interval_s)
    values ('Paused Shop', 'paused.example', 'mock', false, 900) returning id`);

  const listing = async (retailer: string, path: string) =>
    one(`insert into app.retailer_products (retailer_id, sealed_product_id, url)
         values ('${retailer}', '${product}', 'https://x.example/${path}') returning id`);
  ids.fresh = await listing(active, 'fresh');
  ids.stale = await listing(active, 'stale');
  ids.never = await listing(active, 'never');
  ids.paused = await listing(disabled, 'paused');

  const snapshot = async (rp: string, at: string) =>
    one(`insert into app.stock_snapshots (retailer_product_id, in_stock, checked_at)
         values ('${rp}', true, '${at}') returning id`);
  await snapshot(ids.fresh, minutesAgo(90)); // an older check that must not win
  await snapshot(ids.fresh, minutesAgo(5));
  await snapshot(ids.stale, minutesAgo(60)); // 60 > 2 × 15: stale, 45 min past due
  await snapshot(ids.paused, minutesAgo(3000));
  // From "the future" relative to NOW: must not make the stale listing look fresh.
  await snapshot(ids.stale, new Date(NOW.getTime() + 60_000).toISOString());

  // Restocks: one in the last day, one in the week, one older.
  const event = async (at: string) =>
    one(`insert into app.restock_events (retailer_product_id, snapshot_id, detected_at)
         values ('${ids.fresh}', '${await snapshot(ids.fresh, at)}', '${at}') returning id`);
  const recent = await event(minutesAgo(60));
  await event(minutesAgo(3 * 24 * 60));
  await event(minutesAgo(10 * 24 * 60));

  // Deliveries hang off a watch, which is row-secured: declare its owner to create it.
  await tdb.db.execute(
    `insert into app.users (id, name, email) values ('ops-user', 'Ops', 'ops@example.com')`,
  );
  const watch = await tdb.db.transaction(async (tx) => {
    await tx.execute(`select set_config('app.user_id', 'ops-user', true)`);
    const rows = await tx.execute<{ id: string }>(
      `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
       values ('ops-user', '${product}', '{email,discord_dm}') returning id`,
    );
    return String(rows[0]?.id);
  });
  const delivery = async (
    channel: string,
    status: string,
    minutes: number,
    error: string | null = null,
    eventId = recent,
  ) => {
    await tdb.db.execute(`
      insert into app.alert_deliveries (event_id, subscription_id, channel, status, last_error, created_at)
      values ('${eventId}', '${watch}', '${channel}', '${status}',
              ${error === null ? 'null' : `'${error}'`}, '${minutesAgo(minutes)}')`);
  };
  // Distinct (event, channel) pairs: the unique index allows one each.
  await delivery('email', 'sent', 30);
  await delivery('discord_dm', 'failed', 30, 'discord responded 404');
  const older = await event(minutesAgo(2 * 24 * 60));
  await delivery('email', 'failed', 2 * 24 * 60, 'discord responded 404', older);
  await delivery('discord_dm', 'pending', 120, null, older);
  const ancient = await event(minutesAgo(12 * 24 * 60));
  await delivery('email', 'failed', 12 * 24 * 60, 'smtp timeout', ancient);
});

afterAll(async () => {
  await tdb.close();
});

describe('operations summary (FR-1.12)', () => {
  it('judges each listing by its own latest check against its retailer interval', async () => {
    const summary = await getOperationsSummary(tdb.db, NOW);
    const active = summary.retailers.find((r) => r.name === 'Active Shop');
    expect(active).toMatchObject({
      enabled: true,
      minIntervalS: 900,
      listings: 3,
      healthy: 1,
      stale: 1,
      neverChecked: 1,
    });
    expect(active?.lastCheckedAt?.toISOString()).toBe(minutesAgo(5));
  });

  it('lists what needs attention: never-checked first, then the most overdue', async () => {
    const { staleListings } = await getOperationsSummary(tdb.db, NOW);
    expect(staleListings.map((l) => [l.retailer, l.lastCheckedAt?.toISOString() ?? null])).toEqual([
      ['Active Shop', null],
      ['Active Shop', minutesAgo(60)],
    ]);
    // 60 minutes since the check, 15 of which were the interval: 45 minutes past due.
    expect(staleListings[1]?.overdueSeconds).toBe(45 * 60);
    expect(staleListings[0]?.overdueSeconds).toBeNull();
  });

  it('shows a paused retailer as stale, but keeps it out of the attention list', async () => {
    const summary = await getOperationsSummary(tdb.db, NOW);
    expect(summary.retailers.find((r) => r.name === 'Paused Shop')).toMatchObject({
      enabled: false,
      stale: 1,
    });
    expect(summary.staleListings.every((l) => l.retailer !== 'Paused Shop')).toBe(true);
  });

  it('counts restocks over the last day and week', async () => {
    const { restocks } = await getOperationsSummary(tdb.db, NOW);
    expect(restocks.last24h).toBe(1);
    // 1 h, 2 d and 3 d ago; not 10 or 12 days.
    expect(restocks.last7d).toBe(3);
    expect(restocks.recent[0]).toMatchObject({ product: 'Ops Box', retailer: 'Active Shop' });
  });

  it('reports deliveries by outcome, the backlog, and why they fail', async () => {
    const { deliveries } = await getOperationsSummary(tdb.db, NOW);
    // The last 24 hours only: the two-day-old email failure is not here.
    expect(deliveries.byChannel).toEqual([
      { channel: 'discord_dm', status: 'failed', count: 1 },
      { channel: 'discord_dm', status: 'pending', count: 1 },
      { channel: 'email', status: 'sent', count: 1 },
    ]);
    expect(deliveries.pending).toBe(1);
    expect(deliveries.oldestPendingAt?.toISOString()).toBe(minutesAgo(120));
    // Seven days: two with the same reason, grouped; the 12-day-old one left out.
    expect(deliveries.failures).toEqual([
      expect.objectContaining({ reason: 'discord responded 404', count: 2 }),
    ]);
  });

  it('names nobody: no user id, email or address anywhere in the summary', async () => {
    const summary = JSON.stringify(await getOperationsSummary(tdb.db, NOW));
    expect(summary).not.toContain('ops-user');
    expect(summary).not.toContain('ops@example.com');
  });
});
