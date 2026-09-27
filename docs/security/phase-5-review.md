# Phase 5 pre-launch security review (SR-5.10)

**Date:** 2026-09-25 · **last revised** 2026-09-27
**Scope:** the marketplace — listings, photos, checkout, fulfilment, refunds, reputation
**Assessed by:** the maintainer, as a structured self-review against OWASP WSTG
**Verdict:** **no open High or Critical.** Both blockers this review opened are now closed, and so
is one of the five residual risks it found. What stands between this and real money is not on this
page: it is an external pentest, a lawyer, and the items in the handover document — none of them
code.

---

## What this document is

SR-5.10 asks for four things before launch: an updated threat model, a completed ASVS checklist
with the Level 3 items for money movement, a structured self-pentest, and a security contact.
This is the third, and it links the other three.

It is a self-review. It is not a pentest by somebody who did not write the code, and the plan is
right that one of those is worth buying before real money moves. What a self-review can honestly
do is run the checks, record what actually happened, and be specific about what it did not cover.

---

## The two blockers

### 1. ~~No payment has ever been taken~~ — closed 2026-09-27

**Resolved after this review was written.** Connect was enabled, a seller onboarded through
Stripe's hosted Express flow, and AC-5.1 ran end to end against Stripe's live test API: $12.34
charged, a 62¢ application fee kept, the remainder transferred to the connected account, and the
order reaching `paid` with **`stripe`** as the actor in its history — written by a
signature-verified webhook on the worker role, not by anything a client claimed.

The evidence is in `docs/security/phase-5-acceptance.md`. The run also produced residual risk 5
below, and confirmed that the join between our code and somebody else's API is where integrations
break: six things went wrong getting there, and none of them were in the payment itself.

Two limits on what that closes. It was proven on **Accounts v1**, which Stripe has turned off by
default for new integrations and which had to be re-enabled by hand; the migration to v2 is
recorded as debt in the acceptance document. And one demonstrated purchase is a demonstration, not
a soak test.

### 2. ~~Sellers are paid before buyers can complain~~ — closed 2026-09-25

**Resolved after this review was first written**, which is the review doing its job.

Connected accounts are now created with a **manual payout schedule**, so a sale's money reaches
the seller's Stripe balance and not their bank. A nightly job releases them once they have three
completed orders and seven days since the first of those completed — both required, because
orders alone allows three instant self-completing sales, and time alone allows an account to idle
for a week and then take one large payment with no history at all.

A seller cannot clear their own hold: `hold_until` is outside the web role's grant, and there is
a test that says so for their own row and for somebody else's.

**What this does not promise.** It does not stop a released seller absconding, and it does not
recover money already paid out. It makes the first few sales safe, which is where the
empty-envelope trade lives.

When this was written the remaining blocker was the first one. It is closed too, as of
2026-09-27.

---

## What was actually run

Against a locally built production bundle (`apps/api/dist/index.js`), not a dev server, on
2026-09-25. Raw results, not a summary of intent.

### WSTG-ATHN / ATHZ — unauthenticated access

Every Phase 5 route, with no session:

| Route                              | Result |
| ---------------------------------- | ------ |
| `POST /v1/listings`                | 401    |
| `POST /v1/listings/:id/buy`        | 401    |
| `POST /v1/orders/:id/ship`         | 401    |
| `POST /v1/orders/:id/dispute`      | 401    |
| `POST /v1/orders/:id/rating`       | 401    |
| `GET /v1/orders`                   | 401    |
| `GET /v1/seller`                   | 401    |
| `POST /v1/admin/orders/:id/refund` | 401    |

`deny-by-default.test.ts` makes this structural rather than a spot check: it walks the app's own
route table and requires every route to refuse an anonymous caller unless it is written down as
public.

### WSTG-ATHZ-02 — horizontal privilege

Covered by tests rather than by probing, because the interesting cases need two real accounts:

- A stranger reading another person's order → invisible (404), not forbidden.
- A **buyer** trying to ship → `403 wrong_party`, because they can see the order and a 404 would
  be a lie they could check.
- A seller disputing their own sale → 403.
- A seller approving their own photo, marking their own delivery, finishing their own sale,
  editing an order's price → refused **by Postgres**, tested as raw SQL with the user declared.

That last group is the important one. The tests deliberately bypass every helper that might be
enforcing the rule, so what refuses them is a grant or a policy.

### WSTG-INPV — the webhook

| Input                      | Result       |
| -------------------------- | ------------ |
| No signature               | 400          |
| Malformed signature        | 400          |
| Wrong secret               | 400 (tested) |
| Body altered after signing | 400 (tested) |
| Hour-old timestamp         | 400 (tested) |

No 5xx in any case. The forged-signature tests assert the order does **not** move.

### WSTG-CONF-06 — method handling

`DELETE /v1/cards` → **405**, `Allow: GET`. Read from the app's own route table rather than
Fastify's pattern matcher, which is why it is right for parameterised paths.

### WSTG-CONF-07 — security headers

Observed on a public route:

```
Content-Security-Policy: default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-site
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

`payment=()` rather than `payment=(self)` is correct here and stricter than the plan's Caddyfile
suggests: Checkout is a **redirect** to Stripe's own domain, so the Payment Request API is never
used on our origin. If an embedded Elements flow is ever added, this has to change with it.

### WSTG-CLNT-07 — CORS

- Public route: `Access-Control-Allow-Origin: *`, `GET` only, **no credentials**.
- Session route (`/v1/orders`) with a hostile `Origin`: **no CORS headers at all**, so a page on
  another site cannot read it even with `credentials: 'include'`.

**Amended 2026-09-26.** The above is still true and was not the whole question. It examined CORS
on _our_ origins and never asked whether the browser was allowed to speak to **the bucket** —
which is where the upload actually goes. It was not: no CORS policy existed on the bucket at all,
so the preflight for every presigned PUT answered 404 and no upload could ever have been made
from a browser. See "The finding this review missed" below, and ADR-043.

- Bucket preflight, from the site, asking for `content-type`: **200** with
  `Access-Control-Allow-Origin` naming the site.
- The same preflight from `https://evil.test`: **403**, no headers.
- The same preflight asking for `content-length, content-type` — which Chromium sends whether the
  page asks for it or not: **200** only because the policy allows any request header. An
  enumerated header list answered 403 and broke every upload.

### WSTG-BUSL-09 — resource bounds

- A 1.2 MB body on a JSON route → **413**.
- Photo uploads never pass through the API; a presigned PUT pins both content type and
  content-length, and a body disagreeing with either is refused **by the storage server** —
  tested against a real one.

### Information exposure

| Request                 | Response                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| `/v1/cards/not-a-uuid`  | `{"error":"invalid_request","details":[{"field":"id","code":"invalid_format"}]}` |
| `/v1/orders/not-a-uuid` | `{"error":"unauthenticated"}`                                                    |
| `/nope`                 | `{"error":"not_found"}`                                                          |

Field names and rule codes only — never the submitted value echoed back. No stack traces, no
SQL, no internal identifiers. **Zero 5xx were logged during the entire probe.**

### WSTG-BUSL — the business logic that matters here

Proven by test rather than probe, because the interesting states need a database:

