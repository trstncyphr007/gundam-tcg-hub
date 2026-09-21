import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { app, cardVariants, sealedProducts } from './catalog.js';

export const breakStatus = app.enum('break_status', ['draft', 'live', 'ended']);

/**
 * Where a pull's value came from — and the reason this column has to exist.
 *
 * The break calculator can fill a card's value from the published index (FR-2.1). Logged
 * pulls are also *fed back into* that index as `break_pull` observations, weighted most
 * heavily of all because we watched them happen (ADR-018).
 *
 * Put those two together without this column and the index quotes itself: a price the index
 * published becomes an observation at triple weight, which moves the price it publishes
 * tomorrow, which becomes tomorrow's observation. The numbers would look like strong
 * evidence while drifting away from anything anyone paid.
 *
 * So provenance is recorded per pull, and ingestion takes only `manual` ones — a value a
 * person typed because that is what the card went for. An `index` value is a quote, not a
 * sale, and quoting it back would be circular.
 */
export const pullValueSource = app.enum('pull_value_source', ['manual', 'index']);

/**
 * A pack-opening session run by a creator (FR-2.2).
 *
 * Row-level security restricts writes to the owning creator; the public break page reads
 * through a separate published view, so a viewer needs no account (see migration 0010).
 */
export const breaks = app.table(
  'breaks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    creatorId: text('creator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** What is being opened. Its MSRP is the cost the running total is measured against. */
    sealedProductId: uuid('sealed_product_id').references(() => sealedProducts.id, {
      onDelete: 'set null',
    }),
    /** What the creator actually paid, which is often not MSRP. */
    costCents: integer('cost_cents'),
    /**
     * How many packs were opened (FR-4.3).
     *
     * The denominator, and the reason it has to be entered rather than derived: published
     * odds are stated *per pack*, and a pull log counts cards. Thirty pulls could be thirty
     * packs or six. Without this number a hit rate cannot be compared to anything, so a
     * break that does not record it is excluded from the comparison entirely — and the
     * profile page says how many breaks that was, rather than quietly shrinking the sample.
     */
    packsOpened: integer('packs_opened'),
    /**
     * Where the break can be watched (FR-4.4).
     *
     * One VOD per break is the normal case, so the link lives here and each pull carries only
     * an offset into it. The alternative — a full URL per pull — would mean pasting the same
     * link forty times, which is how forty chances to paste the wrong one get created.
     */
    vodUrl: text('vod_url'),
    status: breakStatus('status').notNull().default('draft'),
    /**
     * HMAC of the overlay token (SR-2.1). The token itself is shown once and never
     * stored, so a leaked database row cannot be replayed into a live overlay.
     */
    overlayTokenHash: text('overlay_token_hash').notNull(),
    /** Bumped on rotation, so an old token is provably dead rather than merely unlisted. */
    overlayTokenVersion: integer('overlay_token_version').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('breaks_creator_idx').on(t.creatorId),
    uniqueIndex('breaks_overlay_token_key').on(t.overlayTokenHash),
    check('breaks_title_not_blank', sql`length(btrim(${t.title})) > 0`),
    check('breaks_title_length', sql`length(${t.title}) <= 120`),
    check('breaks_cost_non_negative', sql`${t.costCents} is null or ${t.costCents} >= 0`),
    // A case is 12 boxes of 24; 5000 is far beyond any single session and bounds the
    // denominator so a typo cannot silently make a hit rate look impossibly low.
    check(
      'breaks_packs_opened_range',
      sql`${t.packsOpened} is null or ${t.packsOpened} between 1 and 5000`,
    ),
    check('breaks_vod_url_https', sql`${t.vodUrl} is null or ${t.vodUrl} like 'https://%'`),
    // A live break has started; an ended one has both timestamps and ends after it starts.
    check(
      'breaks_timestamps_follow_status',
      sql`(${t.status} = 'draft' and ${t.startedAt} is null and ${t.endedAt} is null)
       or (${t.status} = 'live' and ${t.startedAt} is not null and ${t.endedAt} is null)
       or (${t.status} = 'ended' and ${t.startedAt} is not null and ${t.endedAt} is not null
           and ${t.endedAt} >= ${t.startedAt})`,
    ),
  ],
);

/**
 * One card pulled during a break (FR-2.2), in order.
 *
 * `valueCentsAtPull` is frozen at the moment of the pull: the point of a break log is what
 * it was worth then, and a later price move must not silently rewrite history. Phase 4
 * hash-chains this table; the append-only grants land here now so that stays possible.
 */
