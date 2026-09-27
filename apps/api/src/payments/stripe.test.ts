import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { StripeNotConfiguredError, createStripeClient } from './stripe.js';

/**
 * The one module allowed to talk to Stripe.
 *
 * A fake client is injected, so none of this reaches the network — what is under test is the
 * *shape* of what we would send: that every mutating call carries an idempotency key, that no
 * URL comes from anywhere but our own configuration, and that a webhook is verified against
 * the bytes that were signed.
 */
interface Recorded {
  args: unknown[];
}

function fakeStripe(overrides: Record<string, unknown> = {}): {
  stripe: Stripe;
  calls: Map<string, Recorded[]>;
} {
  const calls = new Map<string, Recorded[]>();
  const record = (name: string, ...args: unknown[]): void => {
    const existing = calls.get(name) ?? [];
    existing.push({ args });
    calls.set(name, existing);
  };

  const stripe = {
    // v1, which two things still legitimately use: the payout schedule, which Accounts v2 has
    // no equivalent for at all, and refunds/checkout, which were never v2 in the first place.
    accounts: {
      update: (...args: unknown[]) => {
        record('accounts.update', ...args);
        return Promise.resolve({ id: 'acct_fake123' });
      },
    },
    v2: {
      core: {
        accounts: {
          create: (...args: unknown[]) => {
            record('v2.accounts.create', ...args);
            return Promise.resolve({ id: 'acct_fake123' });
          },
          retrieve: (...args: unknown[]) => {
            record('v2.accounts.retrieve', ...args);
            return Promise.resolve({
              id: 'acct_fake123',
              configuration: {
                recipient: {
                  capabilities: {
                    stripe_balance: {
                      stripe_transfers: { status: 'active' },
                      payouts: { status: 'pending' },
                    },
                  },
                },
              },
              requirements: { summary: { minimum_deadline: { status: 'currently_due' } } },
            });
          },
        },
        accountLinks: {
          create: (...args: unknown[]) => {
            record('v2.accountLinks.create', ...args);
            return Promise.resolve({ url: 'https://connect.stripe.com/setup/fake' });
          },
        },
      },
    },
    webhooks: {
      constructEvent: (...args: unknown[]) => {
        record('webhooks.constructEvent', ...args);
        return { id: 'evt_fake', type: 'checkout.session.completed' };
      },
      signature: {
        verifyHeader: (...args: unknown[]) => {
          record('webhooks.signature.verifyHeader', ...args);
          return true;
        },
      },
    },
    ...overrides,
  } as unknown as Stripe;

  return { stripe, calls };
}

const options = (stripe: Stripe, webhookSecret?: string) => ({
  secretKey: 'sk_test_fake',
  client: stripe,
  ...(webhookSecret === undefined ? {} : { webhookSecret }),
});