- An order cannot be born `paid` (`status` is outside the web role's INSERT grant).
- Two buyers cannot hold one listing (partial unique index, enforced below RLS).
- A refund cannot be faked by an admin (the route asks Stripe; the webhook moves the order).
- A rating cannot exist without a completed order the rater bought (insert policy, four
  conditions).
- A new account cannot spend $400 on its first day (pure rules, refusal does not name the
  threshold).

---

## What this review did **not** cover

Stated because a review that lists only what it did is a review that reads as more complete than
it is.

- **No live Stripe integration test.** See blocker 1.
- **No authenticated DAST.** The nightly ZAP job runs a baseline and an API scan against the
  OpenAPI document, which describes the eight public read-only routes. The twenty-plus
  authenticated write routes are covered by `no-5xx.test.ts` instead — a gate inside the test
  suite, where sessions already work — but that is not the same as a fuzzer.
- **No load or concurrency testing** of the money paths. The one race that was reasoned about —
  two buyers, one listing — is closed by a unique index and tested serially, not under load.
- **No review of the Stripe account configuration**: Radar rules, payout schedule, webhook
  endpoint hardening and restricted API keys (SR-5.3 asks for per-service RAKs; one key is used
  for both roles today).
- **No legal review.** §23 requires one before launch and it has not happened.
- **Photo moderation.** Uploads are scanned for malware and re-encoded; nobody checks whether a
  photograph is of a card, or is somebody else's, beyond an exact-digest duplicate report.
- **~~Anything a browser enforces.~~** Every probe here was `curl` and every test in the suite
  runs on a server, so CSP, CORS and their relatives were outside what this method could reach.
  **Partly closed 2026-09-26:** an end-to-end suite now drives a real browser through selling,
  buying and a photo upload, and asserts the CSP names the photo bucket. It found two defects
  immediately. It is still not a substitute for the external test the plan asks for.

---

## The finding this review missed

_Added 2026-09-26, after an end-to-end test found it._

**The photo upload could not work in a browser, and this review said the upload path was sound.**

The bucket had no CORS policy. A presigned PUT is cross-origin and carries a `Content-Type`, so
the browser sends a preflight first; a bucket with no policy answers 404, the browser refuses to
send the PUT, and `fetch` rejects into a console. Nothing had ever set a policy — `ensureBucket`
was called only from tests.

Read back, this document's own words on the subject are exactly right and exactly beside the
point:

> Photo uploads never pass through the API; a presigned PUT pins both content type and
> content-length, and a body disagreeing with either is refused **by the storage server** —
> tested against a real one.

Every clause of that is true. The request it describes was never sent.

**Why the method could not see it.** Every probe in this review was made with `curl` and every
test in the suite runs on a server. A server does not send preflights, so a missing CORS policy
is invisible to all of them. The control was enforced by the browser, and nothing here was a
browser.

This is the second finding of that exact shape. The first was the site's own CSP: `connect-src`
had to name the bucket or the same request never left the page. Both live in the four lines that
upload a file, both were found by writing an end-to-end test that drives a real browser, and
neither was reachable by any other method available here.

**Severity.** Not an exposure — a feature that did not work. Recorded in a security review
because the _reason_ it was missed is a gap in the review's method, and that gap applies to every
browser-enforced control: CSP, CORS, SameSite, subresource integrity, permissions policy.

**Closed by** PR #113: the bucket carries a policy scoped to our origins (ADR-043), `pnpm
photos:bucket` applies it, CI runs the storage profile with `E2E_EXPECT_PHOTOS=1` so a regression
fails the build, and a browser now uploads a real JPEG end to end on every run.

---

## Findings

No exploitable defect was found in this pass. That sentence is worth less than it looks — the
person who wrote the controls is the worst-placed person to find the gap in them, which is the
argument for the external test the plan asks for. It also proved too generous: a non-exploitable
but real defect was sitting in the upload path the whole time, and the section above says why
this method could not have found it.

The five things recorded as residual risk, in order of how much they mattered when written. Two
are now closed; the statuses below are kept current rather than frozen at the date of the review.

| #   | Risk                                                                             | Status                                                                                                |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Sellers are paid before the buyer can complain (no payout hold)                  | **Closed 2026-09-25** — blocker 2, and verified surviving a real payment on Accounts v2 on 2026-09-27 |
| 2   | Every fraud threshold is a guess; no real order has been placed                  | Open, unavoidable until launch                                                                        |
| 3   | Geo mismatch is not flagged; the address arrives after the decision              | Open, by design, needs a review queue                                                                 |
| 4   | One Stripe key for both roles, where SR-5.3 asks for restricted keys per service | Open                                                                                                  |
| 5   | A failed `createConnectedAccount` locks that seller out of onboarding for 24h    | **Closed 2026-09-27** — see below                                                                     |

### 5. A failed account creation is cached for a day — closed

**Resolved after it was written down**, which is the second time this document has done that.

Found while running AC-5.1, and worth more than a line in a table.

`createConnectedAccount` keys its idempotency on the user: `account:<userId>`. That is the right
instinct — a double-click during onboarding must not leave one person holding two connected
accounts and an ambiguous answer to "who gets paid".

But **Stripe saves the response to an idempotency key for 24 hours whether it succeeded or
failed.** So an attempt that failed for a reason having nothing to do with the seller — Connect
misconfigured, a transient 500, a rate limit — is replayed to that seller for the next day. They
see the same error every time they press the button, and nothing they or an operator does from
the application side changes it.

This happened during the acceptance run: a seller whose first attempt hit "Connect is not
enabled" could not create an account afterwards, even once Connect was enabled. The fix at the
time was a different user, which is not a fix available to a real customer.

**The fix (ADR-044).** The key is now a sequence. `account:<userId>` is still tried first, so the
double-click protection is unchanged, but an error that _proves Stripe created nothing_ — a 400,
401, 403 or an idempotency error — advances to `account:<userId>/2`, and so on, to a bound of five.
An error that leaves open the possibility that an account exists (a 5xx, a dropped connection, a
timeout) never advances, because that is precisely the case a stable key exists to survive.

Two properties are worth naming, because both were nearly got wrong:

- The later keys are a **fixed sequence, not random**. Two callers who both find the earlier keys
  poisoned arrive at the same next one, so Stripe still deduplicates them. A random key each would
  clear the lockout and buy an orphaned connected account belonging to nobody in our database —
  worse than the problem.
- Because the walk is bounded and the **last** error is what propagates, a seller now sees the
  condition that is true _now_ rather than one cached from before it was fixed. That is most of the
  value, independent of whether a later key succeeds.

`stripe.test.ts` asserts the exact key sequence, the bound, and that a connection error does not
advance. The rejected alternatives — a time bucket, a lock, an extra column — are recorded in
ADR-044 so this does not get "simplified" back into a defect.

**What remains, smaller:** two callers racing at the moment they exhaust different numbers of
poisoned keys could still diverge and orphan an account. It needs concurrency, an already-poisoned
key and unlucky timing, and the result is an unonboarded account with no balance. Closing it means
reconciling under a lock held across a network call; not worth it for that.

---

## Security contact

`/.well-known/security.txt` is live and served with a contact address and an expiry. Private
vulnerability reporting is enabled on the repository. No bug bounty; for a marketplace this size
the `security.txt` contact is the proportionate version of SR-5.10's last clause.

---

## Conclusion

The controls are in better shape than the integration. Every rule that decides where money goes
is enforced by a database grant or a policy, and each one has a test that bypasses the
application code to prove it.

**Both blockers are closed.** The payout hold that was blocker 2 was built immediately after this
document first named it; the payment that was blocker 1 completed on 2026-09-27. That is the most
useful thing a review of one's own work can do — name the largest risk plainly enough that the next
commit closes it — and it has now happened three times, counting residual risk 5.

**What it still should not do is take real money**, for reasons that are not on this page and are
not code: no external pentest, no legal review, one Stripe key doing two services' jobs, and a
production environment that does not exist yet. Those are in `docs/marketplace-handover.md`.

And the honest limit, repeated because it has been proven twice rather than argued: the person who
wrote the controls is the worst-placed person to find the gap in them. This review's method could
not see anything a **browser** enforces, and two real defects were sitting in the upload path the
whole time — the CSP, and a storage bucket with no CORS policy at all, which meant browser uploads
had never worked anywhere. Both were found by an end-to-end test, not by this document.
