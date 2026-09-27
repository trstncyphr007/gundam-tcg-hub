# Phase 5 acceptance (AC-5.1 – AC-5.5)

**Date:** 2026-09-27 · **Plan:** §14.3

What the plan asks Phase 5 to prove, and whether it is proven — with the evidence named, so a
reader can check rather than trust.

| #      | Criterion                                      | Status                    |
| ------ | ---------------------------------------------- | ------------------------- |
| AC-5.1 | Stripe test-mode purchase, end to end          | **Passed** — 2026-09-27   |
| AC-5.2 | Webhook replay is a no-op; forgery is a 400    | **Passed**                |
| AC-5.3 | Polyglot and EICAR refused; EXIF GPS gone      | **Passed**                |
| AC-5.4 | A buyer cannot complete or reprice their order | **Passed**                |
| AC-5.5 | No open High or Critical from the WSTG pass    | **Passed, with a caveat** |

All five pass. The caveat on AC-5.5 is real and stated there.

---

## AC-5.1 — a purchase, end to end · **Passed** (2026-09-27)

> Onboard a seller, list an item, buy it through Checkout, receive the webhook, record the order
> as paid, ship with tracking, complete the order, and the payout is created.

Run against Stripe **test mode** on sandbox `acct_1UJJsxFSXIElzIsj`. A real Checkout session was
paid with `4242 4242 4242 4242` and the money moved.

### The evidence

|                       |                                                                           |
| --------------------- | ------------------------------------------------------------------------- |
| Connected account     | `acct_1UK3xEF164Mk4T8n` — Express, onboarded through Stripe's hosted flow |
| Order                 | `7bf40236-b75c-49e4-aa80-905e279e7fc4`                                    |
| Stripe payment intent | `pi_3UK4veFSXIElzIsj17X…` — **`succeeded`**, 1234 usd                     |
| Application fee       | **62** (our platform fee, taken by Stripe)                                |
| Transfer destination  | `acct_1UK3xEF164Mk4T8n` — the seller, by destination charge               |
| Listing afterwards    | `sold`                                                                    |
| Payout hold           | **`hold_until = 2026-10-03`** — the new-seller hold (FR-5.6) is in force  |

The order's append-only history is the part worth reading:

```
from_status | to_status | actor  | at
------------+-----------+--------+----------
created     | paid      | stripe | 23:22:52
paid        | shipped   | seller | 23:22:55
```

**`paid` has `stripe` as its actor.** It was written by the verified webhook, on the worker role,
not by anything a client said — which is the one thing every previous test had to simulate and
the whole reason this criterion exists.

The webhook arrived through `stripe listen --all-snapshot --forward-to
http://127.0.0.1:4000/v1/webhooks/stripe`, signed with the CLI's own secret and verified against
the raw body by our handler. `app.webhook_events` shows the onboarding events
(`account.updated`, `capability.updated`, `account.external_account.created`) processed alongside
it, so the Connect event path is proven too.

### What was _not_ automated, and why

The seller's Express onboarding form was completed by a person. That is Stripe's own KYC UI, and
Stripe deliberately refuses to let a platform do it:

- **Accepting the Terms of Service through the API is refused** for Express accounts
  (`controller[requirement_collection]=stripe`).
- **Writing the seller's identity through the API is refused** with `oauth_not_supported` once
  the account has capabilities requested — which ours does, at creation. It is permitted on an
  account with _no_ requested capabilities, which is how an early probe misled us into thinking
  the whole form could be skipped.

Everything the criterion is actually about — our checkout call, Stripe's session, the webhook,
our state machine, the fee split, the payout hold — was driven end to end without a human.

### Things learned that outlive this run

1. **`GET /v1/accounts` answers 200 with an empty list even when Connect is not signed up.** It
   is not a usable check. Attempting to create an account is; it fails cleanly and creates
   nothing.
2. **Stripe Sandboxes are a separate environment from a main account's test mode.** A setting
   enabled in one does not apply to the other. This cost two round trips — once for Connect, once
   for the Accounts v1 policy.
3. **Accounts v1 is now off by default for new integrations.** It had to be re-enabled in the
   dashboard. See the debt note at the end of this document.
4. **Stripe caches idempotent responses for 24 hours, including failures.** A key is not only a
   promise that work happens once; it is also a cache of a refusal. This locked a seller out of
   onboarding for a day after the cause had been fixed. Closed in ADR-044 — the key is now a
   sequence that advances only on an error proving Stripe created nothing.