describe('starting a connected account', () => {
  it('carries an idempotency key keyed on the person', async () => {
    // Without it, "the connection dropped" and "it did not happen" look identical from here,
    // and the safe-looking response — try again — leaves one person with two connected
    // accounts and an ambiguous answer to "who gets paid".
    const { stripe, calls } = fakeStripe();
    const client = createStripeClient(options(stripe));

    await client.createConnectedAccount({ userId: 'user-1', email: 'seller@example.test' });

    const [call] = calls.get('v2.accounts.create') ?? [];
    expect(call?.args[1]).toEqual({ idempotencyKey: 'account:user-1' });
  });

  it('asks Stripe to collect the identity details, not us', async () => {
    const { stripe, calls } = fakeStripe();
    const client = createStripeClient(options(stripe));

    await client.createConnectedAccount({ userId: 'user-1', email: 'seller@example.test' });

    const params = (calls.get('v2.accounts.create') ?? [])[0]?.args[0] as Record<string, unknown>;
    expect(params['dashboard']).toBe('express');
    expect(params['metadata']).toEqual({ userId: 'user-1' });
  });

  it('requests a recipient configuration, not a merchant one', async () => {
    /**
     * The seller is not the merchant of record. We take a **destination charge without
     * `on_behalf_of`**, which Stripe's own guidance puts squarely in the `recipient` bucket:
     * the platform holds the chargeback liability and the seller receives a transfer.
     *
     * Asking for `merchant` would collect identity details for a role this seller cannot use,
     * and would quietly move the liability question. Under v1 we requested `card_payments`,
     * which this flow never needed — v2 does not offer the mistake.
     */
    const { stripe, calls } = fakeStripe();

    await createStripeClient(options(stripe)).createConnectedAccount({
      userId: 'user-1',
      email: 'seller@example.test',
    });

    const params = (calls.get('v2.accounts.create') ?? [])[0]?.args[0] as {
      configuration?: Record<string, unknown>;
    };
    expect(params.configuration).toEqual({
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
    });
    expect(params.configuration?.['merchant']).toBeUndefined();
  });

  it('declares a country, which v2 refuses to create a configuration without', async () => {
    /**
     * Found by running this against the real sandbox, after the unit tests above passed with a
     * fake that happily accepted the call: `identity.country is required before setting
     * configuration.recipient`.
     *
     * v1 defaulted the country to the platform's without being asked, so every seller this
     * project has made was already US — the constraint is newly visible, not newly true. The
     * assertion is here so that stays a decision rather than a detail.
     */
    const { stripe, calls } = fakeStripe();

    await createStripeClient(options(stripe)).createConnectedAccount({
      userId: 'user-1',
      email: 'seller@example.test',
    });

    const params = (calls.get('v2.accounts.create') ?? [])[0]?.args[0] as {
      identity?: { country?: string };
      defaults?: { currency?: string };
    };
    expect(params.identity?.country).toBe('us');
    // Allowed only because the country is set; Stripe refuses one without the other.
    expect(params.defaults?.currency).toBe('usd');
  });

  it('always sends a contact email, because v2 refuses a recipient without one', async () => {
    /**
     * This test replaces one that asserted the opposite — "sends no email when there is none"
     * — which was right for v1 and produced an account v2 will not create:
     *
     *     configuration.recipient: If configuration.recipient is supplied, the Account must
     *     have a contact email.
     *
     * The old shape had `email` optional, and the one caller did not pass it. So the code
     * compiled, its tests passed, and **every seller's onboarding would have failed**. It was
     * found by trying a real onboarding against the sandbox, not by anything in this file.
     * `email` is a required parameter now, so the compiler catches the next one.
     */
    const { stripe, calls } = fakeStripe();

    await createStripeClient(options(stripe)).createConnectedAccount({
      userId: 'user-1',
      email: 'seller@example.test',
    });

    const params = (calls.get('v2.accounts.create') ?? [])[0]?.args[0] as Record<string, unknown>;
    expect(params['contact_email']).toBe('seller@example.test');
  });
});

/**
 * Stripe keeps the response to an idempotency key for 24 hours **including failures**.
 *
 * So the key that makes a double-click safe also replays a failure that has nothing to do with
 * the seller — Connect not yet enabled, say — for the rest of the day. This happened during the
 * AC-5.1 run: the seller could not onboard even after the cause was fixed, and the only way out
 * was a different user, which is not a thing a real customer has.
 *
 * What is under test is the distinction the fix rests on: advance to a new key only when the
 * error proves Stripe created nothing, and never when an account might exist unseen.
 */
