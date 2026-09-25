# ASVS 5.0 Level 2 Checklist

**Target:** OWASP ASVS 5.0 **Level 2** for all phases (plan SG1), with Level 3 controls for
money movement in Phase 5.

**First assessed 2026-09-20** against Phases 0–2 as built, and amended since only where a row's
evidence column says so — most recently 2026-09-25.

**What that means, and does not.** The rows below are about controls that cut across the whole
system, and they have been kept current. They are _not_ a sweep of Phases 3 and 4: the price
index, collections, the public API, live sales and verifiable breaks are built, and their
specific controls are covered by their own acceptance criteria (AC-3.x, AC-4.x) rather than
re-derived here. Reading this file as "Phases 0–4, assessed" would be reading more into it than
was done.

Status is one of:

- **Met** — implemented _and_ there is a test or proof that fails if it regresses
- **Partial** — implemented, but something material is missing; the gap is stated
- **Open** — not done; when it lands is stated
- **N/A** — the feature it protects does not exist yet

A control marked Met with no test behind it would be a claim, not a checklist, so the
evidence column is not optional.

---

## V1 Encoding and injection

| #    | Control                                   | Status              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2  | Input validated at every entry point      | **Met**             | zod `.strict()` on HTTP bodies, params, queries, ingest payloads, env. Unknown fields rejected — tested per route                                                                                                                                                                                                                                                                                                                                                                           |
| 1.3  | Output encoding for the rendering context | **Met**             | React escaping only; `dangerouslySetInnerHTML` banned by lint and Semgrep (guardrail proof 4)                                                                                                                                                                                                                                                                                                                                                                                               |
| 1.4  | Parameterised database access             | **Met**             | Drizzle only; `sql.raw` banned outside migrations, enforced by `.semgrep.yml` (proof 4). SQL-injection payload tests at query and HTTP layers                                                                                                                                                                                                                                                                                                                                               |
| 1.5  | OS command injection                      | **Met**             | No shell-out in app code; `child_process` banned by lint                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1.6  | No untrusted deserialization              | **Met**             | JSON only, schema-validated                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 1.9  | CSV / spreadsheet injection               | **Met**             | `csvCell` escapes formula prefixes on export; the reader never evaluates anything, so a payload survives import as plain text and comes back out neutralised. Tested end to end through a collection (AC-2.4, AC-3.5)                                                                                                                                                                                                                                                                       |
| 1.12 | SSRF defence                              | **Met** (this repo) | The server makes exactly one outbound request — the Discord webhook post — to an exact-host allowlist, https only, with redirects refused. Every user-supplied URL (evidence, VODs, stream refs, listings) is stored and linked, never fetched. Semgrep `gth-no-outbound-http` fails CI on any new outbound request in server code; proven with planted ones (ADR-030). **Owed by the scanner repo:** the resolved-address (DNS-rebinding) check, where retailer pages are actually fetched |

## V2 Validation and business logic

| #   | Control                              | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Business logic enforced server-side  | **Met** | Break state machine `draft → live → ended` is one-way and enforced in queries _and_ by a DB CHECK; a finished log cannot be reopened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2.2 | Anti-automation on sensitive actions | **Met** | Audited against the enforcing code 2026-09-25; the units below are now stated because this row used to say "per-IP and per-user" when per-user keying existed on two routes. **Per IP:** 5 auth links/min, 120 pulls/min, 120 ingest/min, 10 CSV imports/min, 120/min everything else. **Per user:** 30 watch mutations/min and 5 account exports or deletions/hour. **Per address:** 5 sign-in links/min, so rotating IPs cannot flood one inbox (#83). **Per key:** 60/min and 1,000/day, the day durable in Postgres. **Caps** — 50 watches and 25 collections per user, 200 breaks per creator, 2,000 pulls and 5,000 packs per break, 10 API keys and 20 pending price reports per user, 500 live sales/day per seller, 5,000 rows and 2 MiB per CSV, 20 auto-created listings per product and retailer. Those caps are read-then-write in query code with no unique or exclusion constraint behind them, so concurrent requests can exceed one; they bound abuse, they are not invariants. Server-rendered pages forward the visitor's IP, so the per-IP limit counts the visitor instead of pooling everyone into the web container's single address |
| 2.3 | Monetary values as integers          | **Met** | Cents everywhere, `integer` columns, no floats crossing a boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## V3 Web frontend security

