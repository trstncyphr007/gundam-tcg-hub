# Phase 5 acceptance (AC-5.1 – AC-5.5)

**Date:** 2026-09-26 · **Commit:** `4ad2671` · **Plan:** §14.3

What the plan asks Phase 5 to prove, and whether it is proven. One of the five cannot be run by
anybody here; the rest are, with the evidence named so a reader can check rather than trust.

| #      | Criterion                                      | Status                        |
| ------ | ---------------------------------------------- | ----------------------------- |
| AC-5.1 | Stripe test-mode purchase, end to end          | **Blocked** — needs the owner |
| AC-5.2 | Webhook replay is a no-op; forgery is a 400    | **Passed**                    |
| AC-5.3 | Polyglot and EICAR refused; EXIF GPS gone      | **Passed**                    |
| AC-5.4 | A buyer cannot complete or reprice their order | **Passed**                    |
| AC-5.5 | No open High or Critical from the WSTG pass    | **Passed, with a caveat**     |

---

## AC-5.1 — a purchase, end to end · **Blocked**

> Onboard a seller, list an item, buy it through Checkout, receive the webhook, record the order
> as paid, ship with tracking, complete the order, and the payout is created.

**Stripe Connect is not enabled on the Stripe account**, in test mode or any other. Creating a
connected account fails, so no seller can onboard and no purchase can start. This is a dashboard
setting belonging to the account owner; nothing in this repository can change it.

**What is proven without it**, and how far that goes:

- Everything up to the payment: a seller lists a card, photographs it, the photograph is scanned
  and approved, the listing goes on sale, a stranger finds it on the card page, and the buy
  button reaches the point of asking Stripe for a Checkout session. Driven by a real browser in
  `apps/web/e2e/marketplace.spec.ts`, on every CI run.
- Everything after the payment, driven by the webhook rather than by a client: `paid`, `shipped`
  with required tracking, `delivered`, `completed`, the payout hold and its release, refunds and
  chargebacks. Covered by `apps/api/src/routes/checkout.test.ts`, `fulfilment.test.ts` and the
  `@gth/db` order suites, which move orders through the real state machine against a real
  database.

**What that does not prove.** The join between the two — that Stripe's session, Stripe's webhook
signature and Stripe's account state behave as the code assumes against the live test API. Every
webhook handled in a test was one this repository constructed and signed. That is the gap, and it
is the whole of AC-5.1.

**To close it:** enable Connect in the Stripe dashboard (test mode), then run the flow once.

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

Four of five pass. The fifth is one dashboard setting away, and everything on either side of that
setting is proven independently — which is the most that can be said until somebody enables it.
