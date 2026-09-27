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
    accounts: {
      create: (...args: unknown[]) => {
        record('accounts.create', ...args);
        return Promise.resolve({ id: 'acct_fake123' });
      },
      retrieve: (...args: unknown[]) => {
        record('accounts.retrieve', ...args);
        return Promise.resolve({
          charges_enabled: true,
          payouts_enabled: false,
          details_submitted: true,
        });
      },
    },
    accountLinks: {
      create: (...args: unknown[]) => {
        record('accountLinks.create', ...args);
        return Promise.resolve({ url: 'https://connect.stripe.com/setup/fake' });
      },
    },
    webhooks: {
      constructEvent: (...args: unknown[]) => {
        record('webhooks.constructEvent', ...args);
        return { id: 'evt_fake', type: 'account.updated' };
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

    const [call] = calls.get('accounts.create') ?? [];
    expect(call?.args[1]).toEqual({ idempotencyKey: 'account:user-1' });
  });

  it('asks Stripe to collect the identity details, not us', async () => {
    const { stripe, calls } = fakeStripe();
    const client = createStripeClient(options(stripe));

    await client.createConnectedAccount({ userId: 'user-1' });

    const params = (calls.get('accounts.create') ?? [])[0]?.args[0] as Record<string, unknown>;
    expect(params['type']).toBe('express');
    expect(params['metadata']).toEqual({ userId: 'user-1' });
  });

  it('sends no email when there is none, rather than an empty one', async () => {
    const { stripe, calls } = fakeStripe();
    const client = createStripeClient(options(stripe));

    await client.createConnectedAccount({ userId: 'user-1' });

    const params = (calls.get('accounts.create') ?? [])[0]?.args[0] as Record<string, unknown>;
    expect('email' in params).toBe(false);
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
      accounts: {
        create: (_params: unknown, options: { idempotencyKey: string }) => {
          keys.push(options.idempotencyKey);
          return poisoned.includes(options.idempotencyKey)
            ? Promise.reject(error())
            : Promise.resolve({ id: 'acct_fake123' });
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

    await createStripeClient(options(stripe)).createConnectedAccount({ userId: 'user-1' });

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
      accounts: {
        create: (_params: unknown, o: { idempotencyKey: string }) => {
          keys.push(o.idempotencyKey);
          return Promise.reject(
            new Stripe.errors.StripeInvalidRequestError({ message: 'still not enabled' }),
          );
        },
      },
    } as unknown as Stripe;

    await expect(
      createStripeClient(options(stripe)).createConnectedAccount({ userId: 'user-1' }),
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
      createStripeClient(options(stripe)).createConnectedAccount({ userId: 'user-1' }),
    ).rejects.toThrow('socket hang up');

    expect(keys).toEqual(['account:user-1']);
  });

  it('does not advance on a rate limit, which waiting fixes for free', async () => {
    const { stripe, keys } = stripeRefusing(
      ['account:user-1'],
      () => new Stripe.errors.StripeRateLimitError({ message: 'slow down' }),
    );

    await expect(
      createStripeClient(options(stripe)).createConnectedAccount({ userId: 'user-1' }),
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
    const params = (calls.get('accountLinks.create') ?? [])[0]?.args[0] as Record<string, unknown>;
    expect(params['return_url']).toBe('https://example.test/account/selling?onboarded=1');
    expect(params['type']).toBe('account_onboarding');
  });
});

describe('what an account may do', () => {
  it('reports Stripe’s answer, including the parts that are still false', async () => {
    // Mirrored, never asserted. A seller cannot mark their own account ready, and a half-done
    // onboarding has to read as half-done rather than as ready.
    const { stripe } = fakeStripe();
    const client = createStripeClient(options(stripe));

    expect(await client.getAccountStatus('acct_1')).toEqual({
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
    });
  });

  it('treats a missing flag as not allowed', async () => {
    const { stripe } = fakeStripe({
      accounts: {
        create: () => Promise.resolve({ id: 'acct_x' }),
        retrieve: () => Promise.resolve({}),
      },
    });
    const client = createStripeClient(options(stripe));

    expect(await client.getAccountStatus('acct_1')).toEqual({
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    });
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