| #   | Control                            | Status  | Evidence                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Security headers on every response | **Met** | HSTS, nosniff, referrer-policy, COOP, CORP, Permissions-Policy; asserted in the e2e suite and by ZAP nightly                                                                                                                                                                                    |
| 3.2 | Content-Security-Policy            | **Met** | Per-request nonce for scripts _and_ styles, `strict-dynamic`, no `unsafe-inline` for either, no wildcard sources, `object-src`/`base-uri` none. No style attribute is served (lint + e2e on the HTML); an injected one on the production build was refused and reported. Gap 1 closed (ADR-031) |
| 3.3 | Clickjacking defence               | **Met** | `frame-ancestors 'none'`, asserted in tests                                                                                                                                                                                                                                                     |
| 3.4 | Cookie attributes                  | **Met** | `HttpOnly`, `SameSite=Lax`, `Secure` + `__Host-` prefix in production                                                                                                                                                                                                                           |
| 3.5 | CSRF defence                       | **Met** | SameSite cookies plus an Origin check — demonstrated when a request without an Origin was rejected 403                                                                                                                                                                                          |
| 3.7 | No sensitive data in the URL       | **Met** | Fixed 2026-09-20: the sign-in form now POSTs, so a degraded no-JS submit cannot put an email in the URL. Found by ZAP                                                                                                                                                                           |

## V6 Authentication

| #   | Control                        | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6.1 | No passwords stored            | **Met** | Discord OAuth and magic links only; no password column exists                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6.2 | Single-use, expiring links     | **Met** | 15-minute expiry, single use; replay mints no session (tested)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 6.3 | Account enumeration resistance | **Met** | Requesting a sign-in link answers identically — status, body and every readable header — for a registered and an unregistered address, and sends a link either way, so neither the response nor the inbox is an oracle. This was the only **Met** in this file with nothing behind it: the sole implementation was a branch in the sign-in form, which is a client deciding what to show. Tested since 2026-09-25, and the test is proved to fail when a single refusal for an unknown address is introduced |
| 6.4 | Credentials hashed at rest     | **Met** | API keys and overlay tokens stored as HMAC with a server pepper; constant-time compare. The web role has no SELECT privilege on `key_hash` at all, so the tier serving sessions cannot read the material a forgery would need — proven by a test expecting `permission denied`                                                                                                                                                                                                                               |
| 6.5 | MFA for privileged accounts    | **Met** | Every admin route requires a session opened **with a user-verified passkey** (a device plus its PIN or biometric) and created within 12 hours (ADR-025). UV is enforced by the server, not assumed: a real signed UV=0 assertion is refused in e2e. Adding a second passkey or removing any needs a passkey session, so an inbox alone cannot swap one in. Gap 3 closed                                                                                                                                      |
| 6.6 | Owner told of security events  | **Met** | Email on passkey added or removed (ADR-025), and on the first sign-in from a device the account has not used (ADR-026). No links in any of them. The device history is insert-only for the web role, so it cannot be pre-seeded or erased to silence a notice; tested                                                                                                                                                                                                                                        |

## V7 Session management

| #   | Control                          | Status  | Evidence                                                                                                                                                                                                                                                                 |
| --- | -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.1 | Server-side session invalidation | **Met** | Sign-out revokes server-side (tested)                                                                                                                                                                                                                                    |
| 7.2 | Session lifetime bounded         | **Met** | 7-day rolling, 30-day absolute                                                                                                                                                                                                                                           |
| 7.4 | Token revocation is immediate    | **Met** | Rotating an overlay token overwrites its hash, so the old one matches nothing; live viewers are dropped (AC-2.2). A revoked API key is refused on the next request — there is no cache to expire (AC-3.3)                                                                |
| 7.5 | See and end your own sessions    | **Met** | `/account/security` lists every session by device and method and ends any of them; ended means signed out on the next request (e2e). Only a passkey session can end a passkey session (ADR-026)                                                                          |
| 7.6 | Session tokens never disclosed   | **Met** | Better Auth's `/list-sessions` returned every session's token to any fresh session; it and the three `/revoke-*` endpoints now answer 404. Our replacement never selects the token column. A bare token opens nothing as a cookie or bearer — pinned by a test (ADR-026) |

