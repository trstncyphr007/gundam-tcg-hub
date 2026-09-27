/**
 * Create or repair the v2 event destination that carries Connect capability changes (ADR-045).
 *
 * Accounts v2 does not deliver account events to a v1 webhook endpoint. They arrive on a
 * separate feed with its own subscription object and its own signing secret, and that object
 * has to exist before a single capability change reaches us. Nothing in the application creates
 * it, so without this command a deployment looks healthy and sellers silently never become
 * able to sell.
 *
 * This is the same shape of trap as the storage bucket's CORS policy (ADR-043): a setting that
 * lives outside the codebase, that no server-side test can see, and that had never been applied
 * anywhere. It gets a command for the same reason — so the step is exercised rather than
 * remembered.
 *
 *     pnpm stripe:destination                       # show what exists
 *     pnpm stripe:destination --url https://…       # create it, print the secret once
 *
 * The signing secret is returned by Stripe **only at creation**. It is printed once, here, and
 * belongs in `STRIPE_V2_WEBHOOK_SECRET`. Losing it means deleting the destination and making
 * another.
 */
import Stripe from 'stripe';
import { loadConfig } from '../config.js';

/**
 * The account events we act on, and nothing else.
 *
 * `capability_status_updated` is the one that matters: it fires when Stripe decides a seller
 * may or may not receive transfers, which is the only fact `seller_accounts` stores. The other
 * two are subscribed because they change what a seller sees about their own onboarding, and an
 * event we chose not to receive is much harder to notice than one we receive and ignore.
 */
const ENABLED_EVENTS = [
  'v2.core.account[configuration.recipient].capability_status_updated',
  'v2.core.account[requirements].updated',
  'v2.core.account_link.completed',
];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export async function main(argv: string[]): Promise<void> {
  const config = loadConfig();
  if (config.STRIPE_SECRET_KEY === undefined) fail('STRIPE_SECRET_KEY is not set.');

  const stripe = new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
  const urlIndex = argv.indexOf('--url');
  const url = urlIndex === -1 ? undefined : argv[urlIndex + 1];

  const existing = await stripe.v2.core.eventDestinations.list({ limit: 100 });
  const ours = existing.data.filter((d) =>
    d.enabled_events.some((e) => e.startsWith('v2.core.account')),
  );

  if (url === undefined) {
    console.log(
      `${String(existing.data.length)} event destination(s); ` +
        `${String(ours.length)} carrying account events.`,
    );
    for (const d of ours) {
      console.log(`  ${d.id}  ${d.status}  payload=${d.event_payload}`);
      for (const e of d.enabled_events) console.log(`      ${e}`);
    }
    if (ours.length === 0) {
      console.log('\nNothing is listening for capability changes. Sellers will never become');
      console.log('able to sell. Create one with:');
      console.log('  pnpm stripe:destination --url https://api.<host>/v1/webhooks/stripe-v2');
    }
    return;
  }

  if (!url.startsWith('https://')) fail(`Refusing a non-https destination: ${url}`);
  if (!url.endsWith('/v1/webhooks/stripe-v2')) {
    // The v1 endpoint cannot verify a v2 signature — it would reject every event with a 400,
    // which looks exactly like an attack and is actually a typo.
    fail(`Refusing: the path must be /v1/webhooks/stripe-v2, got ${url}`);
  }

  const created = await stripe.v2.core.eventDestinations.create({
    name: 'gundam-tcg-hub connect capabilities',
    description: 'Seller capability changes (ADR-045)',
    // Thin, because Stripe refuses `snapshot` for account events — an event destination asking
    // for one is rejected at creation. The handler re-reads the account anyway.
    event_payload: 'thin',
    /**
     * **No `events_from` filter.** The default is every account, and narrowing it breaks this.
     *
     * The first version said `['@accounts']`, reasoning that a connected account's capability
     * change is news from that account. It is not: these events are emitted by the **platform**
     * about the connected account, so `@accounts` — "connected accounts only" — excluded every
     * one of them.
     *
     * The failure was silent in the worst way. Stripe emitted
     * `capability_status_updated` on schedule, the subscription sat there enabled and healthy,
     * and nothing arrived. A seller completed onboarding, became `active` at Stripe, and stayed
     * unable to sell with no error anywhere to explain why. Found by watching a real onboarding
     * rather than by any test.
     */
    enabled_events: ENABLED_EVENTS,
    type: 'webhook_endpoint',
    webhook_endpoint: { url },
    include: ['webhook_endpoint.signing_secret'],
  });

  const secret = created.webhook_endpoint?.signing_secret;
  console.log(`Created ${created.id} -> ${url}`);
  console.log(`  status: ${created.status}, payload: ${created.event_payload}`);
  for (const e of created.enabled_events) console.log(`      ${e}`);
  console.log('\nPut this in STRIPE_V2_WEBHOOK_SECRET. Stripe will not show it again:\n');
  console.log(`  STRIPE_V2_WEBHOOK_SECRET=${secret ?? '(not returned — delete and recreate)'}\n`);
}

await main(process.argv.slice(2));
