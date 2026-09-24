import type { Database } from '@gth/db';
import { describe, expect, it, vi } from 'vitest';
import { alertRetryJob, retryOwedDeliveries } from './retry.js';
import type { DeliveryOutcome, RestockMessage, Transport } from './transports.js';

/**
 * The second chance (FR-1.8).
 *
 * Fan-out gets one pass, inside the scanner's request. Every transport already worked out
 * whether a failure was worth another go — a Discord 429, a 5xx, a timeout — and that answer
 * was thrown away: everything became `failed`, terminal, and nothing ever read it again. A
 * blip meant somebody who asked to be told never was, and nothing said so.
 *
 * These are about the rules of trying again, which is where the damage is: send twice and you
 * have cried wolf, stop too early and you have broken the promise, keep going for ever and you
 * are telling people about yesterday.
 */
const message: RestockMessage = {
  productName: 'Sample Booster Box',
  retailerName: 'Sample Retailer',
  url: 'https://example.test/box',
  priceCents: 9999,
  currency: 'USD',
  detectedAt: new Date('2026-09-24T10:00:00Z'),
};

interface Row {
  id: string;
  eventId: string;
  subscriptionId: string;
  channel: 'email';
  attempts: number;
  retailerProductId: string;
  priceCents: number | null;
  currency: string;
  detectedAt: Date;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 'delivery-1',
  eventId: 'event-1',
  subscriptionId: 'sub-1',
  channel: 'email',
  attempts: 1,
  retailerProductId: 'listing-1',
  priceCents: 9999,
  currency: 'USD',
  detectedAt: new Date('2026-09-24T10:00:00Z'),
  ...over,
});

/**
 * The query and the writes are `@gth/db`'s; here they are stubbed so the *rules* are what is
 * under test. Their own behaviour against a real database is covered in `ingest.test.ts`.
 */
vi.mock('@gth/db', () => {
  const state = {
    rows: [] as Row[],
    marks: [] as { id: string; status: string; reason: string }[],
    targets: [] as { subscriptionId: string; userId: string; email: string | null }[],
  };
  return {
    __state: state,
    claimRetryableDeliveries: () => Promise.resolve(state.rows),
    findFanOutTargets: () => Promise.resolve(state.targets),
    markDeliverySent: (_db: unknown, id: string) => {
      state.marks.push({ id, status: 'sent', reason: '' });
      return Promise.resolve();
    },
    markDeliveryFailed: (_db: unknown, id: string, reason: string, status = 'failed') => {
      state.marks.push({ id, status, reason });
      return Promise.resolve();
    },
    abandonDelivery: (_db: unknown, id: string, reason: string) => {
      state.marks.push({ id, status: 'abandoned', reason });
      return Promise.resolve();
    },
  };
});

const db = {} as Database;
const target = { subscriptionId: 'sub-1', userId: 'user-1', email: 'watcher@example.test' };

async function state(): Promise<{
  rows: Row[];
  marks: { id: string; status: string; reason: string }[];
  targets: (typeof target)[];
}> {
  const mod = (await import('@gth/db')) as unknown as { __state: never };
  return mod.__state;
}

function transportThat(...outcomes: DeliveryOutcome[]): {
  transport: Transport;
  sent: RestockMessage[];
} {
  const sent: RestockMessage[] = [];
  let i = 0;
  return {
    sent,
    transport: {
      send: (msg) => {
        sent.push(msg);
        return Promise.resolve(outcomes[Math.min(i++, outcomes.length - 1)] ?? { ok: true });
      },
    },
  };
}

const deps = (transport: Transport, over = {}) => ({
  db,
  transports: { email: transport },
  buildMessage: (_d: Database, _r: string, p: number | null, c: string, at: Date) =>
    Promise.resolve({ ...message, priceCents: p, currency: c, detectedAt: at }),
  ...over,
});

