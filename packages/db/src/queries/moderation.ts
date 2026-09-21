import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  type FlaggedObservation,
  listFlaggedObservations,
  reviewFlaggedObservation,
} from './live-sales.js';
import { type CardCondition, moderateObservation } from './pricing.js';

/**
 * The moderation queues (SR-3.5, SR-4.4).
 *
 * Two different questions, kept visibly apart because they are answered differently:
 *
 *  - a **user report** is someone telling us about a sale. It counts for nothing until a
 *    person approves it — the default is "no".
 *  - a **flagged observation** is one of our own first-party sources (a live sale) whose
 *    price sat far outside the published spread. It is already approved; the flag holds it
 *    out of the index until a person clears it — the default is "not yet".
 *
 * Reads run on whichever pool the caller hands in. **Decisions do not**: they take the
 * worker pool explicitly, because that is the only role permitted to mark a price as
 * counting (migration 0027). The web tier can look at the queue and cannot change it.
 */

export type ModerationDecision = 'approve' | 'reject';
export type FlagDecision = 'clear' | 'reject';

/** Every decision states why (SR-5.9). Short enough to write, long enough to mean something. */
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 280;

export class ModerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModerationError';
  }
}

export interface PendingReport {
  id: string;
  cardVariantId: string;
  cardName: string | null;
  condition: CardCondition;
  priceCents: number;
  currency: string;
  saleType: string;
  observedAt: Date;
  reportedAt: Date;
  evidenceRef: string | null;
  medianCents: number | null;
  /**
   * How many reports this person has waiting, including this one. A reviewer seeing twenty
   * reports from one account in an afternoon is looking at a different situation from one
   * report each from twenty people, and should know which.
   */
  reporterPending: number;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Reports waiting for a decision, oldest first.
 *
 * Carries no reporter identity — not an email, not a name, not the id. A reviewer needs to
 * judge the price and its evidence, and knowing *who* sent it invites judging the person
 * instead. `reporterPending` says what matters about them without saying who they are.
 */
export async function listPendingReportsForReview(
  db: Database,
  limit = 50,
): Promise<PendingReport[]> {
  const rows = await db.execute<{
    id: string;
    card_variant_id: string;
    card_name: string | null;
    condition: CardCondition;
    price_cents: number;
    currency: string;
    sale_type: string;
    observed_at: string | Date;
    created_at: string | Date;
    evidence_ref: string | null;
    median_cents: number | null;
    reporter_pending: number;
  }>(sql`
    select o.id, o.card_variant_id, c.name as card_name, o.condition, o.price_cents,
           o.currency, o.sale_type, o.observed_at, o.created_at, o.evidence_ref,
           (select d.median_cents from app.price_index_daily d
             where d.card_variant_id = o.card_variant_id
               and d.condition = o.condition
               and d.currency = o.currency
             order by d.day desc limit 1) as median_cents,
           (select count(*)::int from app.price_observations p
             where p.reporter_id = o.reporter_id
               and p.source = 'user_report'
               and p.approved_at is null
               and p.rejected_at is null) as reporter_pending
      from app.price_observations o
      left join app.card_variants v on v.id = o.card_variant_id
      left join app.cards c on c.id = v.card_id
     where o.source = 'user_report'
       and o.approved_at is null
       and o.rejected_at is null
     order by o.created_at asc
     limit ${Math.min(Math.max(limit, 1), 200)}
  `);

  return rows.map((r) => ({
    id: r.id,
    cardVariantId: r.card_variant_id,
    cardName: r.card_name,
    condition: r.condition,
    priceCents: r.price_cents,
    currency: r.currency,
    saleType: r.sale_type,
    observedAt: toDate(r.observed_at),
    reportedAt: toDate(r.created_at),
    evidenceRef: r.evidence_ref,
    medianCents: r.median_cents,
    reporterPending: r.reporter_pending,
  }));
}

export interface ModerationQueue {
  reports: PendingReport[];
  flagged: FlaggedObservation[];
}

export async function getModerationQueue(db: Database): Promise<ModerationQueue> {
  const [reports, flagged] = await Promise.all([
    listPendingReportsForReview(db),
    listFlaggedObservations(db),
  ]);
  return { reports, flagged };
}

/** Trim, and refuse a reason that says nothing. */
export function normaliseReason(reason: string): string {
  const trimmed = reason.trim().replace(/\s+/gu, ' ');
  if (trimmed.length < MIN_REASON_LENGTH) {
    throw new ModerationError('give a reason for the decision');
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new ModerationError(`a reason must be ${String(MAX_REASON_LENGTH)} characters or fewer`);
  }
  return trimmed;
}

/**
 * Decide a user report (SR-3.5). Returns false when it was already decided.
 *
 * `workerDb` by name, so the pool a decision runs on is visible at every call site. The web
 * pool would fail with "permission denied" (its UPDATE is revoked); the quieter mistake is a
 * role that has the privilege but no row policy, whose UPDATE matches nothing and reports
 * success — which is exactly how this looked before migration 0027.
 */
export async function decideReport(
  workerDb: Database,
  observationId: string,
  decision: ModerationDecision,
): Promise<boolean> {
  return moderateObservation(workerDb, observationId, decision);
}

/** Clear or reject a flagged first-party observation (SR-4.4). False when already decided. */
export async function decideFlag(
  workerDb: Database,
  observationId: string,
  decision: FlagDecision,
): Promise<boolean> {
  return reviewFlaggedObservation(workerDb, observationId, decision);
}