## V8 Authorization

| #   | Control                            | Status  | Evidence                                                                                                                                                                                                                             |
| --- | ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8.1 | Deny by default                    | **Met** | `authorize()` requires an explicit action; every route declares one                                                                                                                                                                  |
| 8.2 | Ownership checked on every object  | **Met** | Two-user IDOR tests for watches, breaks and collections, at the query layer and over HTTP; "not found" and "not yours" return the same answer (AC-3.2)                                                                               |
| 8.3 | Defence in depth at the data layer | **Met** | RLS `FORCE` on watches, breaks, pulls and collections. Proven by a test that counts a draft row on an unscoped connection and gets zero, and by one showing a _public_ collection is readable by everyone and writable by one person |
| 8.4 | Roles are server-controlled        | **Met** | `role` is `input: false`; grants are CLI-only and audited with before/after                                                                                                                                                          |

## V11 Cryptography

| #    | Control                  | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.1 | Approved primitives only | **Met** | Node `crypto` only: HMAC-SHA256, `randomBytes`. No custom crypto                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 11.2 | Adequate entropy         | **Met** | 32 bytes CSPRNG for overlay tokens and API secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 11.3 | Constant-time comparison | **Met** | `timingSafeEqual`; length checked first                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 11.4 | Key rotation possible    | **Met** | Token rotation is built and proven. `DATA_ENCRYPTION_KEYS` carries a key id in every ciphertext (`v1:<kid>:…`), and `pnpm keys:rotate` re-encrypts every value under the active key and says which old keys are now safe to remove — so a rotation _retires_ a key rather than adding one. It works as each account, inside the same row policies as a request; it never overwrites a value that changed under it, and leaves anything it cannot decrypt untouched. Tested, and run against the dev stack (ADR-029) |

## V14 Data protection

| #    | Control              | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.1 | Data minimisation    | **Met** | Public and overlay queries select no creator id, name or email — enforced by the query, not the template. A shared collection returns the cards but nulls the owner's cost, purchase date and notes in SQL, so no route can leak them and no gain/loss is computed for a visitor                                                                                                                                                                                                                                                                                                          |
| 14.2 | No secrets in logs   | **Met** | pino redaction; the overlay token is masked out of the request URL before logging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 14.3 | Caching controlled   | **Met** | `no-store` on per-user, overlay and health responses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 14.5 | Export and deletion  | **Met** | `/account/data`: a JSON download of everything the account holds, minus working credentials and other people's names; and permanent deletion, straight away. Both need a sign-in from the last ten minutes, and deletion needs a passkey session when the account has one; both email the owner. Deletion goes through `app.delete_account` — cascades what was only theirs, deletes unpublished reports, anonymises approved ones — and restores re-apply it from the audit log (ADR-027)                                                                                                |
| 14.6 | IP addresses at rest | **Met** | Sessions keep only `iph1:<day>:<hmac>` — keyed by the server secret, re-keyed daily, so same-day comparison works and nothing can be followed across days or reversed from a database copy. A CHECK refuses a raw address from any writer; existing raw ones were cleared. Request logs never had them; Caddy writes no access log. Only the in-memory rate limiters see addresses, as SR-X.24 allows (ADR-028)                                                                                                                                                                           |
| 14.7 | Retention enforced   | **Met** | Nothing is kept "until someone remembers": buyer handles go at 90 days, expired sessions and verification tokens the night after they lapse, unused devices at a year, audit entries at a year. `app.run_retention()` holds the periods, takes no arguments and is executable only by the worker, so a caller picks when it runs and never how far back it reaches; the audit prune records itself in the log it pruned, and the device floor is a table policy that holds for every caller (ADR-035). The published privacy policy states the same periods, and the e2e suite asserts it |
| 14.8 | Policy published     | **Met** | `/privacy` and `/terms`, written from the controls rather than a template, with the numbers interpolated from the same constants the server enforces (ADR-034). `/.well-known/security.txt` is built and gated on a contact address existing — a published address nobody reads is worse than none. **Not yet lawyer-reviewed**, which §23 requires before Phase 5                                                                                                                                                                                                                        |