describe('trying again', () => {
  it('sends what is still owed, and records it as sent', async () => {
    const s = await state();
    s.rows = [row()];
    s.targets = [target];
    s.marks = [];
    const { transport, sent } = transportThat({ ok: true });

    const result = await retryOwedDeliveries(deps(transport));

    expect(result).toMatchObject({ considered: 1, sent: 1, stillOwed: 0, abandoned: 0 });
    expect(s.marks).toEqual([{ id: 'delivery-1', status: 'sent', reason: '' }]);
    expect(sent).toHaveLength(1);
  });

  it('tells the reader when the stock came back, not when we got round to saying so', async () => {
    // A retry an hour later must not claim it just happened: the reader is about to go and
    // look, and a wrong time is worse than a late alert.
    const s = await state();
    s.rows = [row({ detectedAt: new Date('2026-09-24T08:00:00Z') })];
    s.targets = [target];
    s.marks = [];
    const { transport, sent } = transportThat({ ok: true });

    await retryOwedDeliveries(deps(transport));

    expect(sent[0]?.detectedAt.toISOString()).toBe('2026-09-24T08:00:00.000Z');
  });

  it('keeps owing it while the failure might not happen next time', async () => {
    const s = await state();
    s.rows = [row({ attempts: 1 })];
    s.targets = [target];
    s.marks = [];
    const { transport } = transportThat({
      ok: false,
      reason: 'discord responded 429',
      retryable: true,
    });

    const result = await retryOwedDeliveries(deps(transport));

    expect(result).toMatchObject({ sent: 0, stillOwed: 1, abandoned: 0 });
    expect(s.marks[0]?.status).toBe('pending');
  });

  it('gives up at the cap rather than trying for ever', async () => {
    // Five attempts, and the fifth failure is the last. A channel that has refused five times
    // is not going to accept the sixth, and the row must stop being counted as owed.
    const s = await state();
    s.rows = [row({ attempts: 4 })];
    s.targets = [target];
    s.marks = [];
    const { transport } = transportThat({
      ok: false,
      reason: 'discord responded 500',
      retryable: true,
    });

    const result = await retryOwedDeliveries(deps(transport));

    expect(result).toMatchObject({ sent: 0, stillOwed: 0, abandoned: 1 });
    expect(s.marks[0]?.status).toBe('failed');
  });

  it('does not try again when the failure will happen every time', async () => {
    const s = await state();
    s.rows = [row()];
    s.targets = [target];
    s.marks = [];
    const { transport } = transportThat({
      ok: false,
      reason: 'webhook url rejected by allowlist',
      retryable: false,
    });

    const result = await retryOwedDeliveries(deps(transport));

    expect(result).toMatchObject({ stillOwed: 0, abandoned: 1 });
    expect(s.marks[0]?.status).toBe('failed');
  });

  it('stops owing an alert whose watch has gone', async () => {
    // Unsubscribed between the restock and the retry. Nothing to send, and it must not sit
    // pending for ever being counted as a debt.
    const s = await state();
    s.rows = [row()];
    s.targets = [];
    s.marks = [];
    const { transport, sent } = transportThat({ ok: true });

    const result = await retryOwedDeliveries(deps(transport));

    expect(result).toMatchObject({ sent: 0, abandoned: 1 });
    expect(sent).toHaveLength(0);
    expect(s.marks[0]?.reason).toBe('watch gone');
  });

  it('builds the message once however many people are owed it', async () => {
    const s = await state();
    s.rows = [
      row({ id: 'd1', subscriptionId: 'sub-1' }),
      row({ id: 'd2', subscriptionId: 'sub-2' }),
    ];
    s.targets = [target, { ...target, subscriptionId: 'sub-2', userId: 'user-2' }];
    s.marks = [];
    const { transport } = transportThat({ ok: true });
    const buildMessage = vi.fn(() => Promise.resolve(message));

    const result = await retryOwedDeliveries(deps(transport, { buildMessage }));

    expect(result.sent).toBe(2);
    expect(buildMessage).toHaveBeenCalledTimes(1);
  });

  it('stops owing an alert whose listing has gone', async () => {
    // The shop page, or the whole product, removed since the restock. There is no message to
    // build, so there is nothing to keep trying.
    const s = await state();
    s.rows = [row()];
    s.targets = [target];
    s.marks = [];
    const { transport, sent } = transportThat({ ok: true });

    const result = await retryOwedDeliveries(
      deps(transport, { buildMessage: () => Promise.resolve(null) }),
    );

    expect(result).toMatchObject({ sent: 0, abandoned: 1 });
    expect(sent).toHaveLength(0);
    expect(s.marks[0]?.reason).toBe('listing gone');
  });

  it('stops owing one for a channel nothing can send', async () => {
    const s = await state();
    s.rows = [row()];
    s.targets = [target];
    s.marks = [];

    const result = await retryOwedDeliveries({
      ...deps(transportThat().transport),
      transports: {},
    });

    expect(result).toMatchObject({ abandoned: 1 });
    expect(s.marks[0]?.reason).toBe('no transport for email');
  });

  it('records a skip without treating it as still owed', async () => {
    const s = await state();
    s.rows = [row()];
    s.targets = [target];
    s.marks = [];
    const { transport } = transportThat({ ok: 'skipped', reason: 'unsupported channel' });

    const result = await retryOwedDeliveries(deps(transport));

    expect(result).toMatchObject({ sent: 0, stillOwed: 0, abandoned: 1 });
    expect(s.marks[0]?.status).toBe('failed');
  });

  it('does nothing, cheaply, when nothing is owed', async () => {
    const s = await state();
    s.rows = [];
    s.marks = [];
    const buildMessage = vi.fn();
    const { transport } = transportThat({ ok: true });

    const result = await retryOwedDeliveries(deps(transport, { buildMessage }));

    expect(result).toEqual({
      considered: 0,
      sent: 0,
      stillOwed: 0,
      abandoned: 0,
      switchedOff: false,
    });
    expect(buildMessage).not.toHaveBeenCalled();
  });

  it('sends nothing, and claims nothing, while alert delivery is switched off', async () => {
    // The switch an operator pulls at 2am to stop an alert loop (§22). It gated fan-out and
    // nothing else, so this job kept draining the backlog out the door while the console said
    // alerts were off — every five minutes, from the moment it was given a timer (#76).
    //
    // Something is owed here on purpose: a version of this test with an empty backlog would
    // pass whether or not the switch is read at all.
    const s = await state();
    s.rows = [row()];
    s.targets = [target];
    s.marks = [];
    const { transport, sent } = transportThat({ ok: true });

    const result = await retryOwedDeliveries(
      deps(transport, { sendingEnabled: () => Promise.resolve(false) }),
    );

    expect(sent).toEqual([]);
    // Nothing written either. An attempt not made must not be counted against the five.
    expect(s.marks).toEqual([]);
    expect(result).toEqual({
      considered: 0,
      sent: 0,
      stillOwed: 0,
      abandoned: 0,
      switchedOff: true,
    });
  });

  it('sends what is still owed once the switch is back on', async () => {
    // Off is a pause, not a cancellation: the row is untouched, so the first run after the
    // incident owes exactly what it owed before it.
    const s = await state();
    s.rows = [row()];
    s.targets = [target];
    s.marks = [];
    const { transport, sent } = transportThat({ ok: true });

    const result = await retryOwedDeliveries(
      deps(transport, { sendingEnabled: () => Promise.resolve(true) }),
    );

    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ considered: 1, sent: 1, switchedOff: false });
  });
});

