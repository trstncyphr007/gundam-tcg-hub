# Threat Model

**Reviewed 2026-09-23, covering Phases 0–4 and the deploy track.** Method: STRIDE over trust
boundaries, reviewed at the start of every phase (plan §17). The full risk register is in the
build plan; this file tracks **current state**, and a control is listed only when something in
the repository enforces it.

Sections are dated, and the older ones are left as written: what was true in Phase 0 is part of
how this got here. Each section says what it added.

## Trust boundaries in scope now

| ID  | Boundary                         | State                                                                                         |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| TB1 | Internet → edge (Caddy)          | Built and verified locally; **unexercised** until the VPS exists                              |
| TB2 | HTTP client → `apps/api`         | Yes                                                                                           |
| TB3 | App → Postgres / Valkey          | Yes, with per-service roles and row-level security                                            |
| TB4 | Platform → third-party sites     | **Outbound is one request**: the Discord webhook. Retailer fetching lives in the scanner repo |
| TB5 | Platform ↔ Discord               | Outbound webhook only; no bot yet                                                             |
| TB6 | Platform ↔ Stripe                | Not yet (Phase 5)                                                                             |
| TB7 | Developer / CI → GitHub → images | Yes, signed with provenance and verified twice                                                |
| TB8 | Admin → VPS                      | Written (Tailscale-only); **unexercised** until the VPS exists                                |

## Active threats and controls

| #   | Threat                                            | Controls in place (Phase 0)                                                                                                                                            | Gaps / next                                                                                                           |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| T12 | Malicious or compromised npm dependency           | Exact pins + lockfile; `minimumReleaseAge` 7d; install scripts blocked (`onlyBuiltDependencies`); OSV + `pnpm audit` + license gate in CI; Dependabot with 7d cooldown | Review each new dependency via the PR checklist                                                                       |
| T13 | CI/CD compromise (malicious action, token misuse) | Actions pinned by SHA; `permissions: {}` default; `persist-credentials: false`; tool images pinned by digest; actionlint + zizmor gates                                | Closed: keyless signatures, SBOM and SLSA provenance on both images, verified in CI and again on the server (ADR-032) |
| T15 | Secret leakage (git, logs)                        | gitleaks pre-commit + CI full history; `.env` generated per machine (mode 600) and gitignored; env errors never echo values; pino redaction of auth/cookie headers     | No GitHub push protection on Free/private (ADR-014)                                                                   |
| T16 | API abuse / DoS                                   | Rate limit (in-memory); 1 MB body limit; 15 s request timeout. Refusals are now **recorded** and alerted on (ADR-037/038)                                              | Move limiter to Valkey; Cloudflare at deploy                                                                          |
| —   | Info disclosure via errors                        | 5xx responses return `internal_error` only; tested                                                                                                                     | —                                                                                                                     |
| —   | Browser-side attacks on API responses             | CSP `default-src 'none'`, HSTS, nosniff, no-referrer, CORP same-site; tested                                                                                           | CORS policy lands with the first browser client                                                                       |
| —   | DB privilege escalation / blast radius            | Per-service roles, no superuser; web can't run DDL; read-only role is read-only; statement timeouts; verified 2026-09-20                                               | Closed: row-level security on every user-owned table, forced for the owner too                                        |
| —   | Container escape / tampering                      | Distroless, non-root 65532, root-owned app files; verified running `--read-only --cap-drop ALL --security-opt no-new-privileges`                                       | Closed: the same flags are in `docker-compose.prod.yml`, asserted by `scripts/verify-prod-stack.sh`                   |

## Phase 1 additions (catalog + public reads, 2026-09-20)

| Threat                                                     | Controls                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL injection via search/filter parameters                 | Parameterised queries only (Drizzle); zod validation with `.strict()`; injection payload tests at both the query and HTTP layers                                                |
| Enumeration / scraping of the catalog                      | Cursor pagination with a hard page cap (100), rate limiting, `max-age=300` caching                                                                                              |
| Information disclosure through validation errors           | 400 responses carry field names and rule codes only; a test asserts the submitted value is never echoed                                                                         |
| Compromised API process pivoting to data tampering         | Public reads use the **read-only** role; `stock_snapshots` is insert-only for the worker and forbidden to the web role; `audit_log` cannot be updated, deleted or truncated     |
| Scanner pointed at an unvetted retailer (T2/T18 precursor) | DB check constraint: a retailer cannot be `enabled` until `tos_reviewed_at` is set **and** `robots_ok` is true; product URLs must be `https://`; minimum scan interval enforced |
| Publisher IP exposure                                      | `card_variants.image_ref` stores a link; card art is never rehosted (plan §23). The seeded catalog is placeholder data, not publisher data                                      |

