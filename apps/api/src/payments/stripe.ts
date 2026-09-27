import Stripe from 'stripe';

/**
 * The only module in this codebase that talks to Stripe (ADR-011, ADR-030).
 *
 * Semgrep's `gth-no-outbound-http` names this file as its second exception, after the Discord
 * transport. The rule enumerated HTTP libraries rather than outbound capability, so importing
 * an SDK would have slipped past it entirely — `stripe` is named in the rule now, and excluded
 * here on purpose rather than by omission.
 *
 * The SSRF questions that rule exists to ask have easy answers here: one fixed host, the
 * official client, and **no user-supplied URL anywhere**. The return and refresh URLs handed
 * to an account link are built from our own configured base, never from a request.
 *
 * ## What this deliberately does not do
 *
 * It never sees a card. Checkout is hosted on Stripe's own domain, which is the whole reason
 * this project stays at PCI SAQ-A (SR-5.1) — no card number, expiry or CVC reaches our
 * servers, our logs or our database, and there is no code here that could.
 *
 * It never decides that money moved. That is what the webhook is for.
 */

/**
 * Pinned, so Stripe changing its default does not change our behaviour silently.
 *
 * It must match the version the installed SDK's types were generated against — they disagree
 * at compile time if it does not, which is the right place to find out. Bumping this is a
 * deliberate act with a changelog to read, not something that happens on a Tuesday.
 */
const API_VERSION = '2026-08-26.dahlia';

/**
 * What Stripe says a capability may do, in Stripe's own four states (ADR-045).
 *
 * Kept whole rather than flattened to a boolean at the edge, because `pending` and `restricted`
 * are different sentences to say to a seller: one is "Stripe is still looking", the other is
 * "Stripe wants something from you". Accounts v1 could not tell them apart.
 */
export type CapabilityStatus = 'active' | 'pending' | 'restricted' | 'unsupported';

export interface AccountStatus {
  /**
   * May a sale send this seller money — the transfer leg of a destination charge.
   *
   * **This is the capability that was always the right one to read**, and under Accounts v1 we
   * read `charges_enabled` instead. That field answers "may this account create its own
   * charges", which our flow never asks it to do: the platform takes the payment and transfers
   * onward. v1 made the wrong field convenient; v2 does not offer it at all.
   */
  transfers: CapabilityStatus;
  /** May Stripe move that money on to their bank. */
  payouts: CapabilityStatus;
  /** Has the seller finished Stripe's hosted form. */
  detailsSubmitted: boolean;
}

/** A v2 event, as it arrives: an identifier and a pointer, with no payload to trust. */
export interface V2EventNotification {
  id: string;
  type: string;
  /** The account (or other object) the event is about. */
  relatedObjectId: string | null;
  relatedObjectType: string | null;
}

export interface StripeClient {
  /** Start a Connect account for a seller (FR-5.1, ADR-045: v2 `recipient` configuration). */
  createConnectedAccount: (input: {
    userId: string;
    email?: string | undefined;
  }) => Promise<{ accountId: string }>;
  /** A one-time link to Stripe's hosted onboarding. Short-lived; Stripe decides how long. */
  createOnboardingLink: (input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }) => Promise<{ url: string }>;
  /** Stripe's answer about what this account may do. Never ours to assert. */
  getAccountStatus: (accountId: string) => Promise<AccountStatus>;
  /** Verify a webhook against the raw body and the signing secret (SR-5.2). */
  constructEvent: (rawBody: Buffer | string, signature: string) => Stripe.Event;
  /**
   * Verify a **v2** event against the raw body and the v2 destination's own secret.
   *
   * A separate method rather than a flag, because it is a separate secret, a separate endpoint
   * and a separate payload shape. Conflating them would mean one misconfiguration could let an
   * event signed for one feed be accepted on the other.
   */
  verifyV2Event: (rawBody: Buffer | string, signature: string) => V2EventNotification;
  /** A hosted Checkout session for one order (FR-5.3). */
  createCheckoutSession: (input: CheckoutInput) => Promise<{ id: string; url: string }>;
  /**
   * Ask Stripe to give the money back (FR-5.5).
   *
   * **This does not refund the order.** It asks Stripe to refund the payment; the order moves
   * when the resulting `charge.refunded` webhook arrives. Those are two different sentences and
   * the difference is the control — see `markOrderRefunded`.
   */
  refundPayment: (input: RefundInput) => Promise<{ id: string; status: string | null }>;
  /**
   * Hold or release a connected account's payouts (FR-5.6).
   *
   * `manual` leaves the money in the seller's Stripe balance — visible to them, not yet in
   * their bank. It is not a delayed transfer: with a destination charge Stripe has already
   * transferred, and this is what "hold" can actually mean.
   */
  setPayoutSchedule: (accountId: string, schedule: 'manual' | 'daily') => Promise<void>;
}

