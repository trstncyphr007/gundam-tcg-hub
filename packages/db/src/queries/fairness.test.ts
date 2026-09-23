import { commitmentFor, verifyShuffle } from '@gth/core';
import { buildKeyRing } from '@gth/security';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { createBreak, logPull, setBreakStatus } from './breaks.js';
import {
  CommitmentError,
  chainTip,
  checkChain,
  commitBreak,
  getCommitment,
  revealBreak,
  setClientSeed,
} from './fairness.js';
import { asUser } from './watches.js';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let superPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
/** Reveal runs here: the only role permitted to read the encrypted seed. */
let worker: TestDatabase['db'];
/**
 * A connection with no row-level security at all.
 *
 * The chain exists to catch somebody with direct database access — including us. A test that
 * tampered through the application role would be testing the permissions, which are already
 * tested; this one plays the part of a person at a psql prompt.
 */
let superuser: TestDatabase['db'];

const CREATOR = 'fairness-creator';
const OTHER = 'fairness-other';
const keyRing = buildKeyRing(JSON.stringify({ k1: randomBytes(32).toString('base64') }), 'k1');

let counter = 0;
async function newBreak(status: 'draft' | 'live' | 'ended' = 'draft'): Promise<string> {
  counter += 1;
  const created = await createBreak(web, CREATOR, {
    title: `Break ${String(counter)}`,
    overlayTokenHash: `hash-${String(counter)}-${String(Date.now())}`,
  });
  if (status !== 'draft') await setBreakStatus(web, CREATOR, created.id, 'live');
  if (status === 'ended') await setBreakStatus(web, CREATOR, created.id, 'ended');
  return created.id;
}

