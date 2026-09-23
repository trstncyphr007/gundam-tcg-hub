import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { asUser } from './watches.js';

/**
 * Honouring deletions after a restore (SR-X.25, ADR-027, `docs/runbooks/restore.md`).
 *
 * When someone deletes their account we tell them it is gone. A backup taken before that
 * still contains them, so **every** restore brings deleted people back unless something puts
 * them out again. The runbook has always said so — and then asked an operator to hand-write a
 * transaction per account, from a query they typed themselves, while restoring a database.
 *
 * That is the wrong moment to be composing SQL. This is the same work as one command that
 * shows what it will do before it does it.
 *
 * The audit log is the source of truth: every deletion writes one append-only row holding the
 * account id and no email, which is exactly enough to repeat the deletion and nothing more.
 */
export const DELETION_ACTION = 'account.deleted';

export interface RecordedDeletion {
  userId: string;
  at: Date;
}

/**
 * Deletions recorded after a point in time — the snapshot you restored.
 *
 * Read from wherever the newest audit log is: usually the live database, because the restored
 * one is by definition older than the deletions being re-applied.
 */
export async function listDeletionsSince(db: Database, since: Date): Promise<RecordedDeletion[]> {
  const rows = await db.execute<{ target_id: string; at: string }>(sql`
    select target_id, at
      from app.audit_log
     where action = ${DELETION_ACTION}
       and target_id is not null
       and at >= ${since.toISOString()}::timestamptz
     order by at
  `);
  return rows.map((row) => ({ userId: row.target_id, at: new Date(row.at) }));
}

export type ReapplyOutcome = 'deleted' | 'absent';

/**
 * Delete one account again, through the same function the account page uses.
 *
 * Going through `app.delete_account` rather than a hand-written `DELETE` is the point: it
 * cascades what was only theirs, removes unpublished reports and anonymises approved ones.
 * A hand-written delete during an incident would do the first and forget the rest.
 *
 * `absent` when the id was not in the snapshot — which is the common case and not an error:
 * it means that restore did not bring them back.
 */
export async function reapplyDeletion(db: Database, userId: string): Promise<ReapplyOutcome> {
  return asUser(db, userId, async (tx) => {
    const [row] = await tx.execute<{ email: string | null }>(
      sql`select app.delete_account(${userId}) as email`,
    );
    return row?.email == null ? 'absent' : 'deleted';
  });
}
