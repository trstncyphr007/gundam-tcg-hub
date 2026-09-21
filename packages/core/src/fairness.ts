/**
 * Verifiable break randomisation and tamper-evident pull logs (plan §13, FR-4.2, SR-4.1).
 *
 * The problem this solves is not technical. A breaker who assigns slots at random is asking
 * to be trusted, and "trust me" is exactly what a viewer who just lost $200 will not do.
 * Commit–reveal replaces the request with a proof: we publish a commitment to a secret
 * *before* the break, take a seed the audience can see being chosen, and publish the secret
 * afterwards. Anyone can then re-run the shuffle and get the same answer, or not.
 *
 * **Web Crypto, not `node:crypto`, and that is the point.** The verifier has to run in a
 * viewer's browser (SR-4.3) — a proof only they can check by asking us to check it is not a
 * proof. `globalThis.crypto.subtle` exists in Node 24 and in every browser, so this module
 * is the *same code* on both sides. One implementation, one set of known-answer tests, and
 * nothing for the two to disagree about.
 *
 * Everything here is deterministic and versioned. Changing any of it changes
 * `SHUFFLE_ALGORITHM`, because a break verified under v1 must stay verifiable under v1
 * forever — the whole point is that an old result can still be checked.
 */

/** Bump on any change to the derivation below. Old breaks keep their recorded version. */
export const SHUFFLE_ALGORITHM = 'v1';

/** What a chain starts from, when there is no previous row. 32 zero bytes. */
export const GENESIS_HASH = '0'.repeat(64);

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

/** `CryptoKey` is a value in Node's typings and a type in the DOM's; name it structurally. */
type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function hmacKey(secret: string): Promise<HmacKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * The public half of the commitment: `sha256(serverSeed)`.
 *
 * Published before the break starts. It reveals nothing about the seed and cannot be
 * changed afterwards without everybody noticing, which is the entire mechanism.
 */
export async function commitmentFor(serverSeed: string): Promise<string> {
  return sha256Hex(serverSeed);
}

/**
 * A deterministic byte stream from (serverSeed, clientSeed, breakId).
 *
 * The break id is in there so the same pair of seeds cannot produce the same assignment
 * twice across two breaks — which would let someone who watched the first one predict the
 * second.
 */
async function* byteStream(
  serverSeed: string,
  clientSeed: string,
  breakId: string,
): AsyncGenerator<number> {
  const key = await hmacKey(serverSeed);
  for (let block = 0; ; block += 1) {
    const message = `${SHUFFLE_ALGORITHM}:${clientSeed}:${breakId}:${String(block)}`;
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    for (const byte of new Uint8Array(signature)) yield byte;
  }
}

/**
 * A uniform integer in [0, bound), by rejection sampling.
 *
 * `% bound` on a random 32-bit value is the obvious way and it is biased: low indices come
 * up fractionally more often. Nobody would notice, which is precisely why it would be
 * indefensible once somebody did.
 */
async function randomBelow(stream: AsyncGenerator<number>, bound: number): Promise<number> {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  for (;;) {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const next = await stream.next();
      // The stream is infinite by construction; this is belt and braces.
      if (next.done === true) throw new Error('byte stream ended');
      value = value * 256 + next.value;
    }
    if (value < limit) return value % bound;
  }
}

/**
 * The assignment: a permutation of `0 … count-1` (FR-4.2).
 *
 * Fisher–Yates, walked from the end, drawing from the HMAC stream. Given the same three
 * inputs it returns the same answer on any machine, in any runtime, forever.
 */
