# ADR-025: Passkeys, and what an admin session has to prove

- **Status:** Accepted
- **Date:** 2026-09-22
- **Plan reference:** FR-1.10, SR-1.10, SR-X.3, SR-X.5, SR-X.21, SR-5.9; closes the MFA gap
  left open by ADR-024

## Context

ADR-024 shipped the moderation console behind a twelve-hour freshness check and said
plainly that it was not MFA: signing in again proved control of the same inbox, not
possession of a second device. It listed passkeys as a blocker for the first production
deploy.

Better Auth has a passkey plugin (`@better-auth/passkey`, on SimpleWebAuthn). Adding it is a
few lines. Making it an actual second factor is not, because of what the plugin leaves to the
application.

## Decision

### 1. Passkeys via the Better Auth plugin, pinned

`@better-auth/passkey` 1.7.4 and `@simplewebauthn/server` 13.3.3, exact pins, behind the
usual seven-day release age. The credentials table (`app.passkeys`, migration 0028) holds
only public keys, so a database leak gives nobody a way in.

Migration 0029 narrows who can touch it. The worker and read-only roles have no access at
all. The web role can `UPDATE` only `counter` and `name`, so even the tier that serves
sign-ins cannot swap the public key behind a credential. Both are proven by tests expecting
`permission denied`.

### 2. User verification is enforced by us, not assumed

The plugin verifies sign-ins with `requireUserVerification: false`, and its sign-in options
only _prefer_ verification. Left alone, a security key that is merely tapped, with no PIN,
counts as a passkey. That proves someone is holding the device, not that it is the owner:
**it is one factor, not two.**

So a `before` hook reads the flags byte out of `authenticatorData` and refuses anything
without UV (`USER_VERIFICATION_REQUIRED`) or UP (`USER_PRESENCE_REQUIRED`). It does this for
sign-in and for registration, before the plugin runs. Reading the flags early is safe
because they sit inside the data the authenticator signs. If anyone edits them, the plugin's
signature check fails afterwards. The hook can only ever say "no" sooner, never "yes".
Malformed or oversized input is refused as `MALFORMED_CREDENTIAL`, not parsed on hope.

Registration asks for `userVerification: 'required'` as well, so a browser won't offer an
unverifying device in the first place. That is a courtesy; the server check is the control.

The e2e suite proves the server check against a real browser. Chrome's virtual authenticator
is set to skip verification and holds the account's real credential. The test asks for
exactly that credential without verification. It gets back a genuine, signed assertion with
UP=1 and UV=0, and the server refuses it with no session created. Our own sign-in button
never produces this request: Chrome won't offer a discoverable credential without
verification (credProtect). A hand-made client can, and that is who the check is for.

### 3. A session remembers how it was opened

`sessions.auth_method` records `passkey`, `magic_link` or `discord`. It is set by the server
from the endpoint that created the session. Clients cannot write it (`input: false`), and a
database check rejects any other value. Sessions from before this change are `null`, and
`null` is treated as "not a passkey".

### 4. Admin routes need a passkey session, and a fresh one

`requireAdminStepUp` checks two things, in order:

1. `authMethod === 'passkey'`. If not: `403 passkey_required`. The console then offers
   "Sign in with your passkey" and a link to enrol one, not another email that would only
   prove the same inbox again.
2. The session was created within twelve hours (ADR-024). If not: `403 step_up_required`.

A passkey proves _who_, and freshness proves _now_. Neither replaces the other.

### 5. Who may change an account's passkeys

This is where the plugin's defaults would have undone everything above. It guards adding and
removing a passkey with an ordinary session, and an ordinary session is exactly what the
inbox gives you.

| Action                | Needs                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Add the first passkey | A session created within the last ten minutes (any method). There is no other way to begin |
| Add another           | A **passkey** session, created within ten minutes                                          |
| Remove any passkey    | A **passkey** session, created within ten minutes                                          |

The removal rule was added after the rest was built, when writing this ADR turned up the
chain it prevents. Someone with only the inbox could:

1. Sign in by email.
2. Delete the owner's only passkey. This used to need only a fresh session.
3. Enrol their own passkey, which is now a "first" passkey.
4. Pass the admin gate.

Without the removal rule, "a second passkey needs a passkey session" protected nothing. A
test now proves step 2 is refused and that the passkey is still there afterwards.

The cost is that someone who has lost their only passkey cannot remove it. That is harmless:
a passkey without its device opens nothing. A person with two passkeys uses the other one.
An admin who has lost every passkey is restored by an operator with database access, the
same route by which the admin role itself is granted (SR-X.9).

### 6. Every change to an account's way in is told to its owner

A passkey added or removed writes `auth.passkey_added` / `auth.passkey_removed` to the audit
log and emails the account (SR-X.5). The email contains no links, so it can't be copied into
a convincing phish. Refused attempts send nothing, so an attacker can't use them to flood an
inbox.

### 7. The relying party is configuration, validated at boot

`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` and `WEBAUTHN_RP_NAME`. The API refuses to start if the
RP ID is an IP address (WebAuthn forbids it) or if the origin is not the RP ID or a
subdomain of it. Production compose requires both, with no fallback. A `localhost` default
on a real domain would boot and then refuse every passkey.

Local development and the passkey e2e suites use `http://localhost:3000`, not the
`127.0.0.1` the rest of the suite uses, because an IP address can't hold a passkey.

## What this does not do

- **The first passkey is still enrolled by email.** Someone who controls the inbox _before_
  the owner enrols can enrol first. The runbook tells the first admin to enrol straight
  after the site goes up. The security email doesn't help here, because it goes to the same
  inbox.
- **No TOTP.** SR-X.3 accepts either. Passkeys are the stronger choice and cover every
  browser the site supports, and a second mechanism is a second thing to get wrong.
  Revisit if a real admin needs it.
- **Ordinary users are not required to have one.** The control is for privileged accounts.
  Sellers in Phase 5 will be held to the same rule when their money-moving routes exist
  (SR-5.4).
- ~~**Sign-in from a new device doesn't notify anyone yet**~~ (the rest of SR-X.5). Done in
  [ADR-026](026-sessions-and-new-device-notices.md).

## Consequences

- ASVS V6.5 is met for admin accounts, and gap 3 in the checklist is closed.
- An admin signed in by email sees "use your passkey", not a dead end.
- Test harness lessons, recorded because they cost a run each:
  - A re-imported credential has to carry its advanced signature counter. The server rightly
    refuses a replayed one as a possible clone.
  - A second passkey needs a second authenticator. WebAuthn refuses to enrol the same one
    twice, through `excludeCredentials`.
  - Cookies cached on one origin must not be reused by a spec on another.