export interface RefundInput {
  paymentIntentId: string;
  /** Ours, so the refund is traceable to the order without a lookup. */
  orderId: string;
  /** Omitted refunds the whole payment, which is the only case slice 6 offers. */
  amountCents?: number | undefined;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer' | undefined;
  /**
   * Whether the seller gives back their share too.
   *
   * `true` claws the transfer back from the connected account, which is right when the seller
   * is at fault — they had the money for a card that never arrived. `false` leaves them paid
   * and the platform out of pocket, which is a goodwill decision somebody makes deliberately.
   */
  reverseTransfer?: boolean | undefined;
  /** And whether we give our fee back with it. Refunding a sale we earned nothing on. */
  refundApplicationFee?: boolean | undefined;
}

export interface CheckoutInput {
  /** Ours. It travels in the metadata and comes back on the webhook. */
  orderId: string;
  /** The seller's connected account. The money goes there, less our fee. */
  destinationAccountId: string;
  description: string;
  amountCents: number;
  currency: string;
  quantity: number;
  applicationFeeCents: number;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeOptions {
  secretKey: string;
  webhookSecret?: string | undefined;
  /** The signing secret of the v2 event destination. A different feed, a different secret. */
  v2WebhookSecret?: string | undefined;
  /** Injected by tests. Nothing else should pass this. */
  client?: Stripe | undefined;
}

export class StripeNotConfiguredError extends Error {
  constructor() {
    super('the marketplace is not configured');
    this.name = 'StripeNotConfiguredError';
  }
}

/**
 * Every mutating call carries an idempotency key (SR-5.3).
 *
 * Stripe replays a request with the same key rather than performing it twice, which is what
 * makes a retry after a timeout safe. Without it, "the connection dropped" and "it did not
 * happen" look identical from here, and the safe-looking response is to try again.
 */
function idempotency(scope: string, id: string): Stripe.RequestOptions {
  return { idempotencyKey: `${scope}:${id}` };
}

/**
 * How many keys one account creation may burn before giving up (ADR-044).
 *
 * Bounded because each step costs a round trip. Unbounded, a permanently misconfigured account
 * would turn every onboarding attempt into a slow walk instead of a prompt error.
 */
const MAX_ACCOUNT_KEY_ATTEMPTS = 5;

/**
 * The key for one attempt at creating this person's account.
 *
 * Attempt 0 is the plain `account:<userId>`, and that is what makes a double-click safe: two
 * requests in flight at once send the same key, Stripe performs the work once, and nobody ends
 * up with two connected accounts.
 *
 * Later attempts walk a **fixed sequence** — `account:<userId>/2`, `/3` — rather than taking a
 * random key each. Two callers who both find the earlier keys poisoned still land on the same
 * next one, so Stripe still deduplicates them. A random key per caller would fix the lockout
 * below and buy an orphaned connected account nobody is recorded against, which is worse than
 * the problem it solves.
 */
function accountIdempotency(userId: string, attempt: number): Stripe.RequestOptions {
  return attempt === 0
    ? idempotency('account', userId)
    : { idempotencyKey: `account:${userId}/${String(attempt + 1)}` };
}

/**
 * Whether this error proves Stripe created nothing, so the next attempt may use a new key.
 *
 * This distinction is the entire control, and getting it backwards in either direction is a
 * real failure rather than a style choice.
 *
 * A 400, 401 or 403 means Stripe read the request, refused it and stopped. Nothing exists on
 * the other side, so moving to a fresh key is safe. A timeout, a 5xx or a dropped connection
 * means the opposite: the account may well have been created and we simply never heard the id.
 * That is precisely the case a stable key exists to survive, so those must **not** advance.
 *
 * Rate limits are deliberately absent. Nothing was created, but spending a key would buy what
 * waiting a second gives for free.
 */
/**
 * Narrow whatever arrived into one of the four states, closed by default.
 *
 * `unsupported` rather than `restricted` for the unreadable case: both stop a sale, and
 * `unsupported` is the one that does not imply we know why.
 */
function asCapabilityStatus(value: unknown): CapabilityStatus {
  return value === 'active' || value === 'pending' || value === 'restricted'
    ? value
    : 'unsupported';
}

function provesNothingWasCreated(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError ||
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError ||
    error instanceof Stripe.errors.StripeIdempotencyError
  );
}