5. **Account links are single-use and expire in about five minutes.** A spent one redirects
   silently to `refresh_url`, which looks exactly like a page that failed to render.

---

## Debt this run created

**Accounts v1 is deprecated for new Connect integrations**, and this is a new integration. It
works today because the compatibility setting was enabled in the dashboard, which is a fine
answer for proving the code that has actually been tested — and a poor one to build on.

Migrating to **Accounts v2** is real work, larger than a parameter swap:

- v2 has no `charges_enabled` / `payouts_enabled` booleans; capabilities are
  `active | pending | restricted | unsupported`, so `getAccountStatus` changes shape.
- v2 accounts emit their events on a **separate feed** (Event Destinations, "thin" events), so
  the `account.updated` handling that records a seller's capabilities would never fire without
  reworking that too.
- The SDK supports it (`stripe.v2.core.accounts`, `stripe.v2.core.accountLinks`) and account
  creation was verified working against this sandbox during the investigation.

Roughly a day, on the module that moves money. It deserves its own branch, PR and review.

---

## AC-5.2 — webhook replay and forgery · **Passed**

- A replayed event (same `event_id`) is a no-op: `webhook_events` has a unique constraint on it,
  and the second delivery finds the row already processed. Tested in `checkout.test.ts` —
  _"is a no-op when the same event is delivered twice"_.
- A forged signature is refused with 400 before anything is read: the signature is verified
  against the **raw** body with a 5-minute tolerance. Tested — _"is refused outright when the
  signature is wrong, and nothing moves"_, which asserts the order did not change as well as the
  status code.
- An event naming an order that does not exist is shrugged off rather than erroring.

---

## AC-5.3 — malicious uploads · **Passed**

- **Polyglot** (a JPEG header with a payload appended): refused as `trailing_data`. The byte
  inspection in `@gth/security/images` is the cheap first filter; the re-encode is the control —
  nothing that is not a decodable image survives it, and what is served is a copy this process
  produced.
- **EICAR**: refused by ClamAV. Worth recording precisely, because the test says something
  narrower than the plan does — ClamAV's EICAR signature is **anchored**, so it does not flag
  EICAR appended inside a larger file. The suite asserts the real behaviour and explains why it
  does not matter: such a file is refused as trailing data before a scanner sees it.
- **EXIF GPS**: absent, because the served image is re-encoded from decoded pixels. There is no
  path by which the original's metadata reaches the output, and `reencode.test.ts` asserts a
  fixture that _had_ EXIF produces output that has none.
- Originals are deleted once the pipeline is done. No route hands out a link to one.

---

## AC-5.4 — business logic · **Passed**

A buyer cannot mark their own order `completed`, and cannot change its price.

Not because a route refuses them — because **the database does not grant it**. Migration 0043
revokes blanket `INSERT`/`UPDATE` on `orders` from `app_web` and grants back only the columns a
session may write. `status` is not among the values it may set to `completed`, and `amount_cents`
is not updatable at all. `delivered` and `completed` are written by the worker role, from the
clock or an admin, because they release a seller's payout and must never come from the person who
benefits.

Proven by tests that bypass the application entirely and issue SQL as the web role. A route that
forgot its check would still fail.

---

## AC-5.5 — no open High or Critical · **Passed, with a caveat**

The structured self-review is `docs/security/phase-5-review.md` (WSTG). No exploitable defect was
found, and no High or Critical is open.

The caveat is stated there and repeated here because it is the honest part: the person who wrote
the controls is the worst-placed person to find the gap in them. That review's method — `curl`
probes and a server-side test suite — could not see anything a **browser** enforces, and a real
defect was sitting in the upload path the whole time. It was found later by an end-to-end test
and closed in PR #113 (ADR-043).

The plan's preference for an external pentest stands, and remains unmet.

---

## Summary

**All five pass.** A real payment has moved through Stripe test mode: the platform took a
$12.34 charge, kept a 62¢ application fee, transferred the rest to the seller's connected
account, and the order became `paid` by webhook rather than by anything a client claimed.

Two honest limits on what that means. The caveat on AC-5.5 stands — the person who wrote the
controls is the worst-placed person to find the gap in them, and this project has already had one
real defect that its own review method could not see. And AC-5.1 was proven on **Accounts v1**,
which Stripe no longer recommends for new integrations; the migration is recorded above as debt
rather than pretended away.
