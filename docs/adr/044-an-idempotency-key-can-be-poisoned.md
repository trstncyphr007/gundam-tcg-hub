# ADR-044: An idempotency key can be poisoned

- **Status:** Accepted
- **Date:** 2026-09-27
- **Context:** SR-5.3 (idempotency on every mutating Stripe call), FR-5.1 (seller onboarding)

## Context

Every mutating Stripe call carries an idempotency key, and `accounts.create` keys on our own user
id: `account:<userId>`. The reason is specific. A seller who double-clicks "set up payments", or
whose first request times out and is retried, must not end up with two connected accounts — "who
gets paid" is not a question worth having two answers to.

That part works. What nobody wrote down is the other half of Stripe's behaviour:

> Stripe saves the status code and body of the first request made with a given idempotency key for
> **24 hours**, and replays it for any later request using that key — **including when the first
> request failed.**

So a key is not only a promise that work happens once. It is also a **cache of a refusal**. And the
refusal cached may have had nothing to do with the seller.

**This bit us during the AC-5.1 run.** A seller pressed the button before Connect was enabled on
the account. Stripe answered "you can only create new accounts if you've signed up for Connect",
which was true. Connect was then enabled — and that seller still could not onboard, because every
attempt replayed yesterday's answer. They saw a stale error describing a condition that no longer
existed, and nothing they or an operator could do from the application side changed it. The
workaround was a different user account, which is not a thing a real customer has.

The failure is quiet, durable and indistinguishable from a bug in our own code. It is worth an ADR
mostly so the next person recognises it in an hour rather than a day.

## Decision

**The key is a sequence, and a proven-harmless failure advances it.**

`createConnectedAccount` tries `account:<userId>` first, and on an error that proves Stripe created
nothing, tries `account:<userId>/2`, then `/3`, up to five keys. Any other error is thrown
immediately.

**1. The distinction that carries the whole control is what "proves nothing was created" means.**

| Error                                                    | Advance?  | Why                                                  |
| -------------------------------------------------------- | --------- | ---------------------------------------------------- |
| `StripeInvalidRequestError` (400)                        | **Yes**   | Stripe read it, refused it, stopped. Nothing exists. |
| `StripeAuthenticationError` (401)                        | **Yes**   | Never got past the door.                             |
| `StripePermissionError` (403)                            | **Yes**   | Same.                                                |
| `StripeIdempotencyError` (400)                           | **Yes**   | The key was misused; no account came of it.          |
| `StripeRateLimitError` (429)                             | No        | Nothing created, but waiting a second is free.       |
| `StripeAPIError` (5xx), `StripeConnectionError`, timeout | **Never** | The account may exist and we never heard the id.     |

Getting the last row wrong in the permissive direction would reintroduce exactly the duplicate this
key exists to prevent, and it would do so in the one case that is hardest to notice.

**2. The later keys are a fixed sequence, not random.**

Two callers who both find `account:<userId>` poisoned walk the same path and arrive at the same next
key, so Stripe deduplicates them as before. A random key per caller would also clear the lockout —
and would let two concurrent retries create two accounts, of which we record one. The other is an
orphan: a connected account in the Stripe dashboard that belongs to nobody in our database, which is
strictly worse than the problem being solved.

**3. The walk is bounded at five, and the error reported is the last one.**

A genuinely misconfigured platform should fail promptly rather than crawl. And because the last
attempt's error is what propagates, the seller now sees **the condition that is true now** instead
of one cached from before it was fixed — which is most of the value here, independent of whether a
later key succeeds.

## Consequences

- Clearing the lockout costs at most four extra API round trips, and only during onboarding, and
  only after something already went wrong. Nothing on the happy path changes: attempt 0 is the same
  request with the same key it always sent.
- **Do not "simplify" this to a random key or a timestamp bucket.** Both fix the visible symptom and
  reintroduce the orphaned account. `stripe.test.ts` asserts the exact key sequence and asserts that
  a connection error does **not** advance, so either change fails a test.
- The same trap applies to every other idempotent call we make — checkout sessions, refunds, payout
  schedule changes. It has not bitten us there because those keys are scoped to an order or a
  payment that is created fresh each time, so a poisoned key is naturally abandoned. Onboarding was
  the one place the key was scoped to something permanent.
- A residual risk remains and is recorded in `docs/security/phase-5-review.md`: two callers racing
  at the exact moment they exhaust different numbers of poisoned keys could still diverge. It needs
  concurrent requests, a poisoned key, and unlucky timing, and the outcome is an unonboarded
  account with no balance. Closing it properly means reconciling against `seller_accounts` under a
  lock, which costs a migration and a held transaction across a network call. Not worth it for this.

## Alternatives considered

**Look the account up in Stripe before creating one.** The obvious fix, and it does not work: the
Search API does not cover accounts, and `metadata.userId` is not an indexed field. Finding an
existing account means listing every connected account on the platform and filtering, which is
unbounded work on a path a seller is waiting on.

**Reconcile under a database lock.** Take an advisory lock on the user, re-read `seller_accounts`,
then create with a fresh key each time — correct, and it means holding a Postgres transaction open
across a 20-second call to a third party, with the web role's 5-second statement timeout in the way.
The cure is heavier than the disease.

**Create the `seller_accounts` row first, with a null account id, and store an attempt counter.**
Also correct. It costs a migration, new column grants, and a change to what "this row exists" means
— which `canSell`, the browse query and three RLS policies currently read as "this person has a
connected account". Rewriting that sentence to fix an onboarding retry is a poor trade.

**Do nothing and document it.** What the previous commit did, honestly, as a residual risk. Revisited
because "a seller can be locked out of onboarding for 24 hours by a transient error, and support has
no lever" is a customer-facing defect, and the fix turned out not to need the migration that made it
look expensive.