## Accounts additions (2026-09-20)

| Threat                                 | Controls                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential theft / password reuse (T1) | No passwords exist: Discord OAuth or single-use email links (15 min). Nothing to steal, phish or crack                                                                             |
| Session hijacking / fixation (T1)      | `HttpOnly`, `SameSite=Lax`, `Path=/` cookies; `Secure` + `__Host-` prefix in production; 30-day absolute lifetime; server-side revocation on sign-out (tested)                     |
| Magic-link replay or forgery           | Single use, expiring; a replayed or forged token mints **no** session (tested)                                                                                                     |
| Privilege escalation (T4, SR-X.9)      | `role` is server-controlled (`input: false`); the profile endpoint rejects unknown fields; the update path never includes `role`; verified against both our API and the provider's |
| Rate-limit evasion behind a proxy      | The client IP comes from `X-Forwarded-For` **only** when `API_TRUST_PROXY` is on; otherwise all proxied users would share one bucket                                               |
| Auth abuse (link flooding)             | 5 link requests/min per IP, 10 verifications/min, 10 social sign-ins/min (tested)                                                                                                  |
| Sign-in link leaking into logs         | Links are logged only in development; production without SMTP refuses to boot                                                                                                      |
| CSRF on state-changing auth routes     | `SameSite=Lax` plus a trusted-origins allowlist                                                                                                                                    |
| Unauthorised access to account data    | Deny-by-default `authorize()`; anonymous callers get 401, wrong role gets 403 (tested); per-user responses are `no-store`                                                          |

## Watches additions (2026-09-20)

| Threat                                      | Controls                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading another user's watches (IDOR, T4)   | Two independent layers: `authorize()` ownership checks in the app **and** Postgres row-level security keyed on a per-transaction `app.user_id`. Verified with raw SQL that bypasses the app entirely |
| Deleting/altering another user's watches    | RLS `USING` clauses on UPDATE/DELETE; the API deletes by `(id, owner)`; a miss returns **404, not 403**, so ids are never confirmed                                                                  |
| Creating a row owned by someone else        | RLS `WITH CHECK` on INSERT rejects a forged `user_id`; the API takes the owner from the session and rejects unknown body fields                                                                      |
| Identity leaking between pooled connections | `set_config(..., true)` is transaction-scoped; a connection with no declared user sees zero rows (tested)                                                                                            |
| Queue flooding via unlimited watches        | 50 watches per user, enforced before insert; duplicates rejected by partial unique indexes                                                                                                           |
| Malformed subscriptions reaching the worker | DB checks: exactly one target, and at least one channel via `cardinality` (`array_length` is NULL on an empty array, and CHECK passes on NULL)                                                       |
| Worker over-reach                           | The worker may read all watches (needed for fan-out) but has INSERT/UPDATE/DELETE revoked                                                                                                            |

## Web frontend additions (2026-09-20)

| Threat                                    | Controls                                                                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XSS in rendered catalog/profile text (T5) | React escaping only; `dangerouslySetInnerHTML` banned by lint; **nonce-based CSP** per request with `strict-dynamic` and no `script-src 'unsafe-inline'`. An e2e test asserts the header and that no un-nonced inline script exists |
| Session cookie sent cross-site            | The API is proxied under the web origin, so cookies stay same-origin: no `SameSite=None`, no CORS, no credentialed cross-origin requests                                                                                            |
| Clickjacking                              | `frame-ancestors 'none'` plus `Cross-Origin-Opener-Policy: same-origin`                                                                                                                                                             |
| Account enumeration on the sign-in form   | Identical UI response whether or not the address exists (SR-X.4)                                                                                                                                                                    |
| Stale UI after sign-out                   | Sign-out revokes server-side, then the client refreshes; an e2e test re-opens the protected page and expects it closed                                                                                                              |
| Client-supplied ownership data            | The watch button sends only a product id; owner comes from the session. Cross-user isolation is re-tested through the browser                                                                                                       |
| Leaking user data into caches             | Per-user pages are `no-store` at the API; catalog pages are public and cached                                                                                                                                                       |
| Third-party script/style injection        | No external script or font origins: `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`                                                                                                                                    |