describe('a connected account whose idempotency key is holding a cached failure', () => {
  /** A fake that refuses the given keys and succeeds on anything else. */
  function stripeRefusing(
    poisoned: string[],
    error: () => Error,
  ): { stripe: Stripe; keys: string[] } {
    const keys: string[] = [];
    const stripe = {
      // The payout hold, which every successful creation now also performs.
      accounts: { update: () => Promise.resolve({ id: 'acct_fake123' }) },
      v2: {
        core: {
          accounts: {
            create: (_params: unknown, options: { idempotencyKey: string }) => {
              keys.push(options.idempotencyKey);
              return poisoned.includes(options.idempotencyKey)
                ? Promise.reject(error())
                : Promise.resolve({ id: 'acct_fake123' });
            },
          },
        },
      },
    } as unknown as Stripe;
    return { stripe, keys };
  }

  it('moves to the next key in the sequence and succeeds', async () => {
    const { stripe, keys } = stripeRefusing(
      ['account:user-1'],
      () => new Stripe.errors.StripeInvalidRequestError({ message: 'signed up for Connect' }),
    );

    const result = await createStripeClient(options(stripe)).createConnectedAccount({
      userId: 'user-1',
      email: 'seller@example.test',
    });

    expect(result).toEqual({ accountId: 'acct_fake123' });
    // A fixed sequence, not a random key: two callers who both find `account:user-1` poisoned
    // land on the same next one, so Stripe still deduplicates them. A random key each would
    // trade this lockout for an orphaned connected account nobody is recorded against.
    expect(keys).toEqual(['account:user-1', 'account:user-1/2']);
  });

  it('keeps walking while keys stay poisoned', async () => {
    const { stripe, keys } = stripeRefusing(
      ['account:user-1', 'account:user-1/2', 'account:user-1/3'],
      () => new Stripe.errors.StripeInvalidRequestError({ message: 'no' }),
    );

    await createStripeClient(options(stripe)).createConnectedAccount({
      userId: 'user-1',
      email: 'seller@example.test',
    });

    expect(keys).toEqual([
      'account:user-1',
      'account:user-1/2',
      'account:user-1/3',
      'account:user-1/4',
    ]);
  });

  it('gives up after a bounded number of keys, reporting the error that is true now', async () => {
    // A permanently misconfigured account must produce a prompt error, not a slow walk. And the
    // error the seller sees is the current one, which is the point: before this, they were shown
    // a refusal cached from before the cause was fixed.
    const keys: string[] = [];
    const stripe = {
      v2: {
        core: {
          accounts: {
            create: (_params: unknown, o: { idempotencyKey: string }) => {
              keys.push(o.idempotencyKey);
              return Promise.reject(
                new Stripe.errors.StripeInvalidRequestError({ message: 'still not enabled' }),
              );
            },
          },
        },
      },
    } as unknown as Stripe;

    await expect(
      createStripeClient(options(stripe)).createConnectedAccount({
        userId: 'user-1',
        email: 'seller@example.test',
      }),
    ).rejects.toThrow('still not enabled');

    expect(keys).toEqual([
      'account:user-1',
      'account:user-1/2',
      'account:user-1/3',
      'account:user-1/4',
      'account:user-1/5',
    ]);
  });

  it('does not advance when the failure leaves an account possibly created', async () => {
    // The case the stable key exists for. A dropped connection means "the account may be there
    // and we never heard the id" — taking a new key here is how one person ends up with two
    // connected accounts and an ambiguous answer to who gets paid.
    const { stripe, keys } = stripeRefusing(
      ['account:user-1'],
      () => new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }),
    );

    await expect(
      createStripeClient(options(stripe)).createConnectedAccount({
        userId: 'user-1',
        email: 'seller@example.test',
      }),
    ).rejects.toThrow('socket hang up');

    expect(keys).toEqual(['account:user-1']);
  });

  it('does not advance on a rate limit, which waiting fixes for free', async () => {
    const { stripe, keys } = stripeRefusing(
      ['account:user-1'],
      () => new Stripe.errors.StripeRateLimitError({ message: 'slow down' }),
    );

    await expect(
      createStripeClient(options(stripe)).createConnectedAccount({
        userId: 'user-1',
        email: 'seller@example.test',
      }),
    ).rejects.toThrow('slow down');

    expect(keys).toEqual(['account:user-1']);
  });
});

