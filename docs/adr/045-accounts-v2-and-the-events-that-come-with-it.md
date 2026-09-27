# ADR-045: Accounts v2, and the events that come with it

- **Status:** Accepted
- **Date:** 2026-09-27
- **Context:** FR-5.1 (seller onboarding), FR-5.6 (payout holds), SR-5.2 (webhooks), ADR-011
- **Supersedes:** the Connect half of ADR-011. Checkout, Tax and SAQ-A are unchanged.

## Context

AC-5.1 passed on **Accounts v1**, which Stripe has switched off by default for new integrations;
it had to be re-enabled by hand in the sandbox to make the acceptance run work. That is a fine
answer for proving code that has been tested and a poor one to build on, and it was recorded as
debt the day it was earned.

The debt note guessed at the shape of the work. Most of the guess was right and one part of it
was wrong in a way that mattered, so the findings are recorded here rather than the guess.

**Everything below was established by probing the sandbox, not by reading documentation.** That
was deliberate: this is the module that moves money, and the previous two real defects in this
project were both things that documentation and server-side tests could not see.

## What the probe found

| Question                                                     | Answer                                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Can we create a v2 account with a `recipient` configuration? | Yes. `dashboard: 'express'`, capability `stripe_balance.stripe_transfers`.                                      |
| Does `retrieve` return the configuration?                    | **Only with `include`.** Without it `configuration` is absent entirely.                                         |
| Does hosted onboarding work?                                 | Yes, `v2.core.accountLinks` with `use_case.account_onboarding`.                                                 |
| Can a destination charge pay a v2 recipient?                 | Yes — refused only while the capability is not yet `active`, with an error naming the v2 capability explicitly. |
| **Is there a payout schedule in v2?**                        | **No. Nowhere in the v2 surface.**                                                                              |
| Does the v1 account API answer for a v2 account id?          | **Yes** — including `settings.payouts.schedule`, which is what saved FR-5.6.                                    |
| Can account events be delivered as snapshot payloads?        | **No.** Stripe refuses to create such a destination: they are thin-only.                                        |
| Can a configuration be set without declaring a country?      | **No.** `identity.country is required before setting configuration.recipient`.                                  |

### The unit tests passed before the last row was known

Worth recording plainly, because it is the third time this project has learned it. The unit
tests for all of this were green against a fake Stripe that accepted whatever it was handed.
Running the same client against the sandbox failed immediately on `identity.country`, then
failed again on `defaults.currency` for the same reason.

A fake tests the shape of what we would send. It cannot test whether the other end agrees, and
the other end is the part we do not control. The live check that found this is not committed —
it creates real accounts — but running one before believing an integration works is the habit
that keeps paying here.

## Decisions

### 1. `recipient`, not `merchant`

Stripe's own guidance decides it: `merchant` is for accounts that are the merchant of record —
direct charges, or destination charges _with_ `on_behalf_of`. `recipient` is for "destination
charges without `on_behalf_of` set", which is precisely our flow.

This corrects something that was quietly wrong under v1. We requested `card_payments` on every
connected account, and our flow never used it — the platform takes the payment. Worse, we then
read `charges_enabled` to decide whether a seller could sell, when the capability that actually
governs a destination charge is **transfers**. v1 made the wrong field convenient. v2 does not
offer it, which is the good kind of breaking change.

### 2. The payout hold stays on the v1 account API

FR-5.6 — new sellers on a manual payout schedule until they have earned release — is the most
important seller-side control we have, and **Accounts v2 has no payout schedule at all.** Not
renamed, not relocated: there is no `interval` anywhere in the v2 surface of the pinned SDK.

The migration lived or died here, and it lives because `/v1/accounts/{id}` still answers for a
v2 account id. `setPayoutSchedule` is unchanged.

Two consequences are written into the code because they are not obvious:

- **The hold is now a second call.** v1 set it at creation, with a comment explaining that a
  separate call can fail and leave a seller taking payments with payouts already running. That
  choice is gone. It is survivable because a new account's `stripe_transfers` is `restricted`
  until onboarding finishes, so no money can arrive in the gap, and because a failure throws and
  fails the whole onboarding rather than quietly producing a seller on daily payouts.
- **The same v1 read reports `charges_enabled: false` for a healthy v2 account.** Truthfully — a
  recipient account has no v1 charge capability. Those fields are now lies about our accounts,
  and nothing may go back to reading them.

### 3. Capability events move to a v2 event destination, on their own endpoint

v2 account events are **thin**: an id, a type and a `related_object` pointer, with no payload.
Stripe will not send a snapshot for them; a destination that asks for one is rejected at
creation. So the v1 webhook path could not be reused even if we wanted to.

`POST /v1/webhooks/stripe-v2` is a separate route with a separate secret, rather than a branch
inside the existing one. Almost nothing is shared — different signature call, different payload,
different meaning — and conflating them would mean a bug in type-sniffing could let an event
signed for one feed be trusted on the other. That is the single mistake the webhook code exists
to prevent.

