import type Stripe from 'stripe';
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