export async function deriveShuffle(input: {
  serverSeed: string;
  clientSeed: string;
  breakId: string;
  count: number;
}): Promise<number[]> {
  if (!Number.isInteger(input.count) || input.count < 1) {
    throw new Error('count must be a positive whole number');
  }
  if (input.serverSeed.length === 0 || input.clientSeed.length === 0) {
    throw new Error('both seeds are required');
  }

  const order = Array.from({ length: input.count }, (_, i) => i);
  const stream = byteStream(input.serverSeed, input.clientSeed, input.breakId);

  // `i` and `j` are loop-bounded integers into a local array of fixed length; neither comes
  // from outside this function, so the object-injection rule has nothing to protect here.
  /* eslint-disable security/detect-object-injection */
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = await randomBelow(stream, i + 1);
    const a = order.at(i) as number;
    const b = order.at(j) as number;
    order[i] = b;
    order[j] = a;
  }
  /* eslint-enable security/detect-object-injection */
  return order;
}

/**
 * Check a published result against its seeds (AC-4.1).
 *
 * This is what the browser verifier calls. It re-derives the shuffle and also re-checks the
 * commitment, because a revealed seed that does not match what was committed to is the one
 * failure mode that matters: it would mean the seed was chosen *after* seeing the outcome.
 */
export async function verifyShuffle(input: {
  serverSeed: string;
  clientSeed: string;
  breakId: string;
  commitment: string;
  claimedOrder: readonly number[];
}): Promise<{ valid: boolean; commitmentMatches: boolean; orderMatches: boolean }> {
  const commitmentMatches = (await commitmentFor(input.serverSeed)) === input.commitment;
  const derived = await deriveShuffle({
    serverSeed: input.serverSeed,
    clientSeed: input.clientSeed,
    breakId: input.breakId,
    count: input.claimedOrder.length,
  });
  const orderMatches =
    derived.length === input.claimedOrder.length &&
    derived.every((value, index) => value === input.claimedOrder.at(index));

  return { valid: commitmentMatches && orderMatches, commitmentMatches, orderMatches };
}

// --------------------------------------------------------------------------- //
// Tamper-evident pull logs (SR-4.1)
// --------------------------------------------------------------------------- //

/** The fields of a pull that the chain commits to. Anything omitted could be changed freely. */
export interface ChainedPull {
  seq: number;
  cardVariantId: string | null;
  label: string | null;
  valueCentsAtPull: number;
  valueSource: string;
  pulledAt: string;
}

/**
 * Canonical JSON: sorted keys, no whitespace, no surprises.
 *
 * `JSON.stringify` preserves insertion order, so two servers building the same row in a
 * different order would hash it differently and a valid chain would read as tampered with.
 * The point of a hash chain is that disagreement means something; this makes sure it only
 * means what we intend.
 */
export function canonicalise(row: ChainedPull): string {
  const ordered = Object.fromEntries(
    Object.keys(row)
      .sort()
      .map((key) => [key, row[key as keyof ChainedPull]]),
  );
  return JSON.stringify(ordered);
}

/** `sha256(prevHash ‖ canonical(row))` — each row commits to every row before it. */
export async function hashPull(prevHash: string, row: ChainedPull): Promise<string> {
  return sha256Hex(`${prevHash}${canonicalise(row)}`);
}

/**
 * Walk a chain and say where, if anywhere, it breaks (AC-4.2).
 *
 * Returns the sequence number of the first row that does not match, so a public page can say
 * "the log was altered at pull 7" rather than a bare "invalid" — the specific claim is far
 * more useful to somebody deciding whether to believe the rest of it.
 */
export async function verifyChain(
  rows: readonly (ChainedPull & { prevHash: string; rowHash: string })[],
): Promise<{ valid: boolean; brokenAtSeq: number | null }> {
  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prevHash !== expectedPrev) return { valid: false, brokenAtSeq: row.seq };
    const expectedHash = await hashPull(row.prevHash, {
      seq: row.seq,
      cardVariantId: row.cardVariantId,
      label: row.label,
      valueCentsAtPull: row.valueCentsAtPull,
      valueSource: row.valueSource,
      pulledAt: row.pulledAt,
    });
    if (expectedHash !== row.rowHash) return { valid: false, brokenAtSeq: row.seq };
    expectedPrev = row.rowHash;
  }
  return { valid: true, brokenAtSeq: null };
}
