import {
  type Database,
  claimDeliveries,
  findFanOutTargets,
  markDeliveryFailed,
  markDeliverySent,
} from '@gth/db';
import type { RestockMessage, Transport } from './transports.js';

export type Channel = 'email' | 'discord_dm' | 'discord_webhook' | 'web_push';

export interface DispatchDeps {
  db: Database;
  /** One transport per channel; missing channels are recorded as skipped. */
  transports: Partial<Record<Channel, Transport>>;
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface DispatchResult {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Of the failures, how many are still owed and will be tried again. */
  retryable: number;
}

/**
 * Fan one restock event out to every watcher (FR-1.8).
 *
 * Delivery slots are claimed first, so a crash or retry mid-flight cannot double-send:
 * only newly claimed rows are attempted. Individual failures are recorded and never abort
 * the run, so one broken webhook cannot block everyone else's alerts.
 */
export async function dispatchRestockEvent(
  deps: DispatchDeps,
  event: { id: string; retailerProductId: string },
  message: RestockMessage,
): Promise<DispatchResult> {
  const targets = await findFanOutTargets(deps.db, event.retailerProductId);
  const claimed = await claimDeliveries(deps.db, event.id, targets);

  const byId = new Map(targets.map((t) => [t.subscriptionId, t]));
  const result: DispatchResult = {
    claimed: claimed.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    retryable: 0,
  };

  for (const delivery of claimed) {
    const target = byId.get(delivery.subscriptionId);
    const transport = deps.transports[delivery.channel];

    if (!target) {
      await markDeliveryFailed(deps.db, delivery.id, 'subscription vanished', 'skipped');
      result.skipped += 1;
      continue;
    }
    if (!transport) {
      await markDeliveryFailed(
        deps.db,
        delivery.id,
        `no transport for ${delivery.channel}`,
        'skipped',
      );
      result.skipped += 1;
      continue;
    }

    const outcome = await transport.send(message, {
      email: target.email,
      displayName: target.displayName,
    });

    if (outcome.ok === true) {
      await markDeliverySent(deps.db, delivery.id);
      result.sent += 1;
    } else if (outcome.ok === 'skipped') {
      await markDeliveryFailed(deps.db, delivery.id, outcome.reason, 'skipped');
      result.skipped += 1;
    } else {
      // **`retryable` is the whole point of this branch.** Every transport works out whether
      // the failure might not happen next time -- a Discord 429, a 5xx, a timeout -- and that
      // answer used to be thrown away here, marking everything `failed` and terminal. Nothing
      // ever looked at a failed row again, so a momentary blip meant the person who asked to
      // be told a box was back in stock was simply never told, and nothing said so.
      //
      // `pending` means "still owed". `alert-retry` picks those up (FR-1.8).
      const status = outcome.retryable ? 'pending' : 'failed';
      await markDeliveryFailed(deps.db, delivery.id, outcome.reason, status);
      result.failed += 1;
      if (status === 'pending') result.retryable += 1;
      // userId, not email: delivery logs stay free of personal data (SR-X.20).
      deps.logger?.warn(
        {
          deliveryId: delivery.id,
          channel: delivery.channel,
          userId: target.userId,
          willRetry: status === 'pending',
        },
        'alert delivery failed',
      );
    }
  }

  return result;
}