describe('the onboarding link', () => {
  it('sends only the urls it was given', async () => {
    // Both come from our own configuration. An onboarding link that redirects wherever a
    // request asked would be a phishing page with our name on it.
    const { stripe, calls } = fakeStripe();
    const client = createStripeClient(options(stripe));

    const result = await client.createOnboardingLink({
      accountId: 'acct_1',
      returnUrl: 'https://example.test/account/selling?onboarded=1',
      refreshUrl: 'https://example.test/account/selling',
    });

    expect(result.url).toBe('https://connect.stripe.com/setup/fake');
    const params = (calls.get('v2.accountLinks.create') ?? [])[0]?.args[0] as {
      use_case?: { type?: string; account_onboarding?: Record<string, unknown> };
    };
    expect(params.use_case?.type).toBe('account_onboarding');
    expect(params.use_case?.account_onboarding?.['return_url']).toBe(
      'https://example.test/account/selling?onboarded=1',
    );
    // The configuration the account actually has. Onboarding `merchant` here would ask the
    // seller for identity details supporting a role they were never given.
    expect(params.use_case?.account_onboarding?.['configurations']).toEqual(['recipient']);
  });
});

describe('what an account may do', () => {
  it('reports Stripe’s four states, not a boolean', async () => {
    // Mirrored, never asserted. A seller cannot mark their own account ready, and `pending` has
    // to stay distinguishable from `restricted`: one means wait, the other means go and do
    // something. Accounts v1 could not tell them apart and this is the reason for the migration.
    const { stripe } = fakeStripe();

    expect(await createStripeClient(options(stripe)).getAccountStatus('acct_1')).toEqual({
      transfers: 'active',
      payouts: 'pending',
      detailsSubmitted: true,
    });
  });

  it('asks for the configuration, because a v2 retrieve omits it otherwise', async () => {
    // The trap this guards: without `include`, the account comes back looking fine and every
    // capability reads `undefined`. It fails closed, so the symptom is a seller who can never
    // sell rather than one who can sell when they should not — still worth never causing.
    const { stripe, calls } = fakeStripe();

    await createStripeClient(options(stripe)).getAccountStatus('acct_1');

    const [call] = calls.get('v2.accounts.retrieve') ?? [];
    expect(call?.args[0]).toBe('acct_1');
    expect(call?.args[1]).toEqual({ include: ['configuration.recipient', 'requirements'] });
  });

  it('treats anything it cannot read as unsupported', async () => {
    const { stripe } = fakeStripe({
      v2: { core: { accounts: { retrieve: () => Promise.resolve({ id: 'acct_x' }) } } },
    });

    expect(await createStripeClient(options(stripe)).getAccountStatus('acct_1')).toEqual({
      transfers: 'unsupported',
      payouts: 'unsupported',
      detailsSubmitted: false,
    });
  });

  it('treats an unrecognised status as unsupported rather than passing it through', async () => {
    // A status Stripe adds later must not arrive in our domain unexamined. Closed by default.
    const { stripe } = fakeStripe({
      v2: {
        core: {
          accounts: {
            retrieve: () =>
              Promise.resolve({
                configuration: {
                  recipient: {
                    capabilities: { stripe_balance: { stripe_transfers: { status: 'enabled' } } },
                  },
                },
              }),
          },
        },
      },
    });

    const status = await createStripeClient(options(stripe)).getAccountStatus('acct_1');
    expect(status.transfers).toBe('unsupported');
  });

  it('calls an account with nothing past due submitted', async () => {
    const { stripe } = fakeStripe({
      v2: {
        core: {
          accounts: {
            retrieve: () =>
              Promise.resolve({
                requirements: { summary: { minimum_deadline: { status: 'past_due' } } },
              }),
          },
        },
      },
    });

    expect(
      (await createStripeClient(options(stripe)).getAccountStatus('acct_1')).detailsSubmitted,
    ).toBe(false);
  });
});

/**
 * Accounts v2 has no payout schedule. FR-5.6's hold is the most important seller-side control
 * there is, so the migration lived or died on finding somewhere to put it.
 */