## Deploy track additions (2026-09-20)

| Threat                                      | Controls                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploying a tampered or foreign image (T13) | Keyless signing at build; **verified twice** — in CI and again on the server — against this repo's release workflow identity. Digest format validated before use |
| Command injection through deploy inputs     | Workflow inputs pass via the environment, never interpolated into shell; digests must match `^sha256:[0-9a-f]{64}$` (zizmor clean)                               |
| A merge silently reaching production        | Deploy is `workflow_dispatch` only, environment chosen by a human; release never deploys                                                                         |
| Secrets on disk                             | SOPS+age encrypted at rest; decrypted only into tmpfs (`/run/gth`) at deploy time, mode 0400                                                                     |
| Broken release left running                 | Migrations run first as a one-off job; failure rolls back to the recorded last-good digests                                                                      |
| Container escape / lateral movement         | Non-root, read-only, all capabilities dropped (minimum re-added for Postgres/Valkey), no-new-privileges, per-service CPU/memory/PID limits                       |
| Reaching the databases from outside         | Postgres and Valkey sit on an `internal: true` network with **no published ports** — Docker cannot publish from it at all (proven locally)                       |
| Rate-limit evasion behind the proxy         | Caddy overwrites `X-Forwarded-For`; the API trusts it only because of that                                                                                       |
| SSH exposed to the internet                 | Tailscale-only administration; UFW allows 80/443 only                                                                                                            |
| Ransomware destroying backups               | Server holds write-only backup credentials; pruning uses a separate offline key; restore drill documented and scheduled                                          |

## Real sources and listing resolution (2026-09-20)

Accepting reports in the scanner's own vocabulary (`productSlug` + `retailerDomain` + `url`,
ADR-016) means a machine credential can now cause a row to be written to the catalog. Treat the
scanner as semi-trusted: authenticated, but possibly buggy or compromised.

| Threat                                                | Controls                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A report introduces a shop we never reviewed          | The retailer must already exist **and** be enabled; a CHECK constraint ties `enabled` to a recorded ToS/robots review. `app_worker` has no write access to `retailers` |
| A report points a listing at an arbitrary site (SSRF) | URL must be `https:` and its host must equal the retailer's domain or sit under it on a label boundary; `shop.invalid.evil.test` and `notshop.invalid` both fail       |
| A report repoints or deletes an existing listing      | Grant is INSERT only (migration 0009); UPDATE and DELETE stay revoked, proven by a role-level test                                                                     |
| A report invents products to pollute the catalog      | `productSlug` must resolve to an existing `sealed_products` row; `app_worker` cannot write that table                                                                  |
| A malfunctioning scanner floods `retailer_products`   | 20 auto-created listings per product per retailer, then `listing_limit_reached`; ingestion is rate-limited at 120 req/min per key                                      |
| Silent acceptance of a rejected report                | Rejections return 422 with an explicit reason, so the operator sees why rather than assuming success                                                                   |
| Scraping a shop that forbids it                       | `sources.json` records the robots.txt evidence per shop (`docs/scanner-source-review.md`); disallowed shops are imported with `enabled = false`                        |

## Creator tooling and the OBS overlay (Phase 2, 2026-09-20)

The overlay is opened by a URL with no account behind it, on a machine that is broadcasting
its own screen. That combination is the whole threat model for this phase: **the URL is the
credential, and the display is public by construction.**