## V16 Logging and monitoring

| #    | Control                     | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 16.1 | Security events logged      | **Met** | `audit_log` covers auth events, role changes, watch and break lifecycle, token rotation, restock detection — and, since ADR-037, the attempts that **failed**: refused sign-ins and rate-limit refusals, each carrying the endpoint, a short code and the source as that day's hash. Never an address that was tried, which is the enumeration answer the auth endpoints exist to withhold; a test walks every row to prove it                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 16.2 | Append-only audit trail     | **Met** | UPDATE/DELETE/TRUNCATE revoked from app roles; a test proves tampering fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 16.3 | No PII in logs              | **Met** | User ids not emails; IPs hashed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 16.5 | Log retention               | **Met** | Audit entries a year, pruned nightly by a function that cannot be told to reach further back, and which records its own pruning in the log it pruned. App logs rotate at Docker's `local` driver (10 MB × 5) and hold nothing personal beyond hashed values (ADR-035)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 16.4 | Alerting on security events | **Met** | Two halves. A failed job or backup reports through one `gth-alert@` unit, and `preflight.sh` fails when the timers are off or no webhook is set (ADR-036); a watchdog runs every quarter-hour and posts refused-sign-in spikes, one grinding source, rate-limit storms, a stalled scanner and a stuck delivery queue (ADR-038). Thresholds are a pure function with tests on the boundaries, each finding is said once per its own interval by a single-statement claim, and an **"all clear" goes out daily**, so a quiet channel means nothing is wrong rather than that the watchdog died. **Two caveats:** nothing has posted to a real channel yet (no webhook — the post path is tested against a fake `fetch`), and CrowdSec bans and a refused deploy signature reach the same channel from the host without being correlated with any of this |

## V17 Dependency and supply chain

| #    | Control                               | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17.1 | Dependencies pinned and locked        | **Met** | Exact pins, committed lockfile, `--frozen-lockfile`, `minimumReleaseAge` 7d, install scripts blocked                                                                                                                                                                                                                                                                                                                                                                                          |
| 17.2 | Known-vulnerable dependencies blocked | **Met** | OSV-Scanner + `pnpm audit`, blocking. Guardrail proof 3                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 17.3 | Build provenance                      | **Met** | cosign keyless signatures + CycloneDX SBOM attestations, and SLSA v1 build provenance for **both** images (only the API had it until ADR-032). Provenance is verified by the release itself and again by the deploy gate — built by `release.yml` on `main` of this repository — alongside the signatures, which the server re-checks. **Decided 2026-09-23:** the image packages go public, so the server needs no registry credential; `preflight.sh` checks they are (runbook `deploy.md`) |
| 17.4 | Pinned CI actions and images          | **Met** | Every action by SHA, every tool image by digest; zizmor enforces                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## Known gaps

Listed because a checklist that only records successes is marketing.

### 1. ~~`style-src 'unsafe-inline'` (V3.2)~~ — **CLOSED 2026-09-22**

Done the way the path out below said: all 428 inline style props moved to classes over the
existing variables (411 by a parser-based codemod, 17 by hand), and production's
`style-src` is now `'self' 'nonce-…'`. Lint refuses a new style prop; e2e refuses a style
attribute in served HTML and any CSP violation on page load; on the production build, an
injected `style` attribute was refused and reported (ADR-031). The Safari worry that kept it
open turned out not to apply — no `<style>` tag or `style-src-attr` was needed, only no
attributes at all.

_Original entry, for the record:_ React's `style` prop needed it; removing it risked an
unstyled page. _Impact:_ CSS injection could exfiltrate via selectors or attempt UI redress.
_Path out:_ move inline styles to CSS classes and variables, then drop it.

### 2. ~~No server-side branch protection~~ — **CLOSED 2026-09-20**

The repo was made public, which restored rulesets. `main` now requires a pull request, all
seven status checks (strict), signed commits and linear history, and refuses force-pushes
and deletion. Secret scanning and push protection are on too.

Verified rather than assumed: an empty commit pushed straight at `main` was refused —
_"7 of 7 required status checks are expected"_.

