import { buildKeyRing, decryptField, keyIdOf } from '@gth/security';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { createBreak } from './breaks.js';
import { commitBreak } from './fairness.js';
import { rotateEncryptedFields } from './key-rotation.js';
import { logLiveSale } from './live-sales.js';
import { asUser } from './watches.js';

/**
 * Retiring an encryption key (SR-X.18, ASVS 11.4, ADR-029).
 */
const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const OLD = buildKeyRing(JSON.stringify({ k1: K1 }), 'k1');
/** After a rotation is started: both keys present, the new one active. */
const ROTATING = buildKeyRing(JSON.stringify({ k1: K1, k2: K2 }), 'k2');
/** After the old key is removed. */
const NEW_ONLY = buildKeyRing(JSON.stringify({ k2: K2 }), 'k2');

const ALICE = 'rotation-alice';
const BOB = 'rotation-bob';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let counter = 0;

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${ALICE}', 'Alice', 'rotation-alice@example.com', 'creator'),
       ('${BOB}', 'Bob', 'rotation-bob@example.com', 'creator')
     on conflict do nothing`,
  );
});

afterAll(async () => {
  await webPool.close();
  await tdb.close();
});

beforeEach(async () => {
  for (const user of [ALICE, BOB]) {
    await asUser(tdb.db, user, async (tx) => {
      await tx.execute(`delete from app.breaks`);
      await tx.execute(`delete from app.live_sales`);
    });
  }
});

/** A committed break and a sale with a buyer handle, both written with the old key. */
async function writeWithOldKey(user: string): Promise<void> {
  counter += 1;
  const created = await createBreak(webPool.db, user, {
    title: `Rotation ${String(counter)}`,
    overlayTokenHash: `rotation-hash-${String(counter)}`,
  });
  await commitBreak(webPool.db, user, created.id, { slotCount: 8, keyRing: OLD });
  await logLiveSale(
    webPool.db,
    user,
    { label: 'Sample Unit Alpha', priceCents: 1500, buyerHandle: `buyer-of-${user}` },
    OLD,
  );
}

/** What is stored, read as the owner would read it. */
async function stored(user: string): Promise<{ seeds: string[]; handles: string[] }> {
  return asUser(tdb.db, user, async (tx) => {
    const seeds = await tx.execute<{ v: string }>(
      `select c.server_seed_encrypted as v from app.break_commitments c
         join app.breaks b on b.id = c.break_id where b.creator_id = '${user}'`,
    );
    const handles = await tx.execute<{ v: string }>(
      `select buyer_handle_encrypted as v from app.live_sales
        where seller_id = '${user}' and buyer_handle_encrypted is not null`,
    );
    return { seeds: seeds.map((r) => r.v), handles: handles.map((r) => r.v) };
  });
}

describe('rotating the data encryption key (ADR-029)', () => {
  it('a dry run reports what would change, and changes nothing', async () => {
    await writeWithOldKey(ALICE);
    const before = await stored(ALICE);

    const report = await rotateEncryptedFields(tdb.db, ROTATING, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.fields.map((f) => [f.field, f.byKey, f.reencrypted])).toEqual([
      ['break_commitments.server_seed_encrypted', { k1: 1 }, 0],
      ['live_sales.buyer_handle_encrypted', { k1: 1 }, 0],
    ]);
    // The old key is still needed: nothing has moved yet.
    expect(report.stillNeeded).toEqual(['k1', 'k2']);
    expect(await stored(ALICE)).toEqual(before);
  });

  it("moves every account's values to the active key, keeping what they say", async () => {
    await writeWithOldKey(ALICE);
    await writeWithOldKey(BOB);
    const plain = async (user: string) => {
      const s = await stored(user);
      return {
        seeds: s.seeds.map((v) => decryptField(ROTATING, v)),
        handles: s.handles.map((v) => decryptField(ROTATING, v)),
      };
    };
    const before = { alice: await plain(ALICE), bob: await plain(BOB) };

    const report = await rotateEncryptedFields(tdb.db, ROTATING);
    expect(report.fields.map((f) => f.reencrypted)).toEqual([2, 2]);
    expect(report.fields.every((f) => f.failed === 0)).toBe(true);
    // Nothing depends on k1 any more: it can be deleted.
    expect(report.stillNeeded).toEqual(['k2']);

    for (const user of [ALICE, BOB]) {
      const s = await stored(user);
      expect([...s.seeds, ...s.handles].map(keyIdOf)).toEqual(['k2', 'k2']);
    }
    // Same plaintext — the commitment published before the break still matches its seed.
    expect({ alice: await plain(ALICE), bob: await plain(BOB) }).toEqual(before);
    expect(before.alice.handles).toEqual([`buyer-of-${ALICE}`]);
  });

  it('really does free the old key: everything reads with the new key alone', async () => {
    await writeWithOldKey(ALICE);
    await rotateEncryptedFields(tdb.db, ROTATING);
    const s = await stored(ALICE);
    expect(decryptField(NEW_ONLY, String(s.handles[0]))).toBe(`buyer-of-${ALICE}`);
    expect(() => decryptField(NEW_ONLY, String(s.seeds[0]))).not.toThrow();
  });

  it('is safe to run twice: the second run finds nothing to do', async () => {
    await writeWithOldKey(ALICE);
    await rotateEncryptedFields(tdb.db, ROTATING);
    const again = await rotateEncryptedFields(tdb.db, ROTATING);
    expect(again.fields.map((f) => [f.byKey, f.reencrypted])).toEqual([
      [{ k2: 1 }, 0],
      [{ k2: 1 }, 0],
    ]);
  });

  it('leaves a value it cannot decrypt exactly as it was, and says the key is still needed', async () => {
    // Written with k1, but k1 has already been removed from the ring: the job must not
    // "rotate" it into something unreadable, and must not report k1 as safe to forget.
    await writeWithOldKey(ALICE);
    const before = await stored(ALICE);

    const report = await rotateEncryptedFields(tdb.db, NEW_ONLY);
    expect(report.fields.map((f) => f.failed)).toEqual([1, 1]);
    expect(report.stillNeeded).toEqual(['k1', 'k2']);
    expect(await stored(ALICE)).toEqual(before);
  });
});
