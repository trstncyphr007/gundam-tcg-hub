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

export interface StripeClient {
  /** Start a Connect Express account for a seller (FR-5.1). */
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
  getAccountStatus: (accountId: string) => Promise<{
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
  }>;
  /** Verify a webhook against the raw body and the signing secret (SR-5.2). */
  constructEvent: (rawBody: Buffer | string, signature: string) => Stripe.Event;
}

export interface StripeOptions {
  secretKey: string;
  webhookSecret?: string | undefined;
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
      const account = await stripe.accounts.create(
        {
          type: 'express',
          // Stripe collects and keeps the identity details. We hold an id and two booleans,
          // which is the entire reason Express was chosen over building KYC ourselves.
          capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
          ...(email === undefined ? {} : { email }),
          metadata: { userId },
        },
        // Keyed on our user, so a double-click during onboarding cannot leave one person with
        // two connected accounts and an ambiguous answer to "who gets paid".
        idempotency('account', userId),
      );
      return { accountId: account.id };
    },

    createOnboardingLink: async ({ accountId, returnUrl, refreshUrl }) => {
      // Both URLs are ours, built from configuration. Nothing a request supplies reaches here
      // — an open redirect through an onboarding link would be a phishing page with our name
      // on it.
      const link = await stripe.accountLinks.create({
        account: accountId,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
      return { url: link.url };
    },

    getAccountStatus: async (accountId) => {
      /**
       * Read as optional, on purpose.
       *
       * The SDK's types say these three are always present. That is a claim about a JSON
       * document that arrived over the network from somebody else's service, across an API
       * version boundary we pin and they move — and the failure mode of believing it is
       * `undefined` reading as truthy somewhere downstream, on the question of whether this
       * account may take money.
       *
       * Absent means not allowed. There is a test for it, which the types say is unreachable.
       */
      const account: Partial<Stripe.Account> = await stripe.accounts.retrieve(accountId);
      return {
        chargesEnabled: account.charges_enabled ?? false,
        payoutsEnabled: account.payouts_enabled ?? false,
        detailsSubmitted: account.details_submitted ?? false,
      };
    },

    constructEvent: (rawBody, signature) => {
      if (options.webhookSecret === undefined) throw new StripeNotConfiguredError();
      // Against the **raw** body. A parsed-and-reserialised body has different bytes and a
      // signature that will not match — which is the good failure. The bad one is verifying
      // something other than what was signed.
      return stripe.webhooks.constructEvent(rawBody, signature, options.webhookSecret);
    },
  };
}
