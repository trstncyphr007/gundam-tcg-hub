# ADR-037: The attempts that failed are written down, without naming anyone

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** SR-X.21, SR-X.22, SR-X.4, SR-X.24

## Context

ADR-036 made a failed nightly job audible. The rest of SR-X.22 — "alert on spikes in failed
logins, rate-limit bans" — could not be built at all, for a simpler reason than it sounds:
**nothing recorded any of it.**

The audit log held successes only, by an explicit decision recorded in the auth hook: "only on
success: a refused or failed request changed nothing worth reporting". That is true of one
mistyped link. It is not true of two hundred, and the difference between those two is the
entire signal. The rate limiter was the same story — it answered 429 and forgot, so "this
caller has been refused two thousand times this hour" was not a fact anything could state.

## Decision

### Record the refusals, count them, name nobody

Three new audit actions: `auth.sign_in_failed`, `auth.rate_limited` (Better Auth's own limiter)
and `api.rate_limited` (the API's). Each row holds the endpoint, a short code and the source as
**that day's hash** — the same form sessions use (ADR-028), so "one source, three hundred
attempts" is sayable within a day and nothing follows anyone past midnight.

What a row deliberately does not hold:

- **The address someone tried to sign in as.** Not even hashed. "This address was tried" is
  precisely the account-enumeration answer these endpoints exist to withhold (SR-X.4), and an
  audit log is a worse place to keep it than the attempt was. A test walks every row and fails
  if an address appears in any of them.
- **The error message**, which can contain whatever the caller sent. The short code only.
- **An actor.** There is no account to attribute a refused attempt to, and inventing one would
  be guessing about the person it names.

`/admin/operations` gains a section: counts per action for the hour, day and week, the busiest
sources by short hash, and which endpoints are refusing. Every watched action appears even at
zero, because a quiet hour and a hook that stopped writing must not look the same.

### The rate-limit recorder is throttled, and the throttle is bounded

A row per refused request would let anyone who can be refused write to the audit log as fast
as they can send — an amplification, and a quick way to fill a table that is deliberately hard
to delete from. Instead one row per caller per ten minutes, carrying how many refusals it
stands for. The map behind it drops expired entries and has a hard ceiling; full means "stop
counting", never "stop limiting", because the limiter itself does not depend on any of this.

### Refusals are read structurally, not with `instanceof`

The first version checked `returned instanceof APIError` and recorded **precisely zero** failed
sign-ins while looking correct. Two reasons, both worth writing down:

1. The refusal object's class is not the `APIError` this package imports — same shape,
   different copy — so the check silently matched nothing.
2. A bad or expired magic link does not answer 4xx at all. It answers **302 back to the site
   with `?error=INVALID_TOKEN`**, so even a correct `instanceof` would have missed the
   commonest attempt there is.

So the check reads the shape: a 4xx/5xx with a code, or a redirect carrying an `error`
parameter. Both are unit-tested directly, including the redirect case, which is the one that
was wrong.

## Consequences

- ASVS 16.4 stays **Partial** and moves closer: the data now exists and is visible on the
  operations page. **Nothing alerts on it yet** — thresholds and a webhook post are the next
  piece, and they are now buildable because there is something to count.
- Audit volume grows with refusals rather than with sign-ins. Retention already prunes it at a
  year (ADR-035), and migration 0037 adds `(action, at desc)` so counting one kind over a
  window does not read the whole window — the query that would otherwise stop working on the
  night it matters, when a flood is both what is being counted and why the table is large.
- CrowdSec bans and refused deploy signatures are still outside this: they happen on the host,
  not in the application, and belong with the host's alert path.
