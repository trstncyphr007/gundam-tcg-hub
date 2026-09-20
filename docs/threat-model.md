# Threat Model: v0 (Phase 0)

Method: STRIDE over trust boundaries. Reviewed at the start of every phase (plan §17). The full
risk register is in the build plan (§17); this file tracks **current state**.

## Trust boundaries in scope now

| ID                | Boundary                                  | Exists in Phase 0?                |
| ----------------- | ----------------------------------------- | --------------------------------- |
| TB2               | HTTP client → `apps/api`                  | Yes (localhost only)              |
| TB3               | App → Postgres / Valkey                   | Yes (dev stack, 127.0.0.1)        |
| TB7               | Developer / CI → GitHub → images          | Yes                               |
| TB1, TB4–TB6, TB8 | Internet edge, third parties, Stripe, VPS | Not yet (Phase 1+ / deploy track) |

## Active threats and controls

| #   | Threat                                            | Controls in place (Phase 0)                                                                                                                                            | Gaps / next                                                      |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T12 | Malicious or compromised npm dependency           | Exact pins + lockfile; `minimumReleaseAge` 7d; install scripts blocked (`onlyBuiltDependencies`); OSV + `pnpm audit` + license gate in CI; Dependabot with 7d cooldown | Review each new dependency via the PR checklist                  |
| T13 | CI/CD compromise (malicious action, token misuse) | Actions pinned by SHA; `permissions: {}` default; `persist-credentials: false`; tool images pinned by digest; actionlint + zizmor gates                                | No signing/deploy yet (deploy track adds cosign)                 |
| T15 | Secret leakage (git, logs)                        | gitleaks pre-commit + CI full history; `.env` generated per machine (mode 600) and gitignored; env errors never echo values; pino redaction of auth/cookie headers     | No GitHub push protection on Free/private (ADR-014)              |
| T16 | API abuse / DoS                                   | Rate limit (in-memory); 1 MB body limit; 15 s request timeout                                                                                                          | Move limiter to Valkey; Cloudflare at deploy                     |
| —   | Info disclosure via errors                        | 5xx responses return `internal_error` only; tested                                                                                                                     | —                                                                |
| —   | Browser-side attacks on API responses             | CSP `default-src 'none'`, HSTS, nosniff, no-referrer, CORP same-site; tested                                                                                           | CORS policy lands with the first browser client                  |
| —   | DB privilege escalation / blast radius            | Per-service roles, no superuser; web can't run DDL; read-only role is read-only; statement timeouts; verified 2026-09-20                                               | RLS arrives with the first user-owned tables (Phase 1)           |
| —   | Container escape / tampering                      | Distroless, non-root 65532, root-owned app files; verified running `--read-only --cap-drop ALL --security-opt no-new-privileges`                                       | Apply the same flags in `docker-compose.prod.yml` (deploy track) |

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

## Accepted risks

- Local hooks can be skipped with `--no-verify`; CI re-runs every gate (ADR-014).
- Solo maintainer self-merges after green CI (ADR-012).
- The deploy workflow and server script are written but **unexercised** until the VPS exists;
  the production stack itself is verified locally (`scripts/verify-prod-stack.sh`).