describe('what the job prints', () => {
  it('says so plainly when there is nothing to do', async () => {
    // Every run writes a line. A job that prints nothing on a quiet night is
    // indistinguishable from one that did not run (ADR-038's lesson, applied here).
    const s = await state();
    s.rows = [];
    const { transport } = transportThat({ ok: true });

    await expect(alertRetryJob(deps(transport))).resolves.toEqual(['no alerts owed']);
  });

  it('says which switch stopped it, not just that it did nothing', async () => {
    // "no alerts owed" would be a lie here — alerts *are* owed — and the operator reading the
    // timer's log during an incident is the person who most needs to know which is which.
    const s = await state();
    s.rows = [row()];
    s.targets = [target];
    s.marks = [];
    const { transport } = transportThat({ ok: true });

    await expect(
      alertRetryJob(deps(transport, { sendingEnabled: () => Promise.resolve(false) })),
    ).resolves.toEqual(['alert delivery is switched off (alerts.enabled); nothing sent']);
  });

  it('counts what it did', async () => {
    const s = await state();
    s.rows = [row({ id: 'd1' }), row({ id: 'd2', subscriptionId: 'sub-2' })];
    s.targets = [target];
    s.marks = [];
    const { transport } = transportThat({ ok: true });

    const lines = await alertRetryJob(deps(transport));

    expect(lines).toEqual(['considered 2', 'sent 1', 'still owed 0', 'abandoned 1']);
  });
});
