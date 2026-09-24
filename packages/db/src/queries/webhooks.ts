import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { webhookEvents } from '../schema/market.js';

/**
 * Making a webhook happen exactly once (SR-5.2).
 *
 * Stripe retries. It retries on a timeout, on a 500, on a network blip, and on anything that
 * is not a prompt 2xx — which is correct of them and means we will be told about the same
 * payment more than once. A retry processed twice is an order shipped twice or a refund
 * issued twice.
 *
 * The unique index on `(provider, event_id)` is the entire mechanism. **Claim first, then
 * act**: the insert either succeeds, in which case this delivery is ours to handle, or it
 * conflicts, in which case somebody already has it and there is nothing to do. No read, no
 * gap between checking and acting, nothing two concurrent deliveries can both win.
 *
 * Worker role only. A webhook is not a session, and migration 0041 gives the web role nothing
 * on this table at all.
 */

export type WebhookClaim =
  /** Ours to handle. */
  | { claimed: true; id: string }
  /** Somebody already did, or is doing it. */
  | { claimed: false };

export async function claimWebhookEvent(
  db: Database,
  input: { provider: string; eventId: string; type: string },
): Promise<WebhookClaim> {
  const rows = await db
    .insert(webhookEvents)
    .values({ provider: input.provider, eventId: input.eventId, type: input.type })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });

  const row = rows[0];
  return row ? { claimed: true, id: row.id } : { claimed: false };
}

/**
 * Mark it done.
 *
 * Separate from the claim so a crash half way through leaves a row with `processed_at` null —
 * visible afterwards as "we were told and did not finish", which is a thing worth being able
 * to find. A claim that also marked itself processed would make a crash indistinguishable
 * from a success.
 */
export async function markWebhookProcessed(db: Database, id: string): Promise<void> {
  await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, id));
}

/** Deliveries we accepted and never finished. For an operator asking what is stuck. */
export async function unprocessedWebhooks(
  db: Database,
  provider = 'stripe',
): Promise<{ eventId: string; type: string; receivedAt: Date }[]> {
  const rows = await db
    .select({
      eventId: webhookEvents.eventId,
      type: webhookEvents.type,
      receivedAt: webhookEvents.receivedAt,
    })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, provider), sql`${webhookEvents.processedAt} is null`))
    .orderBy(webhookEvents.receivedAt);
  return rows;
}