describe('holding a new seller’s payouts (FR-5.6)', () => {
  it('sets a manual schedule through the v1 account API, which still answers for a v2 id', async () => {
    const { stripe, calls } = fakeStripe();

    await createStripeClient(options(stripe)).createConnectedAccount({
      userId: 'user-1',
      email: 'seller@example.test',
    });

    const [update] = calls.get('accounts.update') ?? [];
    expect(update?.args[0]).toBe('acct_fake123');
    expect(update?.args[1]).toEqual({
      settings: { payouts: { schedule: { interval: 'manual' } } },
    });
  });

  it('fails the whole onboarding if the hold cannot be set', async () => {
    // Loudly, on purpose. The alternative is a seller quietly created on daily payouts — the
    // empty-envelope trade, with nothing to show that it happened.
    const { stripe } = fakeStripe({
      accounts: { update: () => Promise.reject(new Error('stripe is down')) },
    });

    await expect(
      createStripeClient(options(stripe)).createConnectedAccount({
        userId: 'user-1',
        email: 'seller@example.test',
      }),
    ).rejects.toThrow('stripe is down');
  });
});

describe('a v2 event', () => {
  const body = JSON.stringify({
    id: 'evt_v2_1',
    type: 'v2.core.account[configuration.recipient].capability_status_updated',
    related_object: { id: 'acct_fake123', type: 'v2.core.account' },
  });

  it('is verified against the raw bytes with the v2 secret', async () => {
    const { stripe, calls } = fakeStripe();
    const client = createStripeClient({
      secretKey: 'sk_test_fake',
      client: stripe,
      webhookSecret: 'whsec_v1',
      v2WebhookSecret: 'whsec_v2',
    });
    const raw = Buffer.from(body);

    client.verifyV2Event(raw, 't=1,v1=abc');

    const [call] = calls.get('webhooks.signature.verifyHeader') ?? [];
    expect(call?.args[0], 'the raw buffer, not a reserialised copy').toBe(raw);
    // The v2 secret. Verifying a v2 event with the v1 secret would let an event signed for one
    // feed be trusted on the other, which is the reason these are two endpoints.
    expect(call?.args[2]).toBe('whsec_v2');
    await Promise.resolve();
  });

  it('is read for its pointers and nothing else', () => {
    const { stripe } = fakeStripe();
    const client = createStripeClient({
      secretKey: 'sk_test_fake',
      client: stripe,
      v2WebhookSecret: 'whsec_v2',
    });

    expect(client.verifyV2Event(Buffer.from(body), 'sig')).toEqual({
      id: 'evt_v2_1',
      type: 'v2.core.account[configuration.recipient].capability_status_updated',
      relatedObjectId: 'acct_fake123',
      relatedObjectType: 'v2.core.account',
    });
  });

  it('is refused when no v2 secret is configured', () => {
    const { stripe } = fakeStripe();
    const client = createStripeClient({ secretKey: 'sk_test_fake', client: stripe });

    expect(() => client.verifyV2Event(Buffer.from(body), 'sig')).toThrow(StripeNotConfiguredError);
  });

  it('is refused when the body is not an event', () => {
    const { stripe } = fakeStripe();
    const client = createStripeClient({
      secretKey: 'sk_test_fake',
      client: stripe,
      v2WebhookSecret: 'whsec_v2',
    });

    expect(() => client.verifyV2Event(Buffer.from('{"hello":1}'), 'sig')).toThrow();
  });
});

describe('verifying a webhook', () => {
  it('passes the raw body through untouched', async () => {
    // A parsed-and-reserialised body has different bytes and a signature that will not match.
    // That is the good failure; the bad one is verifying something other than what was signed.
    const { stripe, calls } = fakeStripe();
    const client = createStripeClient(options(stripe, 'whsec_fake'));
    const raw = Buffer.from('{"id":"evt_1","type":"account.updated"}');

    client.constructEvent(raw, 't=1,v1=abc');

    const [call] = calls.get('webhooks.constructEvent') ?? [];
    expect(call?.args[0]).toBe(raw);
    expect(call?.args[1]).toBe('t=1,v1=abc');
    expect(call?.args[2]).toBe('whsec_fake');
    await Promise.resolve();
  });

  it('refuses to verify anything when no secret is configured', () => {
    // Not "accept it because we cannot check": an unverifiable webhook is an unauthenticated
    // request that says money moved.
    const { stripe } = fakeStripe();
    const client = createStripeClient(options(stripe));

    expect(() => client.constructEvent('{}', 'sig')).toThrow(StripeNotConfiguredError);
  });
});