export const breakPulls = app.table(
  'break_pulls',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    breakId: uuid('break_id')
      .notNull()
      .references(() => breaks.id, { onDelete: 'cascade' }),
    cardVariantId: uuid('card_variant_id').references(() => cardVariants.id, {
      onDelete: 'set null',
    }),
    /** Free-text fallback, so a creator is never blocked by a gap in the catalog. */
    label: text('label'),
    valueCentsAtPull: integer('value_cents_at_pull').notNull().default(0),
    /**
     * `manual` by default, which is what every pull logged before the calculator existed
     * was: a number a person typed. Only those are evidence (see `pullValueSource`).
     */
    valueSource: pullValueSource('value_source').notNull().default('manual'),
    /**
     * Hash chain (SR-4.1). Each row commits to every row before it, so a value edited later
     * breaks every hash from that point on and the public page can say *which pull* was
     * changed. Rows written before the chain existed have nulls and are reported as
     * unverifiable rather than as valid — an absent proof is not a passing one.
     */
    prevHash: text('prev_hash'),
    rowHash: text('row_hash'),
    /** Position in the break, assigned server-side. */
    seq: integer('seq').notNull(),
    pulledAt: timestamp('pulled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('break_pulls_break_idx').on(t.breakId, t.seq),
    uniqueIndex('break_pulls_break_seq_key').on(t.breakId, t.seq),
    check('break_pulls_seq_positive', sql`${t.seq} >= 1`),
    // Both or neither: half a chain link is not a state worth being able to represent.
    check('break_pulls_chain_complete', sql`(${t.prevHash} is null) = (${t.rowHash} is null)`),
    check('break_pulls_value_non_negative', sql`${t.valueCentsAtPull} >= 0`),
    // Something must identify the card, or the row says nothing.
    check(
      'break_pulls_identified',
      sql`${t.cardVariantId} is not null or length(btrim(coalesce(${t.label}, ''))) > 0`,
    ),
  ],
);

/**
 * Where in the VOD a pull happened (FR-4.4).
 *
 * **Deliberately not a column on `break_pulls`,** for two reasons that point the same way.
 *
 * The practical one: that table has UPDATE revoked from every application role (migration
 * 0011), because a pull log that can be edited is not a log. A timestamp is added *after* the
 * stream, when the VOD exists, so it could never be written there.
 *
 * The honest one: the hash chain commits to six fields, and a VOD link is not among them.
 * Adding one would invalidate every chain ever written, and pretending the link is covered by
 * the proof would be worse than not having it — so it lives outside, is editable, and the
 * public page says plainly which parts a viewer can verify and which they are taking on
 * trust. A wrong timestamp points at the wrong moment; a wrong value in the log would be a
 * different kind of claim, and only one of those is worth making permanent.
 */
export const pullEvidence = app.table(
  'pull_evidence',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    breakPullId: uuid('break_pull_id')
      .notNull()
      .unique()
      .references(() => breakPulls.id, { onDelete: 'cascade' }),
    /** Seconds into the VOD. The link itself usually comes from the break. */
    offsetSeconds: integer('offset_seconds').notNull(),
    /** An override, for a break split across more than one VOD. Null means "use the break's". */
    vodUrl: text('vod_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pull_evidence_pull_key').on(t.breakPullId),
    check('pull_evidence_offset_range', sql`${t.offsetSeconds} between 0 and 86400`),
    check('pull_evidence_vod_url_https', sql`${t.vodUrl} is null or ${t.vodUrl} like 'https://%'`),
  ],
);

/**
 * Commit–reveal for a randomised break (FR-4.2).
 *
 * One row per break, written *before* it starts. The commitment is published immediately;
 * the seed itself is encrypted at rest (SR-4.2) and only decrypted into `revealed_seed` when
 * the break ends. Until then nobody — including a database backup, including us — can
 * predict the assignment.
 *
 * The client seed is the audience's contribution: a value they watch being chosen, so the
 * result cannot be something we picked alone. Typically a future block hash or a number the
 * creator types on stream.
 */
export const breakCommitments = app.table(
  'break_commitments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    breakId: uuid('break_id')
      .notNull()
      .references(() => breaks.id, { onDelete: 'cascade' }),
    /** `sha256(serverSeed)`, published before the break. */
    commitment: text('commitment').notNull(),
    /** AES-256-GCM, keyed from DATA_ENCRYPTION_KEYS. Never returned by any route. */
    serverSeedEncrypted: text('server_seed_encrypted').notNull(),
    /** The audience's contribution. Null until they give one. */
    clientSeed: text('client_seed'),
    /** Plaintext, and only ever after the break has ended. Null is the normal state. */
    revealedSeed: text('revealed_seed'),
    /** How many slots the shuffle assigns. Fixed at commit time. */
    slotCount: integer('slot_count').notNull(),
    /** Pinned per break, so an old result stays verifiable when the algorithm moves on. */
    algorithmVersion: text('algorithm_version').notNull(),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull().defaultNow(),
    revealedAt: timestamp('revealed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('break_commitments_break_key').on(t.breakId),
    check('break_commitments_slot_count', sql`${t.slotCount} between 2 and 1000`),
    check('break_commitments_commitment_hex', sql`${t.commitment} ~ '^[0-9a-f]{64}$'`),
    // A revealed seed and its timestamp arrive together or not at all.
    check(
      'break_commitments_reveal_complete',
      sql`(${t.revealedSeed} is null) = (${t.revealedAt} is null)`,
    ),
    // You cannot reveal before the audience has contributed: a seed revealed while the
    // client seed is still open would let the client seed be chosen to suit the outcome.
    check(
      'break_commitments_client_seed_first',
      sql`${t.revealedSeed} is null or ${t.clientSeed} is not null`,
    ),
  ],
);
