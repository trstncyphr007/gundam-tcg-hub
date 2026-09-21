# ADR-024: The admin moderation console, and step-up by freshness

- **Status:** Accepted — with one gap stated below, not closed
- **Date:** 2026-09-22
- **Plan reference:** SR-1.10, SR-3.5, SR-4.4, SR-5.9, SR-X.13

## Context

Two review queues have existed in the database for weeks: user-reported prices, which count
for nothing until approved (SR-3.5), and first-party live sales held back because their price
sat far outside the published spread (SR-4.4). Neither had a screen.

Worse, neither could actually be decided. `moderateObservation` existed, but the web role
has `UPDATE` revoked on `price_observations` and the worker had no update policy. The only
thing that had ever approved a report was the table owner, inside a test. The control "a
report counts for nothing until a human approves it" was true partly because no human could.

## Decision

### 1. Decisions run on the worker role, with three columns and nothing else

Migration 0027 grants `app_worker` `UPDATE (approved_at, rejected_at, flagged_at)` and an
update policy. An admin request reads the queue on the web pool and hands the one write that
needs the privilege to the worker pool — the same shape as the break reveal (which reads an
encrypted seed) and API-key verification (which reads a hash).

So the web role still cannot mark a price as counting, and the worker can decide _whether_ a
row counts but not _what the row says_: a test proves `UPDATE ... SET price_cents` fails with
`permission denied` on the worker, and a direct approval fails the same way on the web pool.

### 2. Every decision has a reason, and the reason is in the audit log

SR-5.9. The reason box sits above the buttons, so the order on screen is the order of thought:
look at the evidence, say why, decide. It is normalised before it is stored, required to be
at least three characters, and written with the admin's id.

Two admins deciding the same row: the second gets `409 already_decided`, and the first stands.
Silently flipping a price that may already be published would be worse than either decision.

### 3. The two queues cannot be crossed

Approving a _report_ must never wave a held _live sale_ into the index without clearing its
flag. The report path now filters `source = 'user_report'` explicitly, and a test proves the
cross-over answers 409 and leaves the flag in place.

### 4. Reviewers judge the price, not the person

The report queue carries no reporter identity — no email, no name, no id. What matters about
the reporter is carried as a number (`reporterPending`: how many they have waiting), because
twenty reports from one account in an afternoon is a different situation from one each from
twenty people.

### 5. Step-up is freshness: signed in within twelve hours

Every admin route — including the existing `/v1/admin/ping` — refuses a session whose
_creation_ is older than twelve hours (SR-1.10's window), with `403 step_up_required`,
distinct from a plain `forbidden` so the client knows the fix is "sign in again".

`createdAt`, not the last refresh: Better Auth's `updateAge` moves the expiry along every day,
but creation stays at the moment the person actually signed in. An unknown sign-in time is
treated as stale, never as "just now".

### 6. Returning after re-authentication, without an open redirect

`/sign-in?next=` is validated on the server (`safeNextPath`): a rooted path on this origin or
the fixed default, with `//host`, `/\host`, backslashes and control characters refused by
name and a final check by URL parsing. A hostile value is replaced, never "cleaned up" — a
sanitiser that rescues input is a sanitiser with a bypass nobody has found yet.

## The gap: this is not MFA

SR-1.10 asks for a session re-authenticated **with a passkey or TOTP**. This project has
neither. Re-authenticating here proves control of the same email address or Discord account,
not possession of a second device. The ASVS checklist previously said MFA must land "before
any admin route ships"; this console crosses that line, and the checklist now says so
explicitly rather than being reworded.

What freshness does buy is real: a stolen, weeks-old session cookie cannot moderate anything.
It is also the half a passkey would sit on top of — a passkey proves _who_, freshness proves
_now_, and admin actions want both.

**Passkeys (preferred) or TOTP must land before the first production deploy and before
Phase 5.** Today nothing is deployed and no production admin exists, which bounds the
exposure by circumstance rather than by design.

## Two bugs this surfaced, both older than this work

- **Sign-in redirects were broken wherever the site and the API are different origins.**
  Better Auth resolves a relative `callbackURL` against its own base URL, so `/account/watches`
  — the default since Phase 1 — sent people to the API's 404 in local dev, and would have in
  the plan's `api.<domain>` layout. The form now sends an absolute URL on the site's origin,
  built only from a path `safeNextPath` has already approved.
- **The e2e helper had been cutting every emailed link off after its token.** Mailpit's JSON
  escapes `&` as `&`; a regex over the raw body stopped at the backslash and dropped
  `callbackURL`. Every earlier test navigated on its own afterwards, so nothing noticed until
  the step-up round trip needed the redirect itself.

## Consequences

- Moderation works for the first time, and only through a route that checks role, freshness
  and reason.
- An admin who leaves the page open past twelve hours is sent to sign in and brought back to
  the console, not shown an error they cannot act on.
- The MFA gap is now load-bearing and listed as a blocker for deploy.
