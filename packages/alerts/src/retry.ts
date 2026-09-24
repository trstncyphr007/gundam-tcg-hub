import {
  type Database,
  abandonDelivery,
  claimRetryableDeliveries,
  findFanOutTargets,
  markDeliveryFailed,
  markDeliverySent,
} from '@gth/db';
import type { Channel } from './dispatcher.js';
import type { RestockMessage, Transport } from './transports.js';

/**
 * Send the alerts we still owe (FR-1.8).
 *
 * Fan-out happens inside the scanner's own request, which is right — an alert is worth having
 * in the first minute and much less in the tenth. But it meant one pass and no second chance:
 * a Discord 429, an SMTP hiccup, or the process dying between claiming a row and sending it,
 * and the person who asked to be told a box was back in stock was simply never told. The
 * transports had always worked out whether a failure was worth retrying; nothing acted on it.
 *
 * This is the second chance, as a job rather than a loop inside the request, so a slow or
 * broken channel cannot hold up the scanner or anybody else's alert.
 *
 * Three bounds, and each is there for its own reason:
 *
 *  - **attempts** — five, then the row is `failed` and stays that way. A channel that has
 *    refused five times is not going to accept the sixth.
 *  - **the event's age** — a day. Telling somebody a box came back in stock yesterday is not a
 *    late alert, it is a wrong one, and an apology is better than a lie.
 *  - **how long the row has sat** — two minutes, so this never races the fan-out that is
 *    delivering it right now. Combined with `FOR UPDATE SKIP LOCKED` in the claim, two runs of
 *    this job cannot collide either.
 */
export interface RetryDeps {
  db: Database;
  transports: Partial<Record<Channel, Transport>>;
  buildMessage: (
    db: Database,
    retailerProductId: string,
    priceCents: number | null,
    currency: string,
    /** The event's own time. A retry must not claim the stock came back just now. */
    detectedAt: Date,
  ) => Promise<RestockMessage | null>;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  maxAttempts?: number;
  staleAfterSeconds?: number;
  eventWithinHours?: number;
  limit?: number;
}

export interface RetryResult {
  considered: number;
  sent: number;
  stillOwed: number;
  abandoned: number;
}

export async function retryOwedDeliveries(deps: RetryDeps): Promise<RetryResult> {
  const maxAttempts = deps.maxAttempts ?? 5;
  const owed = await claimRetryableDeliveries(deps.db, {
    maxAttempts,
    ...(deps.staleAfterSeconds === undefined ? {} : { staleAfterSeconds: deps.staleAfterSeconds }),
    ...(deps.eventWithinHours === undefined ? {} : { eventWithinHours: deps.eventWithinHours }),
    ...(deps.limit === undefined ? {} : { limit: deps.limit }),
  });
  const result: RetryResult = { considered: owed.length, sent: 0, stillOwed: 0, abandoned: 0 };
  if (owed.length === 0) return result;

  // One message and one target lookup per event, however many deliveries it owes.
  const messages = new Map<string, RestockMessage | null>();
  const targets = new Map<string, Map<string, Awaited<ReturnType<typeof findFanOutTargets>>[0]>>();

  for (const delivery of owed) {
    const key = delivery.retailerProductId;
    if (!messages.has(key)) {
      messages.set(
        key,
        await deps.buildMessage(
          deps.db,
          key,
          delivery.priceCents,
          delivery.currency,
          delivery.detectedAt,
        ),
      );
      const found = await findFanOutTargets(deps.db, key);
      targets.set(key, new Map(found.map((t) => [t.subscriptionId, t])));
    }

    const message = messages.get(key) ?? null;
    const target = targets.get(key)?.get(delivery.subscriptionId);
    const transport = deps.transports[delivery.channel];

    // The listing, the watch or the channel has gone since the event. Nothing to send and
    // nothing to wait for, so stop counting it as owed.
    if (!message || !target || !transport) {
      await abandonDelivery(
        deps.db,
        delivery.id,
        !message ? 'listing gone' : !target ? 'watch gone' : `no transport for ${delivery.channel}`,
      );
      result.abandoned += 1;
      continue;
    }

    const outcome = await transport.send(message, {
      email: target.email,
      displayName: target.displayName,
    });

    if (outcome.ok === true) {
      await markDeliverySent(deps.db, delivery.id);
      result.sent += 1;
      continue;
    }

    const reason = outcome.ok === 'skipped' ? outcome.reason : outcome.reason;
    const worthAnother =
      outcome.ok !== 'skipped' && outcome.retryable && delivery.attempts + 1 < maxAttempts;

    await markDeliveryFailed(deps.db, delivery.id, reason, worthAnother ? 'pending' : 'failed');
    if (worthAnother) {
      result.stillOwed += 1;
    } else {
      result.abandoned += 1;
      // The one an operator should see: we told somebody we would tell them, and we have now
      // stopped trying. userId, never an address (SR-X.20).
      deps.logger?.warn(
        {
          deliveryId: delivery.id,
          channel: delivery.channel,
          userId: target.userId,
          attempts: delivery.attempts + 1,
        },
        'alert abandoned after repeated failures',
      );
    }
  }

  return result;
}

/** Summary lines, in the shape the other scheduled jobs print. */
export async function alertRetryJob(deps: RetryDeps): Promise<string[]> {
  const result = await retryOwedDeliveries(deps);
  if (result.considered === 0) return ['no alerts owed'];
  return [
    `considered ${String(result.considered)}`,
    `sent ${String(result.sent)}`,
    `still owed ${String(result.stillOwed)}`,
    `abandoned ${String(result.abandoned)}`,
  ];
}