What _is_ shared is the part that matters: raw-body verification first, claim inside the
transaction second, act third, acknowledge last, against the same `webhook_events` unique index.

**The handler re-reads the account rather than trusting the event**, which is forced by thin
events and is better anyway. What gets written is the state _now_, not the state when the event
was queued, so two events delivered out of order converge on the right answer instead of the
older one winning. v1 could silently lose that race.

### 4. The v1 `account.updated` handler is removed, not ported

This is the sharp edge. Our accounts are v2; the v1 API reports `charges_enabled: false` for
them, correctly. Had the old handler been left wired up, a stray v1 `account.updated` would
write that `false` over a working seller's row and **stop them selling**, silently, with a
value that looks entirely plausible in the logs. There is a test whose only job is to fail if
somebody puts it back.

### 5. The event destination gets a command, not a runbook line

`pnpm stripe:destination` creates it and prints the signing secret once.

This is the same trap as the storage bucket's CORS policy (ADR-043): a setting that lives
outside the codebase, that no server-side test can observe, and whose absence looks exactly like
everything working. Without the destination, a deployment is healthy, onboarding completes, and
sellers simply never become able to sell. It gets a command for the same reason the bucket did —
so the step is exercised rather than remembered.

### 6. `seller_accounts` keeps its two booleans

The four-state capability is reported live on `/v1/seller`, and what is **stored** stays two
booleans, where only `active` is true.

The stored value answers a domain question — may this person sell — and that question has two
answers. Mapping Stripe's vocabulary at the one boundary allowed to know about Stripe is the
design this codebase already has, and persisting the richer value would mean a migration, new
column grants and an RLS review for no behaviour change. `pending` is emphatically **not**
"nearly allowed": it means Stripe has not decided, and treating it as enabled would let somebody
list a card nobody can pay them for.

The naming debt is real and named: the column is called `charges_enabled` and now means "may
receive transfers". Renaming it is a migration for a comment, and is not worth doing alone.

## Consequences

- **A deployment needs `STRIPE_V2_WEBHOOK_SECRET` and a destination**, or sellers never become
  able to sell. This is the most likely way to get this wrong, which is why it is in
  `.env.example`, in the config comment, and in a command that reports when nothing is listening.
- Locally it is a second `stripe listen --all-thin --events-from @accounts`.
- One extra API read per capability event, on the worker. These fire a handful of times per
  seller in their life.
- **Sellers onboarded under v1 are not migrated.** There is one, from the AC-5.1 run, in a
  sandbox. There is no production data, so there is no migration path to write and no pretence
  that there is one; had there been real sellers this ADR would need a section it does not have.
- `getAccountStatus` must always pass `include`. Forgetting it returns an account whose every
  capability is `undefined` — which fails closed, so the symptom is a seller who can never sell
  rather than one who can sell when they should not. A test asserts the `include`.
- **Sellers are US.** `identity.country: 'us'` is now stated in code rather than defaulted by
  Stripe. Nothing changed for anyone, but the assumption is no longer invisible. Selling from
  elsewhere means Stripe Tax registrations, different payout rails and a different 1099 story
  (§23); when that happens the country belongs on the seller, chosen before the account is
  created, not in an env var that quietly redefines every future seller.

### Verified live, against the sandbox

Our own client, not a fake: v2 create, the v1 payout hold landing as `manual`, `getAccountStatus`
returning `{transfers: 'restricted', payouts: 'restricted', detailsSubmitted: false}` for a fresh
account, a working onboarding link, and `setPayoutSchedule` moving to `daily` and back.

What is **not** proven end to end is the v2 webhook: that needs a person to finish Stripe's
hosted KYC form before any capability becomes `active`, exactly as AC-5.1 did. The handler,
signature verification and replay behaviour are covered by tests that use Stripe's own signing
helper against the real verifier, so what remains unproven is the delivery itself.

## Alternatives considered

**Stay on v1.** It works today only because a compatibility setting was turned on by hand in the
dashboard. That is a dependency on a switch Stripe intends to stop offering, sitting underneath
the part of the product that handles money.

**Use a `merchant` configuration to keep the field names.** Would preserve `charges_enabled` and
avoid thinking about capability mapping — by making every seller the merchant of record, moving
chargeback liability onto them, and undoing the reason destination charges were chosen (§14.1's
payout holds and dispute flow depend on the platform holding it). A rename is not worth a change
to who is liable.

**One webhook endpoint, sniffing the payload shape.** Fewer routes, one secret, and a single
type-confusion bug away from accepting an event signed for the other feed.

**Keep the v1 `account.updated` handler "just in case".** The case it would cover does not exist;
the case it creates — a healthy seller silently disabled — does.

**Persist the four-state capability.** A migration, column grants and an RLS review to store
information nothing currently branches on. Worth doing when the UI actually distinguishes
`pending` from `restricted`, and the wire already carries what that would need.
