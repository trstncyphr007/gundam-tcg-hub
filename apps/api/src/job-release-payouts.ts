import { canReleaseHold, holdReviewableAt, parseEnv } from '@gth/core';
import { createDb, heldSellers, releaseSellerPayouts, writeAuditLog } from '@gth/db';
import { z } from 'zod';
import { createStripeClient } from './payments/stripe.js';

/**
 * Lift a new seller's payout hold once they have earned it (FR-5.6).
 *
 *   docker compose --profile jobs run --rm release-payouts
 *
 * A connected account is created with a **manual** payout schedule, so the money a sale earns
 * reaches the seller's Stripe balance and not their bank. This job switches accounts to `daily`
 * once they have enough completed orders and enough time since the first of them.
 *
 * ## The order of operations is the control
 *
 * Stripe first, then the row. If the Stripe call fails the seller must still *look* held,
 * because the row is what the next run reads — clearing it first and then failing would leave
 * an account whose payouts are manual forever and whose row says otherwise.
 *
 * ## If this never runs
 *
 * Nothing breaks and nobody is at risk; sellers simply stay held. That is the right way round
 * for a job that releases money — the failure mode of it not running is a complaint, and the
 * failure mode of the opposite would be fraud.
 *
 * Runs as the **worker**, the only role that may write `hold_until`.
 */
const env = parseEnv(
  z.object({
    DATABASE_URL_WORKER: z.string().startsWith('postgres'),
    STRIPE_SECRET_KEY: z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/u),
  }),
);

const stripe = createStripeClient({ secretKey: env.STRIPE_SECRET_KEY });
const { db, close } = createDb({ url: env.DATABASE_URL_WORKER, max: 1 });

try {
  const held = await heldSellers(db);
  if (held.length === 0) {
    console.log('no sellers are on a payout hold');
  } else {
    let released = 0;
    for (const seller of held) {
      const decision = canReleaseHold(seller);
      if (!decision.release) {
        const at = holdReviewableAt(seller);
        console.log(
          `holding ${seller.stripeAccountId}: ${decision.reason}` +
            (at === null ? '' : ` (reviewable ${at.toISOString()})`),
        );
        continue;
      }

      try {
        // Stripe first. See the header: the row must keep saying "held" if this throws.
        await stripe.setPayoutSchedule(seller.stripeAccountId, 'daily');
        await releaseSellerPayouts(db, seller.stripeAccountId);
        await writeAuditLog(db, {
          action: 'seller.payouts_released',
          targetType: 'seller_account',
          targetId: seller.stripeAccountId,
          diff: { completedOrders: seller.completedOrders },
        });
        released += 1;
        console.log(`released ${seller.stripeAccountId}`);
      } catch (error) {
        // One account failing does not stop the rest. A seller left held is inconvenienced;
        // a job that stops at the first failure leaves everybody behind it held too.
        console.error(
          `could not release ${seller.stripeAccountId}:`,
          error instanceof Error ? error.name : 'unknown',
        );
      }
    }
    console.log(`released ${String(released)} of ${String(held.length)} held seller(s)`);
  }
} finally {
  await close();
}