async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the query to fail').toBeDefined();
  const messages: string[] = [];
  for (let e: unknown = caught; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join(' | ')).toMatch(pattern);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  web = webPool.db;
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  worker = workerPool.db;
  superPool = createDb({
    url: `postgres://gth_admin:test_admin_pw@${tdb.container.getHost()}:${String(
      tdb.container.getMappedPort(5432),
    )}/gth`,
    max: 2,
  });
  superuser = superPool.db;

  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${CREATOR}', 'Creator', 'fair-creator@example.com', 'creator'),
       ('${OTHER}', 'Other', 'fair-other@example.com', 'creator')
     on conflict do nothing`,
  );
});

afterAll(async () => {
  await webPool.close();
  await workerPool.close();
  await superPool.close();
  await tdb.close();
});

beforeEach(async () => {
  for (const user of [CREATOR, OTHER]) {
    await asUser(tdb.db, user, (tx) => tx.execute(`delete from app.breaks`));
  }
});

describe('commit–reveal (FR-4.2)', () => {
  it('publishes a commitment and keeps the seed back', async () => {
    const breakId = await newBreak();
    const committed = await commitBreak(web, CREATOR, breakId, { slotCount: 12, keyRing });

    expect(committed.commitment).toMatch(/^[0-9a-f]{64}$/);
    // The creator does not learn the seed either. A creator who knows it in advance knows
    // the assignment in advance, and the audience is being protected from both of us.
    expect(JSON.stringify(committed)).not.toContain('serverSeed');
    expect(committed.revealedSeed).toBeNull();
    expect(committed.algorithmVersion).toBe('v1');
  });

  it('will not commit after the break has started', async () => {
    // A commitment made afterwards proves nothing about what already happened.
    const breakId = await newBreak('live');
    await expect(
      commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing }),
    ).rejects.toBeInstanceOf(CommitmentError);
  });

  it('will not commit twice, and keeps the first commitment', async () => {
    const breakId = await newBreak();
    const first = await commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing });

    // A refusal, not a database error. This used to surface the raw duplicate-key failure,
    // which the API turned into a 500 — reporting a double-clicked button as our fault.
    await expect(
      commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing }),
    ).rejects.toBeInstanceOf(CommitmentError);

    // And the point of refusing: the published commitment is still the original one. A second
    // attempt must not be able to swap in a seed chosen later.
    const [row] = await superuser.execute<{ commitment: string }>(
      `select commitment from app.break_commitments where break_id = '${breakId}'`,
    );
    expect(row?.commitment).toBe(first.commitment);
  });

  it('refuses a commitment on someone else’s break', async () => {
    const breakId = await newBreak();
    await expect(
      commitBreak(web, OTHER, breakId, { slotCount: 8, keyRing }),
    ).rejects.toBeInstanceOf(CommitmentError);
  });

  it('takes the audience seed once and then refuses to change it', async () => {
    // A client seed that can be edited afterwards is one the creator could pick to suit the
    // result, which is the same hole from the other direction.
    const breakId = await newBreak();
    await commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing });

    const withSeed = await setClientSeed(web, CREATOR, breakId, 'block 882341');
    expect(withSeed.clientSeed).toBe('block 882341');

    await expect(setClientSeed(web, CREATOR, breakId, 'a better one')).rejects.toBeInstanceOf(
      CommitmentError,
    );
  });

  it('will not reveal before the break has ended', async () => {
    const breakId = await newBreak();
    await commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing });
    await setClientSeed(web, CREATOR, breakId, 'seed');
    await setBreakStatus(web, CREATOR, breakId, 'live');

    // Revealing mid-break would hand the remaining slots to anyone watching.
    await expect(revealBreak(web, worker, CREATOR, breakId, keyRing)).rejects.toBeInstanceOf(
      CommitmentError,
    );
  });

  it('will not reveal without an audience seed', async () => {
    const breakId = await newBreak();
    await commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing });
    await setBreakStatus(web, CREATOR, breakId, 'live');
    await setBreakStatus(web, CREATOR, breakId, 'ended');

    await expect(revealBreak(web, worker, CREATOR, breakId, keyRing)).rejects.toBeInstanceOf(
      CommitmentError,
    );
  });

  it('reveals a seed that matches the published commitment (AC-4.1)', async () => {
    const breakId = await newBreak();
    const committed = await commitBreak(web, CREATOR, breakId, { slotCount: 16, keyRing });
    await setClientSeed(web, CREATOR, breakId, 'block 882341');
    await setBreakStatus(web, CREATOR, breakId, 'live');
    await setBreakStatus(web, CREATOR, breakId, 'ended');

    const { commitment, order } = await revealBreak(web, worker, CREATOR, breakId, keyRing);
    expect(commitment.revealedSeed).toMatch(/^[A-Za-z0-9_-]+$/);

    // The check a viewer runs in their own browser, run here against the real stored values.
    const verified = await verifyShuffle({
      serverSeed: String(commitment.revealedSeed),
      clientSeed: 'block 882341',
      breakId,
      commitment: committed.commitment,
      claimedOrder: order,
    });
    expect(verified).toEqual({ valid: true, commitmentMatches: true, orderMatches: true });
    await expect(commitmentFor(String(commitment.revealedSeed))).resolves.toBe(
      committed.commitment,
    );
  });

  it('is idempotent: refreshing the page does not change the answer', async () => {
    const breakId = await newBreak();
    await commitBreak(web, CREATOR, breakId, { slotCount: 10, keyRing });
    await setClientSeed(web, CREATOR, breakId, 'seed');
    await setBreakStatus(web, CREATOR, breakId, 'live');
    await setBreakStatus(web, CREATOR, breakId, 'ended');

    const first = await revealBreak(web, worker, CREATOR, breakId, keyRing);
    const second = await revealBreak(web, worker, CREATOR, breakId, keyRing);
    expect(second.order).toEqual(first.order);
    expect(second.commitment.revealedSeed).toBe(first.commitment.revealedSeed);
  });
});

describe('the seed at rest (SR-4.2)', () => {
  it('is not stored in plaintext', async () => {
    const breakId = await newBreak();
    await commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing });

    const [row] = await superuser.execute<{ enc: string }>(
      `select server_seed_encrypted as enc from app.break_commitments where break_id = '${breakId}'`,
    );
    // Our own envelope format, and nothing resembling a bare token.
    expect(String(row?.enc)).toMatch(/^v1:k1:/);
  });

  it('is unreadable by the web role, even with a direct query', async () => {
    // A column privilege, not a policy: the tier that serves requests cannot read the
    // ciphertext at all, so it cannot leak what it cannot select.
    const breakId = await newBreak();
    await commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing });

    await expectDbError(
      web.execute(`select server_seed_encrypted from app.break_commitments limit 1`),
      /permission denied/i,
    );
    // ...while the public half stays readable.
    await expect(
      web.execute(`select commitment from app.break_commitments limit 1`),
    ).resolves.toBeDefined();
  });

  it('is never in what a viewer is given', async () => {
    const breakId = await newBreak();
    await commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing });

    // In the creator's context: a commitment inherits its break's visibility, and this break
    // is still a draft. Once it starts, the same row is public — which is the point, since a
    // commitment has to be published before anything is opened.
    const view = await asUser(web, CREATOR, (tx) => getCommitment(tx, breakId));
    expect(view).not.toBeNull();
    expect(Object.keys(view ?? {})).not.toContain('serverSeedEncrypted');
    expect(view?.revealedSeed).toBeNull();
  });

  it('becomes publicly readable once the break starts', async () => {
    const breakId = await newBreak();
    const committed = await commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing });
    await setBreakStatus(web, CREATOR, breakId, 'live');

    // No user context at all — a viewer with no account.
    const view = await getCommitment(web, breakId);
    expect(view?.commitment).toBe(committed.commitment);
    expect(view?.revealedSeed).toBeNull();
  });
});

describe('the pull-log hash chain (SR-4.1, AC-4.2)', () => {
  it('chains every pull as it is logged', async () => {
    const breakId = await newBreak('live');
    await logPull(web, CREATOR, breakId, { label: 'One', valueCentsAtPull: 100 });
    await logPull(web, CREATOR, breakId, { label: 'Two', valueCentsAtPull: 250 });
    await logPull(web, CREATOR, breakId, { label: 'Three', valueCentsAtPull: 900 });

    const status = await checkChain(web, breakId);
    expect(status.state).toBe('valid');
    expect(status.head).toMatch(/^[0-9a-f]{64}$/);
    // The head is the tip the next pull would chain from.
    await expect(chainTip(web, breakId)).resolves.toBe(status.head);
  });

  it('detects a row edited directly in the database (AC-4.2)', async () => {
    const breakId = await newBreak('live');
    await logPull(web, CREATOR, breakId, { label: 'One', valueCentsAtPull: 100 });
    await logPull(web, CREATOR, breakId, { label: 'Two', valueCentsAtPull: 250 });
    await logPull(web, CREATOR, breakId, { label: 'Three', valueCentsAtPull: 900 });

    // As the table owner — the one role that *can* write here — inflate the middle pull.
    // This is the scenario the chain exists for: not an attacker at the API, but somebody
    // with a psql prompt, including us.
    await superuser.execute(
      `update app.break_pulls set value_cents_at_pull = 99900
        where break_id = '${breakId}' and seq = 2`,
    );

    const status = await checkChain(web, breakId);
    expect(status.state).toBe('invalid');
    expect(status.brokenAtSeq).toBe(2);
    expect(status.head).toBeNull();
  });

  it('reports an unchained log as unverifiable, not as valid', async () => {
    // Rows written before the chain existed. An absent proof is not a passing one.
    const breakId = await newBreak('live');
    await logPull(web, CREATOR, breakId, { label: 'Legacy', valueCentsAtPull: 100 });
    await superuser.execute(
      `update app.break_pulls set prev_hash = null, row_hash = null where break_id = '${breakId}'`,
    );

    const status = await checkChain(web, breakId);
    expect(status.state).toBe('unverifiable');
  });

  it('is empty for a break with no pulls', async () => {
    const breakId = await newBreak('live');
    await expect(checkChain(web, breakId)).resolves.toEqual({
      state: 'empty',
      brokenAtSeq: null,
      head: null,
    });
  });
});

describe('append-only pull logs (AC-4.3)', () => {
  it('denies the app role UPDATE and DELETE on break_pulls', async () => {
    // The acceptance criterion, stated as a permission rather than a promise: a correction
    // is a new row, never an edit, and the database is what enforces it.
    const breakId = await newBreak('live');
    await logPull(web, CREATOR, breakId, { label: 'One', valueCentsAtPull: 100 });

    await expectDbError(
      web.execute(
        `update app.break_pulls set value_cents_at_pull = 1 where break_id = '${breakId}'`,
      ),
      /permission denied/i,
    );
    await expectDbError(
      web.execute(`delete from app.break_pulls where break_id = '${breakId}'`),
      /permission denied/i,
    );
  });

  it('denies the web role DELETE on commitments', async () => {
    // Deleting a commitment would erase the evidence that a break was committed to at all.
    const breakId = await newBreak();
    await commitBreak(web, CREATOR, breakId, { slotCount: 8, keyRing });
    await expectDbError(
      web.execute(`delete from app.break_commitments where break_id = '${breakId}'`),
      /permission denied/i,
    );
  });
});