export function createStripeClient(options: StripeOptions): StripeClient {
  const stripe =
    options.client ??
    new Stripe(options.secretKey, {
      apiVersion: API_VERSION,
      // Stripe retries idempotent requests itself; this bounds how long a request can hold a
      // web worker before the caller is told something went wrong.
      timeout: 20_000,
      maxNetworkRetries: 2,
      appInfo: { name: 'gundam-tcg-hub' },
    });

  return {
    createConnectedAccount: async ({ userId, email }) => {
      /**
       * A **recipient** configuration, not a merchant one (ADR-045).
       *
       * Stripe's own guidance decides this: `merchant` is for accounts that are the merchant of
       * record — direct charges, or destination charges with `on_behalf_of`. `recipient` is for
       * "destination charges without on_behalf_of set", which is exactly our flow. The platform
       * takes the payment and holds the chargeback liability; the seller receives a transfer.
       *
       * Under v1 we requested `card_payments` as well, which this flow never needed. That was
       * not a bug with consequences, but it was a capability asked of every seller for no
       * reason, and the v2 model does not offer the mistake.
       */
      const params: Stripe.V2.Core.AccountCreateParams = {
        // Stripe's hosted onboarding and its own express dashboard, which is the entire reason
        // this was chosen over building KYC ourselves.
        dashboard: 'express',
        /**
         * The seller's country, which v2 insists on before it will accept a configuration at
         * all: `identity.country is required before setting configuration.recipient`.
         *
         * This is not a new constraint, only a newly visible one. v1's `accounts.create`
         * defaulted `country` to the platform's country without being asked, so every seller
         * this project has ever made was already US. v2 declines to guess.
         *
         * Hard-coded rather than configured because it is a **business** decision, not a
         * deployment one: selling elsewhere means Stripe Tax registrations, different payout
         * rails and a different 1099 story (§23). When that day comes this wants to be a
         * column on the seller, chosen before the account is created — not an env var that
         * silently changes what every future seller is assumed to be.
         */
        identity: { country: 'us' },
        configuration: {
          recipient: {
            capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
          },
        },
        /**
         * The platform collects the fees and owns the losses.
         *
         * This is the v2 spelling of what a destination charge already meant. Saying it at
         * creation keeps it from being a per-payment decision somebody could get wrong later.
         *
         * `currency` is allowed here only because `identity.country` is set above — Stripe
         * refuses one without the other, which is how the country requirement was found.
         */
        defaults: {
          currency: 'usd',
          responsibilities: { fees_collector: 'application', losses_collector: 'application' },
        },
        ...(email === undefined ? {} : { contact_email: email }),
        metadata: { userId },
        // Without this the response omits `configuration` entirely — see `getAccountStatus`.
        include: ['configuration.recipient'],
      };

      /**
       * Walk the key sequence until one is not holding a cached refusal (ADR-044).
       *
       * Stripe keeps the response to an idempotency key for 24 hours **including failures**.
       * Without this loop, one attempt that failed for a reason having nothing to do with the
       * seller — Connect not yet enabled, a bad key, a permission we had not granted — is
       * replayed to that seller for the rest of the day. They press the button, see the same
       * stale error, and nothing they or an operator can do from this side changes it. That is
       * not hypothetical; it happened during the AC-5.1 run and cost a seller their onboarding.
       *
       * The parameters never vary between attempts, so a later key can only differ from an
       * earlier one by being unused.
       */
      const accountId = await (async (): Promise<string> => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            const account = await stripe.v2.core.accounts.create(
              params,
              accountIdempotency(userId, attempt),
            );
            return account.id;
          } catch (error) {
            // Out of keys, or an error that leaves open the possibility that an account exists.
            // Either way the caller gets the real, current error rather than yesterday's.
            if (attempt + 1 >= MAX_ACCOUNT_KEY_ATTEMPTS || !provesNothingWasCreated(error)) {
              throw error;
            }
          }
        }
      })();

      /**
       * Hold the payouts, as a second call, because v2 has nowhere to say it in the first.
       *
       * Under v1 this was `settings.payouts.schedule` at creation, and the comment there said
       * why: a separate call can fail and leave a seller taking payments with their payouts
       * already running. **Accounts v2 has no payout schedule anywhere in its surface**, so the
       * choice is gone — the schedule lives on the v1 account API, which does still answer for
       * a v2 account id (ADR-045 records the probe that established that).
       *
       * Two things make the lost atomicity survivable, and neither is luck:
       *
       * 1. A new account's `stripe_transfers` capability is `restricted` until onboarding
       *    finishes, so **no money can reach it** during the window between these two calls.
       * 2. A failure here throws, so onboarding fails loudly rather than quietly producing a
       *    seller on daily payouts. The account is left behind, and the next attempt adopts it
       *    — `recordSellerAccount` has not run yet, so there is no row claiming otherwise.
       *
       * `releasePayoutHoldsJob` is the only thing that moves this to `daily`, once earned.
       */
      await stripe.accounts.update(
        accountId,
        { settings: { payouts: { schedule: { interval: 'manual' } } } },
        idempotency('account-hold', accountId),
      );

      return { accountId };
    },

    createOnboardingLink: async ({ accountId, returnUrl, refreshUrl }) => {
      // Both URLs are ours, built from configuration. Nothing a request supplies reaches here
      // — an open redirect through an onboarding link would be a phishing page with our name
      // on it.
      //
      // v2 asks which configuration is being onboarded. `recipient`, matching what the account
      // was created with: asking for `merchant` here would collect identity details for a role
      // this seller does not have and cannot use.
      const link = await stripe.v2.core.accountLinks.create({
        account: accountId,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: {
            configurations: ['recipient'],
            return_url: returnUrl,
            refresh_url: refreshUrl,
          },
        },
      });
      return { url: link.url };
    },

    getAccountStatus: async (accountId) => {
      /**
       * `include` is not optional in practice, and getting it wrong fails quietly.
       *
       * A v2 retrieve **omits `configuration` entirely** unless it is asked for. The account
       * still comes back, still has an id, and every capability reads `undefined` — which this
       * function is careful to treat as "not allowed", so the failure is a seller who can never
       * sell rather than one who can sell when they should not. That is the right way round and
       * still worth never triggering.
       */
      const account = await stripe.v2.core.accounts.retrieve(accountId, {
        include: ['configuration.recipient', 'requirements'],
      });

      /**
       * Read as optional throughout, on purpose.
       *
       * The SDK's types make promises about a JSON document that arrived over the network from
       * somebody else's service, across an API version boundary we pin and they move. The
       * failure mode of believing them is `undefined` reading as truthy somewhere downstream,
       * on the question of whether this account may take money.
       *
       * Anything absent or unrecognised is `unsupported`, which is the closed answer.
       */
      const balance = account.configuration?.recipient?.capabilities?.stripe_balance;
      return {
        transfers: asCapabilityStatus(balance?.stripe_transfers?.status),
        payouts: asCapabilityStatus(balance?.payouts?.status),
        /**
         * "Has the seller finished the form", derived rather than stated.
         *
         * v1 had `details_submitted`. v2 has requirements with deadlines, and the one that
         * corresponds is whether anything is **past due**: a freshly created account reports
         * `past_due` with nothing filled in, and a completed one does not. Anything we cannot
         * read is treated as not finished.
         */
        detailsSubmitted:
          account.requirements?.summary?.minimum_deadline?.status === undefined
            ? false
            : account.requirements.summary.minimum_deadline.status !== 'past_due',
      };
    },

    constructEvent: (rawBody, signature) => {
      if (options.webhookSecret === undefined) throw new StripeNotConfiguredError();
      // Against the **raw** body. A parsed-and-reserialised body has different bytes and a
      // signature that will not match — which is the good failure. The bad one is verifying
      // something other than what was signed.
      return stripe.webhooks.constructEvent(rawBody, signature, options.webhookSecret);
    },

    /**
     * A v2 event, verified and then read for nothing but its pointers (ADR-045).
     *
     * v2 account events are **thin**: Stripe will not send a snapshot payload for them, and an
     * event destination that asks for one is refused at creation. What arrives is an id, a type
     * and a `related_object` — no account body at all.
     *
     * That turns out to be the better contract. The handler re-reads the account instead of
     * believing a payload, so what gets written is the state **now** rather than the state when
     * the event was queued. Out-of-order delivery, which v1 could silently lose to, stops being
     * a correctness problem and becomes a wasted read.
     *
     * The signature is checked the same way and for the same reason as the v1 feed: against the
     * raw bytes, with `verifyHeader`, before anything is parsed. There is no `parseThinEvent` in
     * the pinned SDK, so the parse is ours — which is fine, because it happens after the bytes
     * have been proven.
     */
    verifyV2Event: (rawBody, signature) => {
      if (options.v2WebhookSecret === undefined) throw new StripeNotConfiguredError();
      // The SDK types this as nullable because a crypto provider can be absent in exotic
      // runtimes. On Node it is always there, and if it ever is not, refusing the event is the
      // only safe answer — an unverifiable event must never be treated as verified.
      const verifier = stripe.webhooks.signature;
      if (verifier === null) throw new StripeNotConfiguredError();
      verifier.verifyHeader(rawBody, signature, options.v2WebhookSecret);

      const parsed: unknown = JSON.parse(
        typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
      );
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('v2 event body was not an object');
      }
      const event = parsed as {
        id?: unknown;
        type?: unknown;
        related_object?: { id?: unknown; type?: unknown } | null;
      };
      if (typeof event.id !== 'string' || typeof event.type !== 'string') {
        throw new Error('v2 event body had no id or type');
      }
      return {
        id: event.id,
        type: event.type,
        relatedObjectId:
          typeof event.related_object?.id === 'string' ? event.related_object.id : null,
        relatedObjectType:
          typeof event.related_object?.type === 'string' ? event.related_object.type : null,
      };
    },

    createCheckoutSession: async (input) => {
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              quantity: input.quantity,
              price_data: {
                currency: input.currency,
                unit_amount: input.amountCents,
                product_data: { name: input.description },
              },
            },
          ],
          /**
           * A **destination charge**. The payment is made to the platform and immediately
           * transferred to the seller's connected account, less `application_fee_amount`.
           *
           * The alternative — a direct charge on the connected account — would put the
           * chargeback liability and the Radar configuration on the seller. Holding it here
           * is what lets §14.1's payout holds and dispute flow exist at all.
           */
          payment_intent_data: {
            application_fee_amount: input.applicationFeeCents,
            transfer_data: { destination: input.destinationAccountId },
            // Our id on the PaymentIntent too, not only the session. A dispute or refund
            // webhook arrives about the *intent*, and having to look up a session to find
            // out which order it is about is a lookup that can fail.
            metadata: { orderId: input.orderId },
          },
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata: { orderId: input.orderId },
          // Stripe abandons an unpaid session after this. It is also how long the listing
          // is realistically spoken for, so it wants to stay short.
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        },
        // Keyed on the order, which we created first precisely so that this key exists.
        // A double-clicked Buy button gets one session, not two, and therefore one charge.
        idempotency('checkout', input.orderId),
      );

      // Typed as nullable because Stripe returns null for sessions in modes that have no
      // hosted page. `mode: 'payment'` always has one — but the caller has to hand a URL to
      // a buyer, so a missing one is a failure here rather than a redirect to "null" there.
      if (session.url === null) throw new Error('stripe returned a session with no url');
      return { id: session.id, url: session.url };
    },

    refundPayment: async (input) => {
      const refund = await stripe.refunds.create(
        {
          payment_intent: input.paymentIntentId,
          ...(input.amountCents === undefined ? {} : { amount: input.amountCents }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          // On a destination charge these decide who actually bears it. Defaulting both to
          // true means a refund costs the seller their proceeds and us our fee, which is the
          // honest arrangement when a sale is being undone: nobody keeps a share of a
          // transaction that did not happen.
          reverse_transfer: input.reverseTransfer ?? true,
          refund_application_fee: input.refundApplicationFee ?? true,
          metadata: { orderId: input.orderId },
        },
        // Keyed on the order, so a double-clicked refund button refunds once. Without this a
        // retry after a timeout is a second refund, and the money is gone twice.
        idempotency('refund', input.orderId),
      );
      return { id: refund.id, status: refund.status };
    },

    /**
     * Still the **v1** account API, deliberately, and the only v1 call left on this path.
     *
     * Accounts v2 has no payout schedule. Not renamed, not moved — absent: there is no
     * `interval` anywhere in the v2 surface of the pinned SDK, and no money-management resource
     * to hold one. FR-5.6's hold is our single most important seller-side control, so
     * discovering this was the point at which the migration either worked or did not.
     *
     * It works, because `/v1/accounts/{id}` still answers for a v2 account id. That was
     * established by probing the sandbox rather than by reading documentation, and ADR-045
     * records the result, including the trap that came with it: the same v1 read reports
     * `charges_enabled: false` and `payouts_enabled: false` on a perfectly good v2 account.
     * **Those two fields are now lies for our accounts.** `getAccountStatus` reads the v2
     * capabilities instead, and nothing in this codebase may go back to the v1 booleans.
     */
    setPayoutSchedule: async (accountId, schedule) => {
      await stripe.accounts.update(accountId, {
        settings: { payouts: { schedule: { interval: schedule } } },
      });
    },
  };
}