| Threat                                                   | Controls                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlay token leaked on stream, in a clip, or in a repo  | 32 CSPRNG bytes, stored as an HMAC and shown exactly once. Regenerating it kills the old one instantly — the hash is overwritten, so there is nothing left to match (AC-2.2)    |
| Token leaking through logs or referrers                  | The token lives in the URL path, so the request-log serialiser masks that segment; responses are `no-store`, `no-referrer` and `noindex`                                        |
| Token guessed or brute-forced                            | Lookup is a single indexed probe on the hash; a wrong token is indistinguishable from a missing break. 43 characters of base64url is not searchable                             |
| A revoked token kept working for someone already viewing | The live stream notices the rotation, emits `revoked` and closes the connection                                                                                                 |
| Reading a draft break by guessing its id                 | Row-level security: readable only by the creator, or by presenting the token's hash to Postgres for that transaction (ADR-017). Proven by a test that counts zero rows unscoped |
| One creator reading or editing another's break           | RLS on both tables plus ownership checks; "not found" and "not yours" return the same answer                                                                                    |
| XSS through a break title or card label on stream        | React escaping, nonce CSP, no `dangerouslySetInnerHTML`. A payload is stored verbatim as data and rendered as text — asserted in the browser on the page _and_ the overlay      |
| Personal data appearing on stream (FR-2.4)               | The public and overlay queries select no creator id, name or email. Stream-safe is a property of the query, not of the template                                                 |
| A spreadsheet executing an exported cell                 | Formula-injection escaping on every cell, including headers; the Excel DDE payload is in the test corpus (AC-2.4)                                                               |
| Rewriting a pull log after the fact                      | `UPDATE`/`DELETE` revoked from the app roles before any data existed; a live break cannot be reopened once ended. Phase 4 hash-chains on top of this                            |
| A creator flooding the tables                            | 200 breaks per creator, 2000 pulls per break, 120 pulls/min rate limit                                                                                                          |
| Overlay connections exhausting the server                | 5 concurrent streams per token, heartbeats, and a server-side idle timeout                                                                                                      |
| Self-granting the creator role                           | `role` is `input: false`; grants are CLI-only and write the previous and new value to the audit log                                                                             |

## Prices, collections and the public API (Phase 3, 2026-09-21)

The index is the thing worth attacking: it is a number other people will make decisions with.

| Threat                                              | Controls                                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Moving the published price by submitting fake sales | A report never counts until a person approves it; the index needs at least 3 observations; the nightly rollup takes a **trimmed** median, so a single outlier cannot move it   |
| A seller pricing their own card into the index      | Live-sale entries are checked against the published spread and held for review when far outside it (SR-4.4); a held entry never reaches a published price                      |
| Leaking an API key from the database                | Stored as `prefix` + HMAC; **`app_web` cannot SELECT `key_hash` at all** (migration 0017) — the pool that serves the developer page physically cannot read the secret it wrote |
| A leaked key being used indefinitely                | Revocation is immediate and the key is matched by prefix then constant-time compare; `gth_live_` has its own gitleaks rule, proven by guardrail proof 1b                       |
| Reading another person's collection (IDOR)          | `authorize()` plus row-level security; a shared collection nulls the owner's cost, purchase date and notes **in SQL**, so no route can leak them                               |
| A CSV import as a denial of service                 | 2 MB body cap, row cap, streaming parse, per-row zod validation                                                                                                                |
| A spreadsheet executing an imported cell            | Formula prefixes are escaped on export; nothing is ever evaluated on import, so a payload survives as text and leaves as text (AC-3.5)                                         |
| Scraping the whole index through the public API     | Cursor pagination with a hard page cap, per-key and per-IP quotas, `max-age=300` caching. The index is published under CC BY 4.0 anyway — attribution, not secrecy, is the ask |

## Live sales and provable fairness (Phase 4, 2026-09-22)

| Threat                                                  | Controls                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A creator re-rolling a break until they like the result | Commit–reveal: the server seed is committed as a hash **before** the break and revealed after; the shuffle is deterministic, versioned and covered by known-answer tests |
| The server seed leaking before the reveal               | Encrypted at rest with a key id, and only the **worker** role may read `server_seed_encrypted` — the web tier cannot, so a compromised page cannot expose it             |
| Rewriting a pull log after the fact                     | Append-only grants, plus a hash chain: each row carries the previous row's hash, and the head is published when the break closes                                         |
| A buyer's name from the live-sale logger leaking        | Encrypted, never shown publicly, and erased after 90 days by a job running on a role that **cannot read the column it clears** (ADR-022)                                 |
| A breaker profile making unverifiable claims            | Profiles report only what the logs contain; pull rates are computed from recorded pulls, and a "verified randomisation" badge requires a revealed seed                   |

## Account security (2026-09-22 → 23)

| Threat                                          | Controls                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An inbox alone taking over an admin account     | Admin pages need a session opened **with a passkey**, within twelve hours. Adding a second passkey, or removing one, also needs a passkey session (ADR-025)                     |
| A stolen or cloned authenticator                | User verification and presence are enforced from the signed authenticator data, not from anything the client says; signature counters are checked                               |
| Session tokens leaking through the account page | Better Auth's own `/list-sessions` and `/revoke-*` endpoints are switched off; ours return an opaque id and never a token (ADR-026)                                             |
| A weaker session ending a stronger one          | A non-passkey session cannot revoke a passkey session                                                                                                                           |
| Sign-in from somewhere new going unnoticed      | The owner is emailed, with a coarse device description ("Chrome on Windows") derived on the server — never the raw header                                                       |
| Deleting an account leaving data behind         | One `SECURITY DEFINER` function: cascades what was only theirs, deletes unpublished reports, anonymises approved ones. The web role lost `DELETE` on `users` entirely (ADR-027) |
| An export handing over working credentials      | The export selects no tokens, no hashes and no other person's name; withheld fields are named in the file rather than silently dropped                                          |

