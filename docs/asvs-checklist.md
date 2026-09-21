# ASVS 5.0 Level 2 Checklist

**Target:** OWASP ASVS 5.0 **Level 2** for all phases (plan SG1), with Level 3 controls for
money movement in Phase 5.

**Assessed: 2026-09-20**, against Phases 0–2 as built.

Status is one of:

- **Met** — implemented _and_ there is a test or proof that fails if it regresses
- **Partial** — implemented, but something material is missing; the gap is stated
- **Open** — not done; when it lands is stated
- **N/A** — the feature it protects does not exist yet

A control marked Met with no test behind it would be a claim, not a checklist, so the
evidence column is not optional.

---

## V1 Encoding and injection

| #    | Control                                   | Status      | Evidence                                                                                                                                                                                                                                             |
| ---- | ----------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2  | Input validated at every entry point      | **Met**     | zod `.strict()` on HTTP bodies, params, queries, ingest payloads, env. Unknown fields rejected — tested per route                                                                                                                                    |
| 1.3  | Output encoding for the rendering context | **Met**     | React escaping only; `dangerouslySetInnerHTML` banned by lint and Semgrep (guardrail proof 4)                                                                                                                                                        |
| 1.4  | Parameterised database access             | **Met**     | Drizzle only; `sql.raw` banned outside migrations, enforced by `.semgrep.yml` (proof 4). SQL-injection payload tests at query and HTTP layers                                                                                                        |
| 1.5  | OS command injection                      | **Met**     | No shell-out in app code; `child_process` banned by lint                                                                                                                                                                                             |
| 1.6  | No untrusted deserialization              | **Met**     | JSON only, schema-validated                                                                                                                                                                                                                          |
| 1.9  | CSV / spreadsheet injection               | **Met**     | `csvCell` escapes formula prefixes on export; the reader never evaluates anything, so a payload survives import as plain text and comes back out neutralised. Tested end to end through a collection (AC-2.4, AC-3.5)                                |
| 1.12 | SSRF defence                              | **Partial** | Listing URLs must be https and host-matched to an approved retailer; the scanner resolves robots.txt with its own UA and fails closed on 401/403. **Gap:** no DNS-rebinding check on resolved IPs — lands with the first user-supplied URL (Phase 3) |

## V2 Validation and business logic

| #   | Control                              | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | Business logic enforced server-side  | **Met** | Break state machine `draft → live → ended` is one-way and enforced in queries _and_ by a DB CHECK; a finished log cannot be reopened                                                                                                                                                                                                                                   |
| 2.2 | Anti-automation on sensitive actions | **Met** | Per-IP and per-user rate limits; 5 auth links/min, 120 pulls/min, 120 ingest/min, 10 CSV imports/min. Caps: 50 watches, 200 breaks, 2000 pulls, 25 collections, 5000 import rows, 20 auto-created listings. Server-rendered pages forward the visitor's IP, so the per-IP limit counts the visitor instead of pooling everyone into the web container's single address |
| 2.3 | Monetary values as integers          | **Met** | Cents everywhere, `integer` columns, no floats crossing a boundary                                                                                                                                                                                                                                                                                                     |

## V3 Web frontend security

| #   | Control                            | Status      | Evidence                                                                                                                                        |
| --- | ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Security headers on every response | **Met**     | HSTS, nosniff, referrer-policy, COOP, CORP, Permissions-Policy; asserted in the e2e suite and by ZAP nightly                                    |
| 3.2 | Content-Security-Policy            | **Partial** | Per-request nonce, `strict-dynamic`, no wildcard sources, `object-src`/`base-uri` none. **Gap:** `style-src 'unsafe-inline'` — see "Known gaps" |
| 3.3 | Clickjacking defence               | **Met**     | `frame-ancestors 'none'`, asserted in tests                                                                                                     |
| 3.4 | Cookie attributes                  | **Met**     | `HttpOnly`, `SameSite=Lax`, `Secure` + `__Host-` prefix in production                                                                           |
| 3.5 | CSRF defence                       | **Met**     | SameSite cookies plus an Origin check — demonstrated when a request without an Origin was rejected 403                                          |
| 3.7 | No sensitive data in the URL       | **Met**     | Fixed 2026-09-20: the sign-in form now POSTs, so a degraded no-JS submit cannot put an email in the URL. Found by ZAP                           |

## V6 Authentication

| #   | Control                        | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 | No passwords stored            | **Met** | Discord OAuth and magic links only; no password column exists                                                                                                                                                                                                                                                                                                           |
| 6.2 | Single-use, expiring links     | **Met** | 15-minute expiry, single use; replay mints no session (tested)                                                                                                                                                                                                                                                                                                          |
| 6.3 | Account enumeration resistance | **Met** | Identical response whether or not the address has an account                                                                                                                                                                                                                                                                                                            |
| 6.4 | Credentials hashed at rest     | **Met** | API keys and overlay tokens stored as HMAC with a server pepper; constant-time compare. The web role has no SELECT privilege on `key_hash` at all, so the tier serving sessions cannot read the material a forgery would need — proven by a test expecting `permission denied`                                                                                          |
| 6.5 | MFA for privileged accounts    | **Met** | Every admin route requires a session opened **with a user-verified passkey** (a device plus its PIN or biometric) and created within 12 hours (ADR-025). UV is enforced by the server, not assumed: a real signed UV=0 assertion is refused in e2e. Adding a second passkey or removing any needs a passkey session, so an inbox alone cannot swap one in. Gap 3 closed |