What is left is not a platform gap. The ruleset requires a PR but **zero approvals**, because
there is one maintainer (ADR-012), so it enforces process, not review. Tighten it the moment
a second contributor appears.

### 3. ~~No MFA (V6.5)~~ — **CLOSED 2026-09-22**

Passkeys landed (ADR-025). Admin routes now need a passkey session **and** the twelve-hour
freshness below. The server enforces user verification itself, because the plugin would
have accepted a key that was only tapped. Changing an account's passkeys needs a passkey
session, apart from enrolling the very first one.

What remains, stated rather than hidden: the first passkey is enrolled after an email
sign-in. Whoever controls the inbox _before_ the owner enrols can enrol first. The VPS
runbook has the first admin enrol immediately after the site comes up. TOTP was not built;
see ADR-025 for why.

The original entry is kept below as the record of what shipped in the meantime.

#### As it stood on 2026-09-22, before passkeys

This entry originally said MFA "must land before any admin route ships". The moderation
console (ADR-024) is an admin route, and it ships **without** a second factor. That is stated
here rather than the gate being quietly reworded.

What it has instead is **step-up by freshness**: every admin route refuses a session that
was not signed into within the last twelve hours (SR-1.10's window), and says so with a
distinct `step_up_required` error. A stolen, weeks-old session cookie cannot moderate. That
is real, and it is not MFA — re-authenticating proves control of the same email or Discord
account, not of a separate device.

The exposure is bounded for now by circumstance, not design: nothing is deployed, and no
production admin account exists. **Passkeys (preferred) or TOTP must land before the first
production deploy, and before Phase 5.** The freshness check stays when they do — a passkey
proves _who_, freshness proves _now_, and admin actions want both.

### 4. ~~OpenSSF Scorecard not run~~ — **CLOSED 2026-09-20**

Added as `scorecard.yml` once the repo went public. The objection was specific to a private
repo, where it needed a classic PAT with `repo` scope — a long-lived, broadly-scoped
credential, which contradicts SR-0.14. Public, it authenticates with OIDC, stores no
credential, and publishes results externally where they cannot be quietly edited.

It does not gate merges. The checks that must block already do, in `ci.yml`; Scorecard is a
second opinion, and a score that drifts down is a prompt to look.

### 6. CodeQL default setup not enabled (new)

Available now that the repo is public, but the API refuses without the `security_events`
token scope. It is two clicks in **Settings → Code security → Code scanning → Set up**.

_Compensating meanwhile:_ Semgrep runs on every PR with the OWASP, TypeScript, Node and
React rule packs and **blocks** on any error-severity finding, plus type-aware ESLint
security rules. CodeQL adds depth, not the only coverage.

### 5. Authenticated DAST

The nightly ZAP scan is unauthenticated. It covers headers, CSP, information disclosure and
the public surface, but not post-login pages.

_Path out:_ seed a session and pass it to ZAP via a replacer rule. Worth doing when there is
more behind the login than watches and breaks; **required before Phase 5.**

---

## Reassess

At the start of every phase, and before any public launch. Phase 5 additionally requires
ASVS **L3** for authentication, session management and business logic, plus an external
pentest or a structured WSTG self-test (SR-5.10).

---

## Phase 5: money, uploads and business logic

Assessed 2026-09-25, after slices 1–7a. The plan asks for Level 2 throughout and **Level 3 for
money movement**, which in ASVS terms is V2 (business logic) and the authentication rows that
guard it.

The pattern below repeats deliberately: where a control could be a check in a route or a grant
in the database, it is a grant. A route can be changed in an afternoon; a column the role holds
no privilege on cannot be written however the code is persuaded to ask.

| #   | Control                                                           | Status  | Evidence                                                                                                                                                                          |
| --- | ----------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Business logic enforced server-side                               | **Met** | The order state machine is a pure table in `@gth/core`, exhaustively tested, and written a second time as RLS policies. Where they disagree the database wins, and a test says so |
| 2.2 | Sequential steps cannot be skipped                                | **Met** | Every transition goes through one locked function; `created → shipped` and `paid → completed` are refused by the table and by the policy                                          |
| 2.3 | Limits on business actions (L3)                                   | **Met** | New-account caps and velocity limits (SR-5.6), pure with 16 tests, plus route tests. Distinct from the per-minute rate limiter, which is about server load                        |
| 2.4 | Transactions cannot be replayed                                   | **Met** | `webhook_events (provider, event_id)` unique, claimed inside the handling transaction; Stripe idempotency keys on every mutating call                                             |
| 2.5 | Money-affecting actions come from a trusted source (L3)           | **Met** | `paid` and `refunded` are reachable by the `stripe` actor only, from a webhook verified against the raw body. Two tests that a session — buyer or seller — cannot write either    |
| 2.6 | Users cannot act on their own behalf where a conflict exists (L3) | **Met** | Seller cannot confirm delivery, complete a sale, approve a photo, or dispute their own order. Buyer cannot mark completed or change the price. Each tested as raw SQL             |
| 2.7 | Amounts are server-derived                                        | **Met** | The buy request body is **empty**; the amount is copied from the listing and the fee computed from it. `.strict()` would reject a body claiming otherwise                         |

### V6 / V7 — authentication and session, for the money paths

| #   | Control                                    | Status      | Evidence                                                                                                                                                                                                                                |
| --- | ------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.x | Step-up for admin money actions (L3)       | **Met**     | Refund, deliver and complete sit behind four gates: session, admin role, passkey-opened session, opened within twelve hours                                                                                                             |
| 6.x | Sellers hold MFA                           | **Partial** | Passkeys are available and required for admins. Selling is **not** gated on a role (see `authorize.ts`) — the real gate is Stripe's KYC — so a seller with only a magic link can list. SR-X.3 asks for MFA on seller accounts; not done |
| 7.x | Session binding on state-changing requests | **Met**     | Origin / `Sec-Fetch-Site` checks plus `SameSite=Lax`, unchanged from Phase 1 and inherited by every Phase 5 route                                                                                                                       |

### V5 — file upload

| #   | Control                                               | Status  | Evidence                                                                                                                                                  |
| --- | ----------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Type validated from content, not from metadata        | **Met** | Magic bytes; declared type must match, and a mismatch is refused                                                                                          |
| 5.2 | Size and dimension bounds before decoding             | **Met** | Header-only parse; a 30000 × 30000 PNG of seventy bytes is refused before any decoder is called                                                           |
| 5.3 | Files re-encoded, metadata stripped                   | **Met** | Rebuilt from decoded pixels. EXIF proven absent with a real APP1 segment; a `tEXt` payload proven gone                                                    |
| 5.4 | Malware scanning                                      | **Met** | ClamAV INSTREAM against real clamd. An unreachable scanner leaves the photo `pending` — never "clean"                                                     |
| 5.5 | Uploads stored outside the webroot, served indirectly | **Met** | Private bucket, presigned PUT with content type **and** length signed; the original is deleted once processed and only the re-encoded copy is ever served |
| 5.6 | Upload cannot be executed or served as another type   | **Met** | Fixed `Content-Type` on the stored object, `nosniff` on every response, and the served bytes start `FF D8` whatever was uploaded                          |

### What is Open, stated plainly

| Item                                         | Why it matters                                                                                                          | When                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Payout holds (FR-5.6)**                    | `hold_until` exists and nothing writes it. Sellers are paid before buyers can complain — the empty-envelope trade works | Next slice; needs Stripe payout-schedule configuration, not a code change alone |
| **Restricted API keys per service (SR-5.3)** | One key serves both the web and worker paths. The plan asks for a RAK per service so a leaked web key cannot refund     | Dashboard change plus config                                                    |
| **Seller MFA (SR-X.3)**                      | A seller can list with a magic-link session                                                                             | Open decision: it conflicts with "selling is not a role"                        |
| **Geo mismatch flagging (SR-5.6)**           | The address arrives with the payment, after the decision                                                                | Needs a review queue over paid orders                                           |
| **External penetration test (SR-5.10)**      | The person who wrote the controls is the worst-placed person to find the gap                                            | Before real money                                                               |
| **Legal review (§23)**                       | Policy pages are accurate, not lawyered                                                                                 | Before real money                                                               |

The self-review that covers the rest is `docs/security/phase-5-review.md`, including what it
deliberately did not test.
