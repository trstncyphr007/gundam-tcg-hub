# Phase 5 pre-launch security review (SR-5.10)

**Date:** 2026-09-25
**Scope:** the marketplace — listings, photos, checkout, fulfilment, refunds, reputation
**Assessed by:** the maintainer, as a structured self-review against OWASP WSTG
**Verdict:** **not ready to take real money**, for two reasons that are stated plainly below and
are not code defects.

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

### 1. No payment has ever been taken

Connect is not enabled on the Stripe account, so **AC-5.1 has never run end to end against
Stripe's live test API**. Everything on our side is proven — signature verification with Stripe's
own crypto, the order state machine, the webhook idempotency — but the integration is not.

A probe of the real API confirmed the client authenticates and the pinned API version is
accepted; it was refused for the account capability alone. Enabling Connect in test mode is a
few minutes in the dashboard and is the single thing standing between this and a demonstrated
purchase.

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

The remaining blocker is the first one: no payment has ever been taken.

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

The four things recorded as residual risk, in order of how much they matter:

| #   | Risk                                                                             | Status                                |
| --- | -------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | Sellers are paid before the buyer can complain (no payout hold)                  | **Open** — blocker 2                  |
| 2   | Every fraud threshold is a guess; no real order has been placed                  | Open, unavoidable until launch        |
| 3   | Geo mismatch is not flagged; the address arrives after the decision              | Open, by design, needs a review queue |
| 4   | One Stripe key for both roles, where SR-5.3 asks for restricted keys per service | Open                                  |

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

**It should not take real money yet** — but for one reason now rather than two. No payment has
ever completed against Stripe, and that is a dashboard setting away.

The payout hold that was blocker 2 when this document was first written was built immediately
afterwards, which is the most useful thing a review of one's own work can do: name the largest
risk plainly enough that the next commit closes it.