## Data protection (2026-09-23)

| Threat                                                | Controls                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A database copy revealing where people connect from   | IP addresses are stored only as `iph1:<day>:<hmac>`, re-keyed daily, and a CHECK refuses a raw address from any writer (ADR-028)                                       |
| An old encryption key staying valid for ever          | `pnpm keys:rotate` re-encrypts every value under the active key and reports which old keys are now unused, so a rotation **retires** a key rather than adding one      |
| Personal data kept past its purpose                   | Nightly retention in one database function that takes no arguments: the caller chooses when it runs, never how far back it reaches. The prune records itself (ADR-035) |
| Suppressing the "new device" notice by deleting a row | A table policy allows deleting a device row **only** once it is a year old — the floor holds for every caller, including the retention job itself                      |

## The platform's own surface (2026-09-23)

| Threat                                           | Controls                                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new outbound request becoming an SSRF hole     | The platform makes **exactly one** outbound request, to an exact-host allowlist with redirects refused; Semgrep fails CI on a second one, proven by guardrail proof 8 |
| An inline style or script slipping past the CSP  | Production refuses both; a style prop is banned by lint (proof 9) and the e2e suite reads the **served HTML** rather than the live DOM, where the CSSOM would hide it |
| A researcher's report going to an unread address | `security.txt` is served only once a real contact exists, with an `Expires` generated per request so it cannot rot (ADR-034)                                          |
| A published claim quietly becoming untrue        | The privacy page's retention periods come from the same constants the server enforces, and the e2e suite asserts them in the served HTML                              |

## Operations (2026-09-23)

| Threat                                                   | Controls                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An attack in progress looking like an ordinary quiet day | Refused sign-ins and rate-limit refusals are recorded — endpoint, short code and that day's source hash, never an address that was tried (ADR-037) — and a watchdog alerts on spikes |
| The audit log being pruned to hide an intrusion          | Application roles have no `DELETE` on it; pruning is a fixed-period function that writes its own footprint into the log it pruned                                                    |
| A rate-limit flood becoming an audit-log flood           | One row per caller per ten minutes, carrying the count; the throttle is bounded and "full" means stop counting, never stop limiting                                                  |
| A failure nobody hears about                             | Job and backup failures report through one `gth-alert@` unit; the watchdog posts spikes and a daily "all clear", so silence means working rather than dead (ADR-038)                 |
| An incident with no way to stop the bleeding             | Kill switches exist and are reachable at `/admin/switches`; switching off the public API deliberately leaves sign-in, the console and `/healthz` up (ADR-039)                        |
| A switch left off and forgotten                          | The watchdog names anything still off once a day, quoting the reason typed when it was pulled                                                                                        |

## Accepted risks

- Local hooks can be skipped with `--no-verify`; CI re-runs every gate (ADR-014).
- Solo maintainer self-merges after green CI (ADR-012).
- The deploy workflow and server script are written but **unexercised** until the VPS exists;
  the production stack itself is verified locally (`scripts/verify-prod-stack.sh`).

### Still open, stated plainly (2026-09-23)

- **Nothing has ever alerted for real.** The watchdog, the failure units and the post path are
  built and tested against a fake `fetch`, but no message has reached a Discord channel,
  because there is no webhook yet. The first real one is a thing to watch for.
- **The resolved-address (DNS rebinding) check is owed by the scanner repository.** This
  repository fetches nothing from retailers, so it cannot hold that control; the checklist says
  so rather than implying the whole system is covered.
- **CrowdSec bans and a refused deploy signature reach the ops channel from the host**, and
  nothing correlates them with the application's own view of an attack.
- **The policy pages are accurate, not lawyered.** §23 requires a review before Phase 5.
- **Phase 5 has no threat coverage here yet** — payments, uploads and disputes (T9–T11) arrive
  with the feature, not before it.
- **The limiter is in-memory**, so it is per-process. That is correct for one instance and
  wrong the moment there are two; SR-X.27 moves it to Valkey then.
