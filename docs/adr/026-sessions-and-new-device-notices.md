# ADR-026: Seeing and ending your sessions, and hearing about new devices

- **Status:** Accepted
- **Date:** 2026-09-22
- **Plan reference:** §16.2 (see and revoke sessions in `/account/security`), SR-X.5, SR-X.6,
  SR-X.24; the "not done" list in ADR-025

## Context

ADR-025 gave admins a second factor and left two things open. Nobody could see where their
account was signed in, and nobody was told when a sign-in came from somewhere new. Both are
the controls that still work _after_ something has gone wrong. A session nobody can see
can't be ended, and a sign-in nobody hears about can't be noticed.

Better Auth has endpoints for the first. Looking at them turned up a problem that already
existed on `main`.

## The problem: `/list-sessions` hands out every session's token

`GET /api/auth/list-sessions` has always been mounted, because it's part of Better Auth's
core. It returns every active session on the account **with its token and IP address**. The
only thing it checks is that the caller's session is fresh, which a stolen inbox gets you in
one click. A probe against the real stack confirmed it: status 200, fields
`token, ipAddress, userAgent, …`, and the token of every _other_ session in the body.

That was not a login on its own, and a test now pins why. The cookie is the token plus an HMAC
under the server secret, and no bearer plugin is enabled. So a bare token, sent as a cookie or
as `Authorization: Bearer`, gets 401. But that leaves one config change between "leaks
identifiers" and "leaks logins". The test fails the day that change is made.

`/revoke-session`, `/revoke-sessions` and `/revoke-other-sessions` had a smaller problem. Any
session could end any other, so an email session could sign out a passkey session.

## Decision

### 1. Better Auth's four session endpoints are switched off

A `before` hook answers `404` for all four, as if they didn't exist. A test proves each one
404s even for a fresh session, and that nothing is listed or ended. Replacing their response
bodies with `403` was the other option. It was rejected because it tells anyone probing that
the endpoint is there and worth working around.

### 2. Our own routes replace them, and return nothing replayable

| Route                                     | Does                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /v1/account/sessions`                | Your active sessions: id, device name, sign-in method, when, and which one is this |
| `POST /v1/account/sessions/:id/revoke`    | Ends one of your sessions                                                          |
| `POST /v1/account/sessions/revoke-others` | Ends every other session you're allowed to end, and says how many it had to keep   |

The queries behind them never select the `token` column, so no future route built on them
can leak it by accident. The response contains no token, no IP and no raw user agent; a
test checks the body for each.

A session id names a session but doesn't open one. Another account's id gets the same
`404 not_found` as a made-up one, so the answer never confirms that a session exists (SR-X.6).
Ids that don't look like ids are refused before any query runs.

### 3. Only a passkey session can end a passkey session

This follows ADR-025's rule. `mayRevoke(current, target)` allows everything except ending a
`passkey` session from a session that wasn't opened with one. Without it, someone holding the
inbox couldn't get _into_ the console, but they could keep signing the owner _out_ of it for
as long as they cared to click.

"Sign out everywhere else" from an email session ends every non-passkey session. It reports
how many passkey sessions it kept, and the page tells the person how to end those.

Sessions from before ADR-025 have no recorded method. They count as "not a passkey", so they
can always be ended. The query uses `is distinct from 'passkey'`, not `<> 'passkey'`, because
`null <> 'passkey'` is null and would quietly have kept them. A test covers that case.

Ending sessions needs no fresh sign-in. It only protects, and anyone who spots a sign-in they
don't recognise must be able to end it immediately from wherever they are.

### 4. A sign-in from a new device is emailed to the owner

When a session opens, the device is named coarsely ("Chrome on Windows") and recorded in
`sign_in_devices`. If the account already knew _other_ devices and this one is new, the
owner gets an email: the device, how the sign-in happened, and when (UTC). Like the passkey
notices, it contains no links.

- **Not for the first device.** A new account has nothing to compare against, and neither
  has the first sign-in after this ships. An email saying "you signed in" to someone who just
  did teaches them these emails mean nothing.
- **A separate table, not derived from `sessions`.** Signing out deletes the session row, so
  the next sign-in from the same laptop would look new every time. A notice that always fires
  is one people learn to ignore.
- **Coarse names, on purpose.** Browser and OS family, no versions. A browser update isn't a
  new device, and a finer name would become a fingerprint with no reason to keep it
  (SR-X.24). It is computed on the server from an attacker-controlled header, so it is only
  ever a label and a trigger for an email. Nothing is granted on it. A hostile user agent
  can't put its own text into the email; a test sends one with markup and a link in it.
- **Never allowed to fail the sign-in.** If the mail server is down, the person is still
  signed in; a test proves it.

### 5. The device history can be added to, never rewritten

Migration 0031 FORCEs row security on `sign_in_devices`. The web role can `INSERT` a row and
`UPDATE (last_seen_at)`, and nothing else. It can't delete, rename a device or backdate its
first sighting. Planting a device in a victim's history ahead of time, or deleting one
afterwards, is how someone would silence the notice, so both are refused. Tests cover
the grants, and the row policy that stops a device being recorded against another account.

## What this does not do

- ~~**Sessions still store the raw IP address.**~~ Closed by
  [ADR-028](028-ip-addresses-as-daily-hashes.md): only a same-day hash is stored. It turned
  out not to need replacing Better Auth's IP tracking — the session-create hook catches the
  one place it writes one.
- **Only email.** No Discord DM for notices. The account's email is the one channel every
  account is guaranteed to have.
- **The first sign-in on a device someone has stolen from the owner is not "new".** The
  notice catches a _different_ device. It can't catch someone using the owner's own laptop.
  Seeing the session list is the control for that.

## Consequences

- §16.2 is met: `/account/security` lists every session and can end any of them, subject
  to the passkey rule.
- SR-X.5 is met: passkey changes (ADR-025) and new-device sign-ins are both notified.
- An exposure present on `main` since Phase 1 is closed, and the test that pins "a bare
  token opens nothing" protects against it coming back as a login.
- Test-harness change: the e2e helper now picks the newest _sign-in_ email rather than the
  newest email, because a security notice can land after the link.