## V7 Session management

| #   | Control                          | Status  | Evidence                                                                                                                                                                                                  |
| --- | -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1 | Server-side session invalidation | **Met** | Sign-out revokes server-side (tested)                                                                                                                                                                     |
| 7.2 | Session lifetime bounded         | **Met** | 7-day rolling, 30-day absolute                                                                                                                                                                            |
| 7.4 | Token revocation is immediate    | **Met** | Rotating an overlay token overwrites its hash, so the old one matches nothing; live viewers are dropped (AC-2.2). A revoked API key is refused on the next request — there is no cache to expire (AC-3.3) |

## V8 Authorization

| #   | Control                            | Status  | Evidence                                                                                                                                                                                                                             |
| --- | ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 8.1 | Deny by default                    | **Met** | `authorize()` requires an explicit action; every route declares one                                                                                                                                                                  |
| 8.2 | Ownership checked on every object  | **Met** | Two-user IDOR tests for watches, breaks and collections, at the query layer and over HTTP; "not found" and "not yours" return the same answer (AC-3.2)                                                                               |
| 8.3 | Defence in depth at the data layer | **Met** | RLS `FORCE` on watches, breaks, pulls and collections. Proven by a test that counts a draft row on an unscoped connection and gets zero, and by one showing a _public_ collection is readable by everyone and writable by one person |
| 8.4 | Roles are server-controlled        | **Met** | `role` is `input: false`; grants are CLI-only and audited with before/after                                                                                                                                                          |

## V11 Cryptography

| #    | Control                  | Status      | Evidence                                                                                                                                                                                                                                                                          |
| ---- | ------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.1 | Approved primitives only | **Met**     | Node `crypto` only: HMAC-SHA256, `randomBytes`. No custom crypto                                                                                                                                                                                                                  |
| 11.2 | Adequate entropy         | **Met**     | 32 bytes CSPRNG for overlay tokens and API secrets                                                                                                                                                                                                                                |
| 11.3 | Constant-time comparison | **Met**     | `timingSafeEqual`; length checked first                                                                                                                                                                                                                                           |
| 11.4 | Key rotation possible    | **Partial** | Token rotation is built and proven. `DATA_ENCRYPTION_KEYS` carries a key id in every ciphertext (`v1:<kid>:…`) and now protects two fields in use: break server seeds and live-sale buyer handles. **Gap:** no re-encryption job, so rotation adds a key rather than retiring one |

## V14 Data protection

| #    | Control             | Status   | Evidence                                                                                                                                                                                                                                                                         |
| ---- | ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.1 | Data minimisation   | **Met**  | Public and overlay queries select no creator id, name or email — enforced by the query, not the template. A shared collection returns the cards but nulls the owner's cost, purchase date and notes in SQL, so no route can leak them and no gain/loss is computed for a visitor |
| 14.2 | No secrets in logs  | **Met**  | pino redaction; the overlay token is masked out of the request URL before logging                                                                                                                                                                                                |
| 14.3 | Caching controlled  | **Met**  | `no-store` on per-user, overlay and health responses                                                                                                                                                                                                                             |
| 14.5 | Export and deletion | **Open** | SR-X.25. Required before public launch                                                                                                                                                                                                                                           |

## V16 Logging and monitoring

| #    | Control                     | Status   | Evidence                                                                                                   |
| ---- | --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| 16.1 | Security events logged      | **Met**  | `audit_log` covers auth events, role changes, watch and break lifecycle, token rotation, restock detection |
| 16.2 | Append-only audit trail     | **Met**  | UPDATE/DELETE/TRUNCATE revoked from app roles; a test proves tampering fails                               |
| 16.3 | No PII in logs              | **Met**  | User ids not emails; IPs hashed                                                                            |
| 16.4 | Alerting on security events | **Open** | SR-X.22. Needs the Discord ops webhook, which needs credentials                                            |

## V17 Dependency and supply chain

| #    | Control                               | Status      | Evidence                                                                                                                                                                        |
| ---- | ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17.1 | Dependencies pinned and locked        | **Met**     | Exact pins, committed lockfile, `--frozen-lockfile`, `minimumReleaseAge` 7d, install scripts blocked                                                                            |
| 17.2 | Known-vulnerable dependencies blocked | **Met**     | OSV-Scanner + `pnpm audit`, blocking. Guardrail proof 3                                                                                                                         |
| 17.3 | Build provenance                      | **Partial** | cosign keyless signatures + CycloneDX SBOM attestations; verified twice before deploy. **Gap:** GitHub provenance attestation unavailable on user-owned private repos (ADR-014) |
| 17.4 | Pinned CI actions and images          | **Met**     | Every action by SHA, every tool image by digest; zizmor enforces                                                                                                                |

---

## Known gaps

Listed because a checklist that only records successes is marketing.

### 1. `style-src 'unsafe-inline'` (V3.2)

React's `style` prop and Tailwind's injected styles both need it. Removing it means nonced
`<style>` tags plus `style-src-attr`, whose browser support is uneven enough to risk an
unstyled page in Safari.

_Impact:_ CSS injection could exfiltrate via selectors or attempt UI redress. Script
execution stays closed — `script-src` has no `unsafe-inline`, asserted in CI.

_Path out:_ move inline styles to CSS classes and variables, then drop it. Worth doing
before public launch; not worth an unstyled site now.

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
