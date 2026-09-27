import { describe, expect, it } from 'vitest';
import { loadConfig, stripeKeyFor, stripeKeysAreSplit } from './config.js';

/**
 * Which Stripe key each service gets (SR-5.3).
 *
 * One key doing every job means a compromise of either process can do the other's work. Split,
 * the blast radius becomes specific: the web key cannot refund, so a compromised web process
 * cannot move money out; the worker key cannot create a Checkout session, so a compromised worker
 * cannot take money in.
 *
 * What is tested here is only the **resolution** — which key a service is handed. Whether the key
 * Stripe issued actually has the permissions we asked for is a question about Stripe's dashboard,
 * not about this code, and it is answered by probing the live API. This project has learned five
 * times that a green test on a fake proves nothing about the far side of a boundary.
 */
const base = {
  DATABASE_URL_READONLY: 'postgres://app_readonly:x@127.0.0.1:5432/gth',
  DATABASE_URL_WEB: 'postgres://app_web:x@127.0.0.1:5432/gth',
  DATABASE_URL_WORKER: 'postgres://app_worker:x@127.0.0.1:5432/gth',
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};

/**
 * Deliberately short.
 *
 * gitleaks' Stripe rule matches ten or more characters after the prefix, so realistic-looking
 * fixtures are secret-scanner bait — the first version of this file was blocked by the pre-commit
 * hook, correctly. Our own schema only requires one character, so short fixtures satisfy it while
 * staying obviously not credentials. **Do not pad these out.** The alternative is allowlisting this
 * file in `.gitleaks.toml`, which would switch the rule off for anything else that lands here.
 */
const SHARED = 'sk_test_shared';
const WEB = 'rk_test_web';
const WORKER = 'rk_test_worker';

describe('which key each service is handed', () => {
  it('gives both services the per-service key when both are set', () => {
    const config = loadConfig({
      ...base,
      STRIPE_SECRET_KEY: SHARED,
      STRIPE_SECRET_KEY_WEB: WEB,
      STRIPE_SECRET_KEY_WORKER: WORKER,
    });

    expect(stripeKeyFor(config, 'web')).toBe(WEB);
    expect(stripeKeyFor(config, 'worker')).toBe(WORKER);
    // And they are not each other's, which is the entire point.
    expect(stripeKeyFor(config, 'web')).not.toBe(stripeKeyFor(config, 'worker'));
  });

  it('falls back to the shared key so splitting is a deployment step, not a breaking change', () => {
    // A host that has not split its keys must keep working exactly as before rather than refusing
    // to boot. The alternative is an upgrade that takes the marketplace down until somebody visits
    // a dashboard.
    const config = loadConfig({ ...base, STRIPE_SECRET_KEY: SHARED });

    expect(stripeKeyFor(config, 'web')).toBe(SHARED);
    expect(stripeKeyFor(config, 'worker')).toBe(SHARED);
  });

  it('falls back for only the service that is missing one', () => {
    const config = loadConfig({
      ...base,
      STRIPE_SECRET_KEY: SHARED,
      STRIPE_SECRET_KEY_WORKER: WORKER,
    });

    expect(stripeKeyFor(config, 'web')).toBe(SHARED);
    expect(stripeKeyFor(config, 'worker')).toBe(WORKER);
  });

  it('is undefined when Stripe is not configured at all', () => {
    // Which the caller reads as "the marketplace routes do not exist" — better than routes that
    // exist and answer 500 because a secret is missing.
    const config = loadConfig(base);

    expect(stripeKeyFor(config, 'web')).toBeUndefined();
    expect(stripeKeyFor(config, 'worker')).toBeUndefined();
  });

  it('accepts a restricted key, which is the whole point, and still accepts a standard one', () => {
    const restricted = loadConfig({
      ...base,
      STRIPE_SECRET_KEY: SHARED,
      STRIPE_SECRET_KEY_WEB: WEB,
    });
    expect(stripeKeyFor(restricted, 'web')).toBe(WEB);

    const standard = loadConfig({
      ...base,
      STRIPE_SECRET_KEY: SHARED,
      STRIPE_SECRET_KEY_WEB: 'sk_test_plain',
    });
    expect(stripeKeyFor(standard, 'web')).toBe('sk_test_plain');
  });

  it('refuses something that is not a Stripe secret key', () => {
    // A publishable key here would be a very quiet outage: every call refused, nothing obviously
    // misconfigured.
    expect(() =>
      loadConfig({ ...base, STRIPE_SECRET_KEY: SHARED, STRIPE_SECRET_KEY_WEB: 'pk_test_nope' }),
    ).toThrow();
  });
});

/**
 * The dangerous state is not "keys are shared". It is an operator who believes they are split and
 * is wrong — they hold the audit answer without the control, and nothing else would contradict
 * them. Hence a line in the boot log, and hence this.
 */
describe('reporting whether the keys are really split', () => {
  it('says split only when both are set and they differ', () => {
    expect(
      stripeKeysAreSplit(
        loadConfig({
          ...base,
          STRIPE_SECRET_KEY: SHARED,
          STRIPE_SECRET_KEY_WEB: WEB,
          STRIPE_SECRET_KEY_WORKER: WORKER,
        }),
      ),
    ).toBe(true);
  });

  it('does not call one key pasted into both variables a split', () => {
    // The likeliest way to get this wrong, and it would otherwise look exactly like success.
    expect(
      stripeKeysAreSplit(
        loadConfig({
          ...base,
          STRIPE_SECRET_KEY: SHARED,
          STRIPE_SECRET_KEY_WEB: WEB,
          STRIPE_SECRET_KEY_WORKER: WEB,
        }),
      ),
    ).toBe(false);
  });

  it('does not call half a split a split', () => {
    expect(
      stripeKeysAreSplit(
        loadConfig({ ...base, STRIPE_SECRET_KEY: SHARED, STRIPE_SECRET_KEY_WEB: WEB }),
      ),
    ).toBe(false);
  });

  it('is false when nothing is configured', () => {
    expect(stripeKeysAreSplit(loadConfig(base))).toBe(false);
  });
});
