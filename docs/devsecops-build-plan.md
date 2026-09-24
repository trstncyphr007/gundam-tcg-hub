# Gundam TCG Platform: Full-Stack DevSecOps Build Plan

| Field                | Value                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Document             | Full-Stack DevSecOps Build Plan                                                                        |
| Project working name | `gundam-tcg-hub` (rename at any time)                                                                  |
| Owner                | TRSTN (GUNDAM with TRSTN)                                                                              |
| Version              | 1.2 (Approved; amended 2026-09-20 and 2026-09-25, see Amendments A1 and A2)                            |
| Date                 | 2026-09-20 (amended 2026-09-25)                                                                        |
| Source strategy      | `TCG Market Project\tcg-marketplace-strategy-outline.txt`                                              |
| Canonical copy       | `TCG Market Project\docs\devsecops-build-plan.md`                                                      |
| Code repo            | `github.com/trstncyphr007/gundam-tcg-hub` (private); local `~/code/gundam-tcg-hub` in WSL Ubuntu-24.04 |

> ## Amendment A1 (2026-09-20): overrides conflicting text below
>
> 1. **The existing scanner was found.** It's a working **Python** project in the private repo `trstncyphr007/gundam-scanner`. It includes 20 sources, Docker, systemd timers, and tests. A gitleaks scan of its full history found no leaks.
>    **Decision:** keep it **in Python, in its own repo**. It is _not_ ported or merged. This replaces D5 and removes `apps/restock-scanner` from the monorepo. The platform ingests scanner results later, through Postgres or the queue, in Phase 1 (ADR-013).
>    **Compliance follow-up:** several of its sources scrape HTML (Amazon, Walmart, TCGplayer, eBay). Each needs a ToS review in Phase 1, preferring the official-API sources (`walmart_api`, `ebay_api`) per §23.
> 2. **Repo:** a new, separate private repo `gundam-tcg-hub` (ADR-001 amended). It is a polyglot boundary: TypeScript here, Python in the scanner repo.
> 3. **The GitHub plan is Free, and the repo is private.** Branch rulesets, secret scanning with push protection, CodeQL, dependency-review, and private deployment environments aren't available. **Compensating controls (ADR-014):**
>    - Every §18 scanner (gitleaks, Semgrep, OSV-Scanner, `pnpm audit`, a license allowlist, hadolint, actionlint, zizmor, Trivy config and image, Syft SBOM) runs as a **failing CI job**. Reports go to CI artifacts instead of the Security tab.
>    - Lefthook runs gitleaks before every commit, and a pre-push hook refuses direct pushes to `main` (override with `ALLOW_MAIN_PUSH=1`).
>    - Dependabot alerts and security updates stay on (free on private repos).
>    - SR-0.1, SR-0.2 and SR-0.4 are deferred until the repo is public or the plan is upgraded.
>    - The production deploy approval gate moves to a manual `workflow_dispatch` step.
> 4. **Phase 0 scope:** the monorepo scaffold ships `apps/api` (Fastify), `packages/core`, `packages/security` and `packages/config`. `apps/web`, `apps/worker` and `apps/discord-bot` arrive in Phase 1.

> ## Amendment A2 (2026-09-25): what was actually built
>
> Phases 1–4 are built. Several things below describe a system that no longer matches the one
> in the repository — each for a reason, each recorded in an ADR. **This list was made by
> checking the repository, not from memory**, because a plan that quietly stops describing
> reality is worse than one that admits where it diverged: it is the document somebody reads
> first, and the one they will believe.
>
> 1. **No Valkey, and no queue** (ADR-042, supersedes ADR-004 and every mention of BullMQ).
>    It ran in both stacks for weeks with nothing connected to it. Rate limits are in process
>    memory, the per-day API quota is in Postgres, and there is no message queue. It comes back
>    when a second instance or a real queue needs it.
> 2. **No `apps/worker`** (ADR-036). Scheduled work runs as one-shot containers built from the
>    API image, under a `jobs` compose profile: `migrator`, `retention`, `rollup`, `watchdog`
>    and `alert-retry`. Fan-out itself happens inside the scanner's own ingest request.
> 3. **No `apps/restock-scanner` and no `packages/adapters`** — both follow from A1: the
>    scanner is a separate Python repository, and the retailer adapters live with it.
> 4. **No `apps/discord-bot`.** Alerts reach Discord by **webhook** only. The bot, Discord DMs
>    and web push are deliberately unbuilt: `discord_dm` and `web_push` exist as declared
>    _unsupported_ transports, so a watch asking for one records `skipped` rather than
>    pretending. The bot is blocked on a token (§28).
> 5. **No `packages/observability`, and no OpenTelemetry.** There are no traces and no metrics
>    pipeline. What exists is structured `pino` logging to stdout, the `/admin/operations`
>    page, and the watchdog that reads it and speaks up (ADR-038). §20 describes an intention,
>    not a state.
> 6. **`packages/alerts` exists** and is not in the §6 tree: transports, fan-out and the retry.
> 7. **Nothing deploys on merge.** `release.yml` builds, signs and attests; `deploy.yml` is
>    `workflow_dispatch` only and takes the environment as an input, for staging _and_
>    production. §18.4 step 5 says staging deploys automatically. It does not.
> 8. **`/docs` is routed at the edge**, not through the web app: `output: 'standalone'` bakes
>    Next's rewrite target in at build time, when the API's address is not yet known.
>
> Nothing in Phase 5 is built, as planned.

**How to read this document**

- **FR-x** = functional requirement.
- **SR-x** = security requirement.
- **NFR-x** = non-functional requirement.
- **AC** = acceptance criteria.
- "MUST" is mandatory for the phase to be Done. "SHOULD" is strongly recommended. "MAY" is optional.

---

## Table of Contents

1. Context and Goals
2. Decisions, Constraints, and Assumptions
3. Scope by Phase
4. System Architecture
5. Technology Stack
6. Repository Structure
7. Data Model
8. Environments
9. Phase 0: Workstation, Repo, and DevSecOps Foundation
10. Phase 1: Card Catalog and Restock Alerts
11. Phase 2: Creator Tooling
12. Phase 3: Price Tracker, Collection Manager, Open Pricing API
13. Phase 4: Live-Sale Price Capture and Break Transparency
14. Phase 5: Marketplace (Stripe Connect)
15. Deploy Track: Hostinger KVM VPS
16. Cross-Cutting Security Requirements Catalog
17. Threat Model
18. CI/CD and Security Pipeline
19. Container Hardening
20. Observability, Alerting, and SLOs
21. Backup and Disaster Recovery
22. Incident Response
23. Compliance, Legal, and Data-Source Policy
24. Testing Strategy
25. Global Definition of Done
26. Execution Order and Milestone Checklist
27. Verification (End-to-End)
28. Open Items
29. Appendix A: Environment Variable Catalog
30. Appendix B: Tooling Inventory

---

## 1. Context and Goals

### 1.1 Why this is being built

The strategy outline sets out a staged path. Each stage has to be useful on its own, so nothing depends entirely on the marketplace working.

1. Ship Gundam TCG **restock alerts** and **creator tools**.
2. Grow them through GUNDAM with TRSTN content.
3. Expand into an **independent price tracker and collection tool**, plus an open pricing API.
4. Add **live-sale price capture** and **break transparency**. These become the long-term data asset.
5. Layer on a **marketplace** (Stripe Connect) once users are in place.
6. Expand to a second game only after the Gundam community is well served.

### 1.2 Engineering goals

- **G1.** Every phase ships independently to real users.
- **G2.** Security is built in from the first commit, not bolted on. Pipeline gates block insecure changes automatically.
- **G3.** One person can maintain it: one language (TypeScript), one repo, one `docker compose` for local development, and one VPS for production.
- **G4.** Dev and prod stay close. The same containers run locally and on the Hostinger VPS.
- **G5.** The business must not hinge on another platform tolerating us. Prefer official APIs, data users connect themselves, and data our own tools generate.

### 1.3 Security goals

- **SG1.** Target **OWASP ASVS 5.0 Level 2** for all phases, with the Level 3 controls that apply to money movement in Phase 5.
- **SG2.** Zero secrets in git (plaintext). Zero fixable Critical vulnerabilities in shipped images.
- **SG3.** Supply-chain integrity: pinned dependencies, signed images, SBOMs, and provenance attestations.
- **SG4.** Least privilege everywhere: OAuth scopes, bot intents, DB roles, container capabilities, GitHub token permissions, and network exposure.
- **SG5.** Everything security-relevant is auditable (`audit_log`, CI logs, signed releases).

---

## 2. Decisions, Constraints, and Assumptions

### 2.1 Decisions made by the user

| #   | Decision                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The plan covers the full roadmap, phased. Each phase ships on its own.                                                                                                  |
| D2  | TypeScript end to end.                                                                                                                                                  |
| D3  | Build and test locally first. Deploy later to a **Hostinger KVM VPS** (Docker supported).                                                                               |
| D4  | No domain yet. The plan includes one, but building comes first.                                                                                                         |
| D5  | The Gundam scanner is **not on this PC**, so it is rebuilt from scratch as its own project folder (`apps/restock-scanner`) inside the same monorepo as the marketplace. |
| D6  | A GitHub account exists. Use GitHub for repo hosting, Actions, GHCR, and security features.                                                                             |
| D7  | Focus on full-stack DevSecOps now. Business questions are deferred.                                                                                                     |
| D8  | All outputs are delivered as `.md` files.                                                                                                                               |

### 2.2 Technical decisions made in this plan (each recorded as an ADR in `docs/adr/`)

| ADR     | Decision                                                                              | Rationale                                                                                                       |
| ------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ADR-001 | pnpm workspaces + Turborepo monorepo                                                  | One repo holds the scanner and the platform, with shared types and a single CI.                                 |
| ADR-002 | Code lives in the WSL2 Ubuntu filesystem (`~/code/gundam-tcg-hub`), not OneDrive      | Avoids OneDrive sync locking node_modules and `.git`, gives fast Docker bind mounts, and matches the Linux VPS. |
| ADR-003 | Postgres as the system of record, with Drizzle ORM and SQL migrations                 | Relational catalog, row-level security available, one datastore to back up.                                     |
| ADR-004 | Valkey 8 (BSD-licensed, Redis-compatible) + BullMQ for queues, cache, and rate limits | Durable job scheduling for scanners and alert fan-out. The license is clean.                                    |
| ADR-005 | Better Auth with a Drizzle adapter; Discord OAuth first, plus passkeys and TOTP       | The audience lives on Discord, so this is the lowest-friction sign-in. Built-in 2FA and rate limiting.          |
| ADR-006 | Fastify for the API, separate from Next.js                                            | Needed for a public, versioned pricing API with an OpenAPI spec and independent scaling.                        |
| ADR-007 | SOPS + age for encrypted secrets in git (prod and staging)                            | No external secret manager needed on a single VPS. Secrets are auditable and diffable.                          |
| ADR-008 | Caddy as the reverse proxy on the VPS                                                 | Automatic TLS, simple security headers, small attack surface.                                                   |
| ADR-009 | Tailscale for admin access; public SSH closed                                         | Removes the most-scanned port from the internet.                                                                |
| ADR-010 | cosign keyless signing + Syft SBOM + GitHub provenance attestations                   | Supply-chain integrity. The deploy verifies signatures before running anything.                                 |
| ADR-011 | Stripe Connect Express + Stripe Checkout + Stripe Tax for Phase 5                     | Avoids money-transmitter exposure, keeps us at PCI SAQ-A, and offloads KYC, 1099-K, and sales tax.              |

### 2.3 Current workstation state (verified 2026-09-20)

- Windows 11 Home 10.0.26200, 32 GB RAM, 16 logical CPUs, hardware virtualization **enabled**.
- **Installed:** VS Code.
- **Missing:** WSL2 distro, Docker, Node.js, pnpm, git, gh CLI. Phase 0 installs all of them.

### 2.4 Assumptions (verify during Phase 0 or 1)

- **A1.** A Hostinger KVM VPS plan with at least 2 vCPU, 8 GB RAM, and 100 GB NVMe will be bought when the deploy track starts. KVM 2 or higher is recommended.
- **A2.** Official Gundam Card Game card data can be obtained lawfully, as manual entry or from permitted sources. IP handling is reviewed before any images are rehosted (§23).
- **A3.** The retailers watched for restocks either allow automated access (robots/ToS) or offer feeds or APIs. Retailers that prohibit it are excluded.
- **A4.** It's a solo developer at first. Controls are sized so one person can operate them.

---

## 3. Scope by Phase

| Phase  | Delivers                                                               | Handles money?       | Handles user uploads? | Security tier                      |
| ------ | ---------------------------------------------------------------------- | -------------------- | --------------------- | ---------------------------------- |
| 0      | Workstation, monorepo, local stack, CI/CD, and security gates          | No                   | No                    | Foundation                         |
| 1      | Card catalog, restock scanner, Discord/web/email alerts, accounts      | No                   | No                    | ASVS L2                            |
| 2      | Break value calculator, pull logs, OBS overlay                         | No                   | No                    | ASVS L2                            |
| 3      | Price index, collection manager, CSV import/export, public pricing API | No                   | CSV only              | ASVS L2                            |
| 4      | Live-sale logger, verifiable break randomization, breaker profiles     | No                   | No                    | ASVS L2 + tamper evidence          |
| 5      | Listings, checkout, payouts, disputes, photo uploads                   | **Yes (via Stripe)** | **Photos**            | ASVS L2 + L3 for payments and auth |
| Deploy | Hardened VPS, TLS, backups, CD                                         | n/a                  | n/a                   | CIS-aligned host                   |

**Out of scope for this plan:** mobile native apps, a second game, card-scanning ML, a local-store co-op network, and escrow outside Stripe. Each gets its own plan later.

---

## 4. System Architecture

### 4.1 Component diagram

```
                         ┌───────────────────────────── Internet ─────────────────────────────┐
  Users / Viewers ──HTTPS──► Cloudflare (DNS, WAF, bot mgmt) ──► Caddy (TLS, headers) on VPS    │
  OBS Browser Source ──────►            │                               │                      │
  API consumers (API key) ─►            │                    ┌──────────┴───────────┐          │
  Discord users ◄──── Discord API ◄─────┼────────────┐       │                      │          │
                                        │            │   apps/web (Next.js)   apps/api (Fastify)
                                        │            │       │   SSR, UI, SSE        │  REST /v1, OpenAPI
                                        │            │       └──────────┬───────────┘
                                        │            │                  │ (internal network only)
                                        │     apps/discord-bot    ┌─────┴──────┐
                                        │            │            │ Postgres 17│  Valkey 8 (queues,
                                        │            └────────────┤  (RLS)     │  rate limits, cache)
                                        │                         └─────┬──────┘
                                        │            apps/worker (BullMQ consumers: alerts, ingestion,
                                        │            rollups, CSV import, image pipeline)
                                        │            apps/restock-scanner (schedulers + retailer adapters)
                                        │                         │ outbound only, domain allowlist
                                        └──── Retailer sites / official APIs (eBay APIs, Stripe, etc.)
```

### 4.2 Trust boundaries

| ID  | Boundary                                | Crossing                                         |
| --- | --------------------------------------- | ------------------------------------------------ |
| TB1 | Internet → Cloudflare/Caddy             | All user traffic                                 |
| TB2 | Caddy → web/api containers              | Authenticated and anonymous requests             |
| TB3 | App containers → Postgres/Valkey        | Internal network only, with per-service DB roles |
| TB4 | Scanner/worker → third-party sites/APIs | Outbound fetches of untrusted content            |
| TB5 | Platform ↔ Discord                      | OAuth, bot gateway, webhooks                     |
| TB6 | Platform ↔ Stripe (Phase 5)             | API calls, signed webhooks                       |
| TB7 | CI/CD → GHCR → VPS                      | Build, sign, and deploy path                     |
| TB8 | Admin → VPS                             | Tailscale SSH only                               |

### 4.3 Key data flows

1. **Restock detected.** The scanner job fetches the retailer page or API, parses it, and diffs it against `stock_snapshots`. It emits a `restock.detected` job, which the worker fans out to subscribed users over Discord DM, webhook, web push, and email. Delivery is recorded in `alert_deliveries`, which is idempotent.
2. **Pull logged during a break.** The creator logs a pull in the web UI. The API validates it, writes `break_pulls` (hash-chained in Phase 4), publishes an SSE event, and the OBS overlay updates.
3. **Price index.** Observations (live logs, user-reported sales, official APIs) go into `price_observations`. A nightly rollup (trimmed median by variant and condition) writes `price_index_daily`, which feeds the API and the UI.
4. **Purchase (Phase 5).** The buyer goes to Stripe Checkout (hosted). A signed webhook reaches the API, which runs it through the order state machine and records the transfer to the seller's connected account.

---

## 5. Technology Stack

Pin exact versions at scaffold time. The minimum majors are listed below. Dependabot keeps the pins current.

| Layer                    | Tech                                                                 | Min version | Notes                                                                                                      |
| ------------------------ | -------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| Runtime                  | Node.js                                                              | 24 LTS      | Installed via `fnm`. Pinned in `.node-version` and the `engines` field.                                    |
| Package manager          | pnpm                                                                 | 10.x        | Through corepack. `packageManager` field pinned.                                                           |
| Monorepo                 | Turborepo                                                            | 2.x         | Remote cache off; local cache only.                                                                        |
| Language                 | TypeScript                                                           | 5.9+        | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`                                         |
| Web                      | Next.js                                                              | 16.x        | App Router, React 19, Server Components, `output: 'standalone'`                                            |
| UI                       | Tailwind CSS 4 + shadcn/ui                                           | —           | No third-party CDN scripts                                                                                 |
| API                      | Fastify                                                              | 5.x         | `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cors`, `@fastify/swagger`, `fastify-type-provider-zod` |
| Validation               | zod                                                                  | 4.x         | A single source for schemas across web, api, and worker                                                    |
| ORM                      | Drizzle ORM + drizzle-kit                                            | latest      | SQL migrations checked into git                                                                            |
| DB                       | PostgreSQL                                                           | 17          | Extensions: `pg_trgm`, `citext`, `pgcrypto`                                                                |
| Queue/cache              | Valkey                                                               | 8           | BullMQ 5.x                                                                                                 |
| Auth                     | Better Auth                                                          | 1.x         | Drizzle adapter. Discord OAuth, magic link, passkey, and TOTP plugins                                      |
| Discord                  | discord.js                                                           | 14.x        | Slash commands, DMs                                                                                        |
| Scraping                 | undici + cheerio; Playwright only when unavoidable                   | —           | Runs only in scanner and worker containers                                                                 |
| Email                    | Nodemailer (Mailpit locally; SMTP provider in prod)                  | —           |                                                                                                            |
| Web push                 | `web-push` (VAPID)                                                   | —           |                                                                                                            |
| Logging                  | pino                                                                 | 9.x         | `redact` paths configured                                                                                  |
| Telemetry                | OpenTelemetry SDK for Node                                           | —           | OTLP to `grafana/otel-lgtm` (local) or a self-hosted LGTM (prod)                                           |
| Tests                    | Vitest, Testcontainers, Playwright, supertest/light-my-request       | —           |                                                                                                            |
| Images (Phase 5)         | sharp, ClamAV (clamd container)                                      | —           |                                                                                                            |
| Object storage (Phase 5) | S3-compatible: Cloudflare R2 (prod); local choice via ADR at Phase 5 | —           |                                                                                                            |
| Payments (Phase 5)       | Stripe Node SDK                                                      | latest      | Connect Express, Checkout, Tax                                                                             |
| Proxy                    | Caddy                                                                | 2.8+        |                                                                                                            |
| Host                     | Ubuntu Server                                                        | 24.04 LTS   | Hostinger KVM VPS                                                                                          |
| IaC                      | Ansible                                                              | 10.x        | Run from WSL                                                                                               |
| Secrets                  | SOPS + age                                                           | latest      |                                                                                                            |

---

## 6. Repository Structure

```
gundam-tcg-hub/
├─ apps/
│  ├─ web/                    # Next.js: public site, account, watches, collection, creator tools, overlays, admin
│  │  ├─ app/                 # routes (App Router)
│  │  ├─ middleware.ts        # CSP nonce, auth gate for /account, /admin, /creator
│  │  └─ next.config.ts       # security headers, standalone output
│  ├─ api/                    # Fastify: /v1 public + /internal routes
│  │  ├─ src/plugins/         # auth, rate-limit, helmet, cors, error handler, request-id
│  │  ├─ src/routes/v1/       # cards, prices, sets, products (public)
│  │  └─ src/routes/internal/ # watches, collections, breaks, listings (session auth)
│  ├─ worker/                 # BullMQ processors: alerts, ingestion, rollups, csv-import, images
│  ├─ restock-scanner/        # schedulers + per-retailer adapters (the rebuilt "gundam scanner")
│  │  ├─ src/adapters/<retailer>.ts
│  │  ├─ src/scheduler.ts
│  │  └─ src/fetch/safeFetch.ts   # allowlist, timeouts, size cap, UA, robots cache
│  └─ discord-bot/            # slash commands: /price, /watch, /unwatch, /break
├─ packages/
│  ├─ db/                     # drizzle schema, migrations/, seed/, rls.sql, roles.sql
│  ├─ core/                   # domain types, zod schemas, pricing math, state machines
│  ├─ auth/                   # Better Auth config, RBAC, authorize() policy helper
│  ├─ adapters/               # catalog, eBay official API, stream-log importers
│  ├─ observability/          # pino + OTel bootstrap, redaction lists
│  ├─ security/               # hashing (API keys/tokens), CSP builder, safeFetch, csv guards
│  └─ config/                 # tsconfig bases, eslint config, prettier config
├─ infra/
│  ├─ compose/
│  │  ├─ docker-compose.dev.yml
│  │  ├─ docker-compose.ci.yml
│  │  └─ docker-compose.prod.yml
│  ├─ docker/                 # Dockerfile.node (shared multi-stage), Dockerfile.web
│  ├─ mock-retailer/          # tiny server that flips stock states for tests
│  ├─ caddy/Caddyfile
│  ├─ vps/                    # ansible: inventory, playbooks, roles (base, ssh, firewall, docker, tailscale, crowdsec, backups, app)
│  └─ secrets/                # *.sops.yaml (encrypted), .sops.yaml rules
├─ .github/
│  ├─ workflows/              # ci.yml, nightly.yml, release.yml, scorecard.yml, codeql.yml
│  ├─ dependabot.yml
│  ├─ CODEOWNERS
│  └─ pull_request_template.md  # includes security checklist
├─ docs/
│  ├─ devsecops-build-plan.md # this document
│  ├─ threat-model.md
│  ├─ adr/ADR-001..md
│  ├─ runbooks/               # deploy, rollback, restore, incident, key-rotation
│  └─ asvs-checklist.md
├─ lefthook.yml
├─ .gitleaks.toml
├─ .semgrep.yml
├─ pnpm-workspace.yaml
├─ turbo.json
├─ .node-version
├─ .env.example
├─ SECURITY.md
└─ README.md
```

---

## 7. Data Model

All tables have `id` (UUIDv7), `created_at`, and `updated_at`. Money is stored as integer cents plus an ISO currency code. Timestamps are `timestamptz`, stored in UTC.

### Phase 1

| Table                                                                       | Key columns                                                                    | Notes                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `games`                                                                     | slug, name                                                                     | Seeded with `gundam`                                                 |
| `sets`                                                                      | game_id, code, name, release_date                                              |                                                                      |
| `cards`                                                                     | set_id, number, name, type, color, rarity, text                                | `pg_trgm` index on name                                              |
| `card_variants`                                                             | card_id, finish (normal/parallel/alt-art), language, image_ref                 | `image_ref` is a link, not a rehosted file (§23)                     |
| `sealed_products`                                                           | game_id, set_id, kind (booster box/deck/case), upc, msrp_cents                 |                                                                      |
| `retailers`                                                                 | name, domain, adapter_key, enabled, robots_ok, tos_reviewed_at, min_interval_s | `domain` is the scanner allowlist source                             |
| `retailer_products`                                                         | retailer_id, sealed_product_id, url, external_id                               | URLs must match `retailers.domain` (DB check + app check)            |
| `stock_snapshots`                                                           | retailer_product_id, in_stock, price_cents, raw_hash, checked_at               | Partitioned monthly                                                  |
| `watch_subscriptions`                                                       | user_id, sealed_product_id or retailer_product_id, channels[]                  | Unique per user and target                                           |
| `alert_deliveries`                                                          | subscription_id, event_id, channel, status, sent_at                            | Unique (event_id, subscription_id, channel), which gives idempotency |
| `users`, `accounts`, `sessions`, `verifications`, `passkeys`, `two_factors` | Better Auth managed                                                            | `role` enum: user, creator, seller, admin                            |
| `audit_log`                                                                 | actor_id, action, target_type, target_id, ip_hash, ua_hash, diff jsonb, at     | Append-only (UPDATE and DELETE revoked)                              |

### Phase 2

| Table         | Key columns                                                                            |
| ------------- | -------------------------------------------------------------------------------------- |
| `breaks`      | creator_id, title, sealed_product_id, status, started_at, ended_at, overlay_token_hash |
| `break_pulls` | break_id, card_variant_id, value_cents_at_pull, pulled_at, seq                         |

### Phase 3

| Table                | Key columns                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `collections`        | owner_id, name, visibility (private/unlisted/public)                                                                                       |
| `collection_items`   | collection_id, card_variant_id, qty, condition, acquired_price_cents, acquired_at                                                          |
| `price_observations` | card_variant_id, source (live/user_report/ebay_api/…), sale_type, condition, price_cents, currency, observed_at, evidence_ref, reporter_id | Partitioned monthly |
| `price_index_daily`  | card_variant_id, condition, day, median_cents, p25, p75, n_obs                                                                             |
| `api_keys`           | owner_id, prefix, key_hash, scopes[], rate_tier, last_used_at, revoked_at                                                                  |

### Phase 4

| Table                    | Key columns                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `live_sales`             | seller_id, stream_ref, card_variant_id, price_cents, sold_at              |
| `break_commitments`      | break_id, server_seed_hash, client_seed, revealed_seed, algorithm_version |
| `break_pulls` (extended) | prev_hash, row_hash (hash chain)                                          |

### Phase 5

| Table             | Key columns                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `seller_accounts` | user_id, stripe_account_id, charges_enabled, payouts_enabled, hold_until                                                      |
| `listings`        | seller_id, card_variant_id, condition, price_cents, qty, status, photo_required                                               |
| `listing_photos`  | listing_id, object_key, sha256, width, height, scanned_at, scan_result                                                        |
| `orders`          | buyer_id, seller_id, status (state machine), stripe_checkout_id, stripe_payment_intent_id, amount_cents, fee_cents, tax_cents |
| `order_events`    | order_id, from_status, to_status, actor, at                                                                                   |
| `disputes`        | order_id, reason, status, evidence jsonb                                                                                      |
| `webhook_events`  | provider, event_id (unique), received_at, processed_at                                                                        | Webhook idempotency |

### DB roles (least privilege)

| Role           | Rights                                                     |
| -------------- | ---------------------------------------------------------- |
| `app_migrator` | DDL. Used only by the migration job.                       |
| `app_web`      | DML on app tables. Cannot touch `audit_log` except INSERT. |
| `app_worker`   | DML on job-related tables.                                 |
| `app_readonly` | Read-only access for the API's public routes.              |

No role is a superuser. RLS is enabled on `collections`, `collection_items`, `watch_subscriptions`, `listings`, and `orders`, keyed on `current_setting('app.user_id')`.

---

## 8. Environments

| Env         | Where                              | Data                                | Secrets                                     | Deploy trigger                                         |
| ----------- | ---------------------------------- | ----------------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| **local**   | WSL2 + Docker Desktop              | Seed data only                      | `.env.local` (gitignored)                   | `pnpm dev`                                             |
| **ci**      | GitHub-hosted runners              | Ephemeral Testcontainers or compose | GitHub Actions secrets (minimal, test-only) | Every PR                                               |
| **staging** | VPS, compose project `gth-staging` | Synthetic plus anonymized seed      | `infra/secrets/staging.sops.yaml`           | Merge to `main` (automatic)                            |
| **prod**    | VPS, compose project `gth-prod`    | Real                                | `infra/secrets/prod.sops.yaml`              | Manual approval in the GitHub `production` environment |

**Rules**

- Prod data never goes to local, CI, or staging.
- Staging and prod use separate DBs, DB users, Valkey DBs or instances, Discord apps, and Stripe modes (test vs live).

---

## 9. Phase 0: Workstation, Repo, and DevSecOps Foundation

**Objective:** a secure, reproducible developer environment and a repo where insecure changes cannot merge.

### 9.1 Workstation setup (user runs the admin steps; Claude verifies each)

1. **WSL2 and Ubuntu.** In an _admin_ PowerShell, run `wsl --install -d Ubuntu-24.04`, reboot, then create a Linux user.
2. **Docker Desktop.** Install it, enable the WSL2 backend and Ubuntu integration, and turn off "Expose daemon on tcp without TLS".
3. **Inside Ubuntu (WSL):**
   ```bash
   sudo apt update && sudo apt -y upgrade
   sudo apt -y install git curl unzip build-essential ca-certificates gnupg
   curl -fsSL https://fnm.vercel.app/install | bash   # then restart shell
   fnm install 24 && fnm default 24
   corepack enable && corepack prepare pnpm@latest-10 --activate
   # GitHub CLI (official apt repo), gitleaks, age, sops, lefthook, hadolint, trivy, osv-scanner, semgrep (pipx)
   ```
4. **VS Code.** Install the "WSL" extension. Open the repo with `code ~/code/gundam-tcg-hub` from Ubuntu. Recommended extensions go in `.vscode/extensions.json`: ESLint, Prettier, Docker, GitHub Actions, and Tailwind.
5. **Git identity and signing:**
   ```bash
   ssh-keygen -t ed25519 -C "300233470+trstncyphr007@users.noreply.github.com"      # auth + signing key
   gh auth login                                        # HTTPS or SSH
   git config --global user.name "TRSTN"; git config --global user.email "<GitHub noreply email>"
   git config --global gpg.format ssh; git config --global user.signingkey ~/.ssh/id_ed25519.pub
   git config --global commit.gpgsign true; git config --global tag.gpgsign true
   ```
   Add the key to GitHub as both an **Authentication** key and a **Signing** key. Use the GitHub noreply email in commits so your personal email doesn't appear in public history.
6. **GitHub account hardening.** 2FA with a passkey plus a TOTP backup. Store the recovery codes offline.
7. **Age key for SOPS.** Run `age-keygen -o ~/.config/sops/age/keys.txt`. Back the private key up offline, in a password manager. **Never commit it.**

**AC-0.1:** `node -v` shows 24.x, `pnpm -v` shows 10.x, `docker run --rm hello-world` succeeds, `git log --show-signature` shows a valid signature, and `gh auth status` is OK.

### 9.2 Repository setup

| #      | Requirement                                                                                                                                                                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-0.1 | Private repo `gundam-tcg-hub` created with `gh repo create --private`. Default branch `main`.                                                                                                                                                                                                                                                       |
| FR-0.2 | Monorepo scaffolded per §6. `pnpm -r build` succeeds on empty apps.                                                                                                                                                                                                                                                                                 |
| FR-0.3 | `README.md` covers the quickstart (≤5 commands to a running local stack).                                                                                                                                                                                                                                                                           |
| FR-0.4 | `docs/adr/` has ADR-001..011 from §2.2.                                                                                                                                                                                                                                                                                                             |
| SR-0.1 | **Ruleset on `main`:** require PR, 1 approval (self-approval not possible solo, so use "require status checks" plus a CODEOWNERS review via a second account, or rely on status checks only for solo work; decide in ADR-012), required status checks (all CI jobs in §18), required signed commits, linear history, block force-push and deletion. |
| SR-0.2 | **Repo security settings:** secret scanning **and push protection** on, Dependabot alerts and security updates on, CodeQL default setup on, private vulnerability reporting on.                                                                                                                                                                     |
| SR-0.3 | **Actions settings:** "Allow select actions" limited to GitHub-owned and verified creators plus an explicit allowlist. Workflow permissions default to **read**. "Allow GitHub Actions to create and approve pull requests" off.                                                                                                                    |
| SR-0.4 | **Environments:** `staging` (no approval) and `production` (required reviewer = owner, 5-minute wait timer, deploy only from `main`).                                                                                                                                                                                                               |
| SR-0.5 | `SECURITY.md` says how to report vulnerabilities (GitHub private reporting), which versions are supported, and response SLAs (acknowledge within 72h).                                                                                                                                                                                              |
| SR-0.6 | `CODEOWNERS` requires owner review on `/infra/`, `/.github/`, `/packages/auth/`, `/packages/security/`, and `/packages/db/migrations/`.                                                                                                                                                                                                             |

### 9.3 Local guardrails (`lefthook.yml`)

```yaml
pre-commit:
  parallel: true
  commands:
    gitleaks:
      run: gitleaks git --pre-commit --staged --redact --no-banner
    lint:
      glob: '*.{ts,tsx,js,mjs}'
      run: pnpm eslint --max-warnings=0 {staged_files}
    format:
      glob: '*.{ts,tsx,js,json,md,yml,yaml}'
      run: pnpm prettier --check {staged_files}
    typecheck:
      run: pnpm turbo run typecheck --filter=...[HEAD]
commit-msg:
  commands:
    commitlint:
      run: pnpm commitlint --edit {1}
pre-push:
  commands:
    test:
      run: pnpm turbo run test --filter=...[origin/main]
```

- **SR-0.7.** ESLint config includes `@typescript-eslint/strict-type-checked`, `eslint-plugin-security`, `eslint-plugin-no-secrets`, and `no-restricted-syntax` rules that ban `eval`, `new Function`, `child_process` outside allowlisted files, and `dangerouslySetInnerHTML`.

### 9.4 Supply-chain hygiene

`pnpm-workspace.yaml`:

```yaml
packages: ['apps/*', 'packages/*']
onlyBuiltDependencies: # only these may run install scripts
  - esbuild
  - sharp
  - '@prisma/engines' # example; keep list minimal and reviewed
minimumReleaseAge: 10080 # minutes (7 days): don't install versions younger than this
```

`.npmrc`:

```
engine-strict=true
save-exact=true
strict-peer-dependencies=true
```

| #       | Requirement                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------- |
| SR-0.8  | Commit `pnpm-lock.yaml`. CI installs with `--frozen-lockfile`.                                                         |
| SR-0.9  | New dependencies need a PR note: purpose, maintainer health (last release, downloads), license, install scripts (y/n). |
| SR-0.10 | Pin GitHub Actions by full commit SHA with a version comment. Dependabot updates them.                                 |
| SR-0.11 | Pin base images by digest (`node:24-bookworm-slim@sha256:…`). Dependabot `docker` ecosystem updates them.              |

`.github/dependabot.yml`: ecosystems `npm` (weekly, grouped minor and patch, separate major PRs), `github-actions` (weekly), `docker` (weekly, per Dockerfile directory).

### 9.5 Local development stack (`infra/compose/docker-compose.dev.yml`)

```yaml
name: gth-dev
services:
  postgres:
    image: postgres:17-bookworm # pin digest at scaffold
    environment:
      POSTGRES_USER: ${PG_SUPERUSER}
      POSTGRES_PASSWORD: ${PG_SUPERPASSWORD}
      POSTGRES_DB: gth
    ports: ['127.0.0.1:5432:5432'] # bind to loopback only
    volumes:
      ['pgdata:/var/lib/postgresql/data', '../../packages/db/init:/docker-entrypoint-initdb.d:ro']
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U $$POSTGRES_USER'], interval: 5s, retries: 10 }
  valkey:
    image: valkey/valkey:8-bookworm
    command: ['valkey-server', '--requirepass', '${VALKEY_PASSWORD}', '--appendonly', 'yes']
    ports: ['127.0.0.1:6379:6379']
    volumes: ['valkeydata:/data']
    healthcheck: { test: ['CMD', 'valkey-cli', '-a', '${VALKEY_PASSWORD}', 'ping'], interval: 5s }
  mailpit:
    image: axllent/mailpit
    ports: ['127.0.0.1:8025:8025', '127.0.0.1:1025:1025']
  otel:
    image: grafana/otel-lgtm
    ports: ['127.0.0.1:3001:3000', '127.0.0.1:4317:4317', '127.0.0.1:4318:4318']
  mock-retailer:
    build: ../mock-retailer
    ports: ['127.0.0.1:4010:4010']
volumes: { pgdata: {}, valkeydata: {} }
```

| #       | Requirement                                                                                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-0.1 | Every dev port binds to `127.0.0.1` only. Nothing is exposed on the LAN.                                                                                                                                                                            |
| FR-0.5  | `packages/db/init/01-roles.sql` creates the `app_migrator`, `app_web`, `app_worker`, and `app_readonly` roles, with passwords taken from env at init.                                                                                               |
| FR-0.6  | Root scripts: `pnpm dev` (turbo, all apps), `pnpm stack:up` / `stack:down`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:reset`, `pnpm test`, `pnpm e2e`, `pnpm lint`, `pnpm typecheck`, `pnpm sec:scan` (gitleaks + osv-scanner + semgrep locally). |
| FR-0.7  | Env is validated with zod in `packages/core/env.ts`. The app refuses to boot if any variable is missing or malformed. `.env.example` lists every variable (Appendix A) with safe placeholder values.                                                |

### 9.6 Secrets management

| #       | Requirement                                                                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-0.12 | Local: `.env.local` (gitignored and covered by the gitleaks rule). Never share it over chat or email.                                                                                                                      |
| SR-0.13 | Staging and prod: `infra/secrets/{staging,prod}.sops.yaml`, encrypted to the owner's age public key **and** the VPS age key. `.sops.yaml` enforces `encrypted_regex: ^(data                                                | stringData | .*(_KEY | _SECRET | _TOKEN | _PASSWORD | _URL))$`. |
| SR-0.14 | CI holds only the secrets it needs: for example `DEPLOY_TS_AUTHKEY` (Tailscale ephemeral, tagged), stored as **environment** secrets, not repo-wide. There are no long-lived cloud keys, and OIDC is used where supported. |
| SR-0.15 | Rotation schedule: bot token, OAuth secrets, and webhook URLs every 180 days or immediately on suspected exposure. The runbook is `docs/runbooks/key-rotation.md`.                                                         |
| SR-0.16 | Generated secrets use at least 32 bytes of CSPRNG output (`openssl rand -base64 32`).                                                                                                                                      |

### 9.7 Phase 0 Definition of Done

- [ ] AC-0.1 passes.
- [ ] Repo, ruleset, security settings, and environments configured (SR-0.1 to SR-0.6).
- [ ] Lefthook blocks a staged fake secret, for example `AKIA` + 16 characters.
- [ ] `pnpm stack:up && pnpm db:migrate && pnpm db:seed && pnpm dev` works from a fresh clone.
- [ ] `ci.yml` runs green on a trivial PR with every §18 gate present, even on placeholder apps.
- [ ] `docs/threat-model.md` v0 committed (§17).

---

## 10. Phase 1: Card Catalog and Restock Alerts

**Objective:** replace and improve the old scanner, deliver reliable Gundam TCG restock alerts to Discord, web, and email, and launch accounts.

### 10.1 Functional requirements

| #       | Requirement                                                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1.1  | **Catalog.** Admins can create and update games, sets, cards, variants, and sealed products through `/admin/catalog`. Every change writes `audit_log`.                                                                                                                                            |
| FR-1.2  | **Catalog import.** A CLI command (`pnpm catalog:import <file.csv                                                                                                                                                                                                                                 | json>`) validates rows with zod, dry-runs by default, and prints a diff. `--apply` commits the changes in one transaction. |
| FR-1.3  | **Public catalog.** Browse sets and search cards (trigram search, under 200 ms p95 on 10k cards), with card detail pages.                                                                                                                                                                         |
| FR-1.4  | **Retailers.** Admins register a retailer with its domain, adapter key, minimum interval, and a ToS/robots review date. `enabled` stays false until `tos_reviewed_at` is set.                                                                                                                     |
| FR-1.5  | **Scanner adapters.** Each adapter implements `check(rp: RetailerProduct): Promise<StockResult>` returning `{inStock, priceCents?, raw, confidence}`. The first release includes **1–3 retailers** plus the `mock` adapter.                                                                       |
| FR-1.6  | **Scheduling.** A BullMQ repeatable job per `retailer_product`. The interval is at least `retailers.min_interval_s` with ±20% jitter. Only one job per domain runs at a time (a per-domain limiter). Backoff is exponential. A circuit breaker opens after 5 consecutive failures for 30 minutes. |
| FR-1.7  | **Change detection.** An event fires only on the transition out-of-stock → in-stock (and optionally a price drop). There is a debounce: in-stock must be confirmed on 2 consecutive checks, or once if `confidence = high`.                                                                       |
| FR-1.8  | **Alert fan-out.** Channels are Discord bot DM, a Discord channel webhook (the creator's server), web push, and email. Delivery is idempotent through a unique constraint on `alert_deliveries`. Retries are capped at 5.                                                                         |
| FR-1.9  | **Watches.** Signed-in users can add and remove watches on the web (`/account/watches`) and through the `/watch <product>` and `/unwatch` bot commands. A user may have at most 50 watches.                                                                                                       |
| FR-1.10 | **Accounts.** Sign in with Discord OAuth (scope `identify`, plus `email` only if email alerts are enabled). Email magic link as a fallback. Passkey enrollment is optional for users and **required for admins**, along with TOTP backup.                                                         |
| FR-1.11 | **Discord bot.** Slash commands only (no message-content intent). DMs are sent only to users who have linked their account and opted in.                                                                                                                                                          |
| FR-1.12 | **Admin dashboard.** Scanner health (last success per product, failure rate, open circuit breakers), queue depth, and alert delivery stats.                                                                                                                                                       |

### 10.2 Security requirements

| #       | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-1.1  | **SSRF / egress:**<br>• All scanner HTTP goes through `packages/security/safeFetch`.<br>• The URL's host must exactly match (or be a subdomain of) an enabled `retailers.domain`.<br>• Resolved IPs must not be private, loopback, or link-local (checked after DNS resolution, to guard against DNS rebinding).<br>• Redirects are re-validated, with at most 3.<br>• Only `https:` is allowed, except the mock adapter in dev and CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SR-1.2  | **Resource limits:** connect timeout 5 s, total 15 s, response body capped at 2 MB, `Content-Type` allowlist (html, json).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SR-1.3  | **Parsing untrusted HTML:** cheerio only (no JS execution). If Playwright is required, it runs in a separate container with no DB credentials, as a non-root user with a seccomp profile, and sends results back through the queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SR-1.4  | **Compliance:** robots.txt is fetched and cached for 24h, and disallowed paths are skipped. The User-Agent is `GundamTCGHubBot/<ver> (+<contact URL>)`. Per-domain rate limits are enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SR-1.5  | Discord webhook URLs and bot tokens live only in secrets or encrypted DB fields, never in logs. pino redacts them with the paths `*.webhookUrl`, `*.token`, `*.authorization`, and `*.cookie`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SR-1.6  | Encrypted DB fields (for example user-provided Discord webhook URLs for creator servers) use AES-256-GCM through `packages/security/crypto`, keyed from `DATA_ENCRYPTION_KEY` with key-id versioning so keys can be rotated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SR-1.7  | **Sessions:**<br>• Cookie is `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Lax`, with a 7-day rolling / 30-day absolute lifetime.<br>• The session ID is rotated on login and privilege change.<br>• Logout revokes the session server-side.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SR-1.8  | **CSRF:** SameSite=Lax plus an Origin/`Sec-Fetch-Site` check on every state-changing request. Better Auth's CSRF protection is enabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SR-1.9  | **Rate limits**, in process memory — not Valkey, which is gone (ADR-042), so each limit is per instance and resets on deploy. Rewritten 2026-09-25 against the enforcing code, having claimed two limits that did not exist:<br>• Auth, per IP: 60 a minute across the auth surface, and lower where it matters — requesting a sign-in link 5, verifying one 10, Discord 10, a passkey assertion 10, a passkey registration 5.<br>• **Requesting a sign-in link: 5 a minute per address**, so rotating source addresses cannot make us post unlimited email into one stranger's inbox. Missing until #83.<br>• **Watch mutations: 30 a minute per user.** Missing until #83; the routes declared nothing and inherited 120 a minute per IP.<br>• Public catalog: 120 a minute per IP, the default of `API_RATE_LIMIT_MAX`.<br>• A request carrying a valid API key is exempt from the per-IP limiter and answers to its own quota instead: 60 a minute and 1,000 a day (`FREE_TIER_LIMITS`), the daily half durable in Postgres. |
| SR-1.10 | **AuthZ:** watches are readable and writable only by their owner, enforced both in `authorize()` and by RLS. Admin routes require `role=admin` **and** a session authenticated within the last 12h with a passkey or TOTP (step-up).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SR-1.11 | **Bot:** gateway intents `Guilds` only. The bot's permissions in any creator server are the minimum needed (Send Messages, Embed Links). The bot token is rotated per SR-0.15.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SR-1.12 | Web push VAPID keys and email SMTP credentials are kept in secrets. Emails include a `List-Unsubscribe` header, and unsubscribe links carry a signed token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 10.3 Tests and acceptance

**AC-1.1: mock retailer end to end**

- The mock flips from OOS to IS.
- Exactly one Discord webhook message (to a test webhook or captured mock) and one email (Mailpit) are sent within 2 intervals.
- `stock_snapshots` shows the transition.
- Re-running the job causes no duplicate alerts.

**AC-1.2: SSRF protection.** Unit tests show that `safeFetch` rejects:

- `http://169.254.169.254`
- `http://localhost`
- a DNS name resolving to `10.0.0.1`
- a redirect to a non-allowlisted host
- a non-https URL
- a 5 MB body

**AC-1.3: authorization.** User A cannot list, modify, or delete user B's watches through the API. This is tested at the API layer and with RLS directly via SQL.

**AC-1.4: account security.** An admin route without step-up returns 403 and prompts for re-authentication. Rate limits return 429 with a `Retry-After` header.

**AC-1.5: scanner resilience.** Five failures open the circuit breaker, the dashboard shows it, and it auto-closes after the cooldown.

**AC-1.6:** ZAP baseline against local staging shows no High alerts. Semgrep and CodeQL report no new High findings.

---

## 11. Phase 2: Creator Tooling

**Objective:** tools the creator uses live on stream. This is the first user and the distribution engine.

### 11.1 Functional requirements

| #      | Requirement                                                                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-2.1 | **Break value calculator.** Choose a product and add pulls by searching cards. It shows each card's value (from the current price index; manual values until Phase 3) and the running total against the product's cost. The result is a shareable public URL, a read-only snapshot. |
| FR-2.2 | **Pull logs.** A `creator` role user starts a break, logs pulls (keyboard-first UI, under 3 s per pull), then ends the break. The public break page shows the pulls in order.                                                                                                       |
| FR-2.3 | **OBS overlay.** `/overlay/{token}` is a transparent-background page updated over SSE. Themes include last pull, running total, and top hits. The token is shown once and can be regenerated.                                                                                       |
| FR-2.4 | **Stream-safe mode.** The overlay never shows usernames, emails, or anything else not explicitly entered for display.                                                                                                                                                               |
| FR-2.5 | **Export.** Pull logs export as CSV and JSON.                                                                                                                                                                                                                                       |

### 11.2 Security requirements

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-2.1 | Overlay tokens are 32 random bytes, base64url-encoded, and stored as `sha256(pepper ‖ token)`. They are scoped to one break (or one creator) with read-only access, and can be revoked or rotated. Lookups are constant-time.                                                                                                                                                                                                                                                             |
| SR-2.2 | The overlay route sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and is `noindex`. The token never appears in logs: request-log redaction masks the path segment.                                                                                                                                                                                                                                                                                                     |
| SR-2.3 | XSS: all user text is rendered through React escaping. `dangerouslySetInnerHTML` is banned by lint. **Nonce-based CSP:** `default-src 'self'; script-src 'self' 'nonce-{n}' 'strict-dynamic'; style-src 'self' 'nonce-{n}'; img-src 'self' data: <approved image hosts>; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`. The overlay route relaxes only `frame-ancestors` if needed (OBS doesn't frame, so it usually stays `none`). |
| SR-2.4 | SSE endpoints: per-token connection limit of 5, a heartbeat, and a server-side idle timeout. Only non-sensitive events are sent.                                                                                                                                                                                                                                                                                                                                                          |
| SR-2.5 | CSV export: formula-injection guard. Cells starting with `= + - @ \t \r` are prefixed with `'`.                                                                                                                                                                                                                                                                                                                                                                                           |
| SR-2.6 | Creator role grants are admin-only and audited.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 11.3 Acceptance

- **AC-2.1.** A pull logged in the UI appears on the overlay in under 1 s locally.
- **AC-2.2.** A revoked token returns 404 immediately. An old token is never accepted after rotation.
- **AC-2.3.** An XSS payload (`<img src=x onerror=alert(1)>`) entered as a break title renders inert on the web page and the overlay. The CSP header is present and verified in a Playwright test.
- **AC-2.4.** Exported CSV opened in a spreadsheet shows no formula execution for a payload cell.

---

## 12. Phase 3: Price Tracker, Collection Manager, Open Pricing API

**Objective:** an independent, multi-source price index and collection tool, plus a developer-friendly API. This attacks the pricing-benchmark moat.

### 12.1 Functional requirements

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-3.1 | **Observation ingestion.** Sources, in order of preference:<br>• our own break and live logs (Phase 4 feeds in later)<br>• user-reported sales with evidence (screenshot link or order reference, moderated)<br>• **official** third-party APIs where access is granted (for example eBay Browse or Marketplace Insights, subject to eBay approval)<br>Every observation stores its source, sale type, condition, currency, and timestamp. |
| FR-3.2 | **Index computation.** A nightly rollup per variant and condition computes a trimmed median (drop the top and bottom 10%), p25/p75, and n. A minimum of 3 observations is needed to publish; otherwise the price shows as "insufficient data". Methodology is documented publicly at `/methodology`.                                                                                                                                       |
| FR-3.3 | **Price history.** Charts at 7d, 30d, 90d, and all-time, showing source mix.                                                                                                                                                                                                                                                                                                                                                               |
| FR-3.4 | **Collections.** Users can have multiple collections. Add cards by search with quantity, condition, and cost basis. Shows current value, gain or loss, and a value-over-time chart. Visibility is private (default), unlisted, or public.                                                                                                                                                                                                  |
| FR-3.5 | **CSV import/export.** Import with column mapping and preview. Dry run first. At most 5,000 rows and 2 MB per file. Parsing runs in a worker.                                                                                                                                                                                                                                                                                              |
| FR-3.6 | **Public API v1:**<br>• `GET /v1/sets`, `/v1/cards?q=`, `/v1/cards/{id}`, `/v1/cards/{id}/prices`, `/v1/products`<br>• OpenAPI 3.1 docs at `/docs`<br>• ETag with `Cache-Control: public, max-age=300`<br>• cursor pagination                                                                                                                                                                                                              |
| FR-3.7 | **API keys.** Self-serve in `/account/developer`: create (shown once), name, scopes (`read:catalog`, `read:prices`), and revoke. Tiers: free at 1,000 requests per day and 60 per minute.                                                                                                                                                                                                                                                  |
| FR-3.8 | **"List for sale" hook.** A button stub on collection items that feeds Phase 5. It is hidden behind a feature flag.                                                                                                                                                                                                                                                                                                                        |

### 12.2 Security requirements

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-3.1 | **API keys:**<br>• Format `gth_live_<prefix8>_<secret32>`.<br>• Stored as `prefix` plus `sha256(pepper ‖ secret)`. Lookup by prefix with a constant-time compare.<br>• The key is never logged. `last_used_at` is updated asynchronously.<br>• The prefix is registered with GitHub secret scanning via the partner program, if eligible, or at minimum added to a custom gitleaks rule. |
| SR-3.2 | **Quotas:** Valkey sliding window per key and per IP. Exceeding it returns 429 with `RateLimit-*` headers. Abusive keys are auto-suspended after sustained 429s, and the owner is notified.                                                                                                                                                                                              |
| SR-3.3 | **IDOR:** every collection route goes through `authorize(user,'collection:read'                                                                                                                                                                                                                                                                                                          | 'collection:write', collection)`. RLS enforces `owner_id = current_setting('app.user_id')::uuid` for private rows. The test suite covers every route with two users. |
| SR-3.4 | **CSV import:**<br>• Parsed in the worker with a streaming parser.<br>• Row and size caps enforced.<br>• zod validation per row.<br>• No formulas are evaluated.<br>• Errors reported per row.                                                                                                                                                                                           |
| SR-3.5 | **User-reported prices:**<br>• Moderation queue; excluded from the index until approved.<br>• Per-user rate limit.<br>• Outlier auto-flagging.<br>• Reporter reputation weighting.<br>This guards against index manipulation.                                                                                                                                                            |
| SR-3.6 | **Third-party API credentials:** OAuth client credentials are kept in secrets. Tokens are cached in memory only. The provider's API license terms, including display and attribution requirements, are respected and recorded in `docs/data-sources.md`.                                                                                                                                 |
| SR-3.7 | **Public API CORS:** `GET` only, any origin, no credentials. Session-authenticated internal routes use CORS restricted to the app's origin.                                                                                                                                                                                                                                              |
| SR-3.8 | **Privacy:** public collections show only a display name the user chose, never their email or Discord ID.                                                                                                                                                                                                                                                                                |

### 12.3 Acceptance

- **AC-3.1.** Index math unit tests cover trimming, the minimum-n threshold, and currency handling.
- **AC-3.2.** A two-user IDOR matrix passes for every collection and watch route.
- **AC-3.3.** An API key revoked in the UI is rejected within 5 s. A key leaked into a test commit is caught by gitleaks.
- **AC-3.4.** ZAP API scan against the OpenAPI spec shows no High findings. Schemathesis (or ZAP) fuzzing of `/v1` produces no 5xx responses.
- **AC-3.5.** CSV import rejects a 5,001-row file and neutralizes a formula-injection cell.

---

## 13. Phase 4: Live-Sale Price Capture and Break Transparency

**Objective:** the long-term data asset. It captures prices from the channel nobody records (live sales) and makes breaks verifiably fair.

### 13.1 Functional requirements

| #      | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-4.1 | **Live-sale logger.** Sellers log each sale during a stream (card, price, buyer handle optional and not public) in under 3 s per entry. Entries feed `price_observations` with `source=live` and are weighted in the index.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| FR-4.2 | **Verifiable randomization (commit-reveal).** For randomized breaks (team or slot assignment):<br>1. Before the break, the server generates a `server_seed` and publishes `sha256(server_seed)`.<br>2. Viewers or the creator contribute a `client_seed` (for example a public value such as a future block hash, or the creator's typed seed shown on stream).<br>3. The assignment is `HMAC-SHA256(server_seed, client_seed ‖ break_id)` driving a Fisher–Yates shuffle, documented as algorithm version `v1`.<br>4. After the break, `server_seed` is revealed. The public page lets anyone re-run the verification in the browser with open-source JS. |
| FR-4.3 | **Breaker profiles.** Public pages show the number of breaks, pull logs, and hit rates by rarity against published pack odds (where known), with a "verified randomization" badge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| FR-4.4 | **Evidence.** Optional VOD timestamp links per pull.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 13.2 Security requirements

| #      | Requirement                                                                                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SR-4.1 | **Tamper evidence.** `break_pulls` is append-only: the DB role has no UPDATE or DELETE, and corrections are new rows of type `correction`. Each row stores `row_hash = sha256(prev_hash ‖ canonical_json(row))`. The chain head is published on the break page at close. |
| SR-4.2 | The server seed is generated with a CSPRNG (32 bytes) and never exposed before reveal. It is encrypted at rest (SR-1.6) until reveal.                                                                                                                                    |
| SR-4.3 | The randomization code is deterministic, versioned, and covered by known-answer tests. The verifier JS is served from our origin under the same CSP, and its source is published in the repo.                                                                            |
| SR-4.4 | Anti-manipulation: flag live-sale entries with prices far from the index (over 3× the IQR) for review before they are weighted. Per-seller entry rate limits apply.                                                                                                      |
| SR-4.5 | A buyer handle entered in the live-sale logger is treated as PII: it is hashed or omitted from public views and deleted after 90 days.                                                                                                                                   |

### 13.3 Acceptance

- **AC-4.1.** Known-answer tests: fixed seeds produce the published assignment. The browser verifier matches the server result.
- **AC-4.2.** Altering any `break_pulls` row directly in the DB (as superuser in a test) breaks chain verification, and the public page shows "chain invalid".
- **AC-4.3.** The app DB role cannot UPDATE or DELETE `break_pulls` (a permission test).

---

## 14. Phase 5: Marketplace (Stripe Connect)

**Objective:** buy and sell singles with trust features: real photos, standardized condition, and fair fees. **Security posture steps up significantly here.**

### 14.1 Functional requirements

| #      | Requirement                                                                                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-5.1 | **Seller onboarding.** Stripe Connect **Express** account links. The user can list only when `charges_enabled` and `payouts_enabled` are both true. Stripe handles KYC, payouts, and 1099-K.                                                              |
| FR-5.2 | **Listings.** Created from a collection item or from scratch: card variant, condition (with the photo grading guide), price, and quantity. **Real photos (front and back) are required above a configurable value**, default $25.                         |
| FR-5.3 | **Checkout.** Stripe **Checkout** (hosted) handles payment. Card data never touches our servers. Stripe Tax calculates and collects marketplace-facilitator sales tax. Platform fee via `application_fee_amount`. Early-seller fee waivers are supported. |
| FR-5.4 | **Order state machine.** `created → paid → shipped (tracking required above $X) → delivered → completed`, with branches `cancelled`, `refunded`, and `disputed`. Every transition is logged in `order_events`.                                            |
| FR-5.5 | **Disputes.** Buyers can open a dispute within N days of delivery. Evidence upload. Admin resolution tools. Chargeback webhooks are handled.                                                                                                              |
| FR-5.6 | **Payout holds.** New sellers are held for 7 days after delivery for their first N orders (configurable).                                                                                                                                                 |
| FR-5.7 | **Seller reputation.** Ratings from completed orders only.<br>_Later: portable reputation linking._                                                                                                                                                       |

### 14.2 Security requirements

| #       | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-5.1  | **PCI:** Stripe Checkout or Elements only, which keeps us at SAQ-A. No card data in logs or DB. Complete the SAQ-A annually.                                                                                                                                                                                                                                                                                                                 |
| SR-5.2  | **Webhooks:**<br>• Verify the `Stripe-Signature` header using the raw body and the endpoint secret, with a 5-minute tolerance.<br>• Idempotency via the unique `webhook_events.event_id`.<br>• Process asynchronously in the worker.<br>• Return 2xx only after the event is persisted.                                                                                                                                                      |
| SR-5.3  | **Outbound Stripe calls:** every mutating call carries an idempotency key. Restricted API keys (RAK) with minimum permissions for each service: web can create Checkout sessions; worker can read and refund.                                                                                                                                                                                                                                |
| SR-5.4  | **Step-up authentication:** a passkey or TOTP is required within the last 10 minutes for payout settings changes, bank account changes (a Stripe-hosted flow), listing price changes over 50%, and bulk actions.                                                                                                                                                                                                                             |
| SR-5.5  | **Photo uploads:**<br>• Presigned PUT to a private bucket with content-length and type conditions, at most 10 MB.<br>• The worker validates magic bytes (JPEG, PNG, or WebP only), re-encodes with `sharp` (which strips EXIF and GPS), caps dimensions, computes sha256, scans with ClamAV, then marks the photo approved.<br>• Photos are served only through short-lived signed URLs or a CDN over processed copies, never the originals. |
| SR-5.6  | **Fraud rules:**<br>• velocity limits (listings, purchases, and messages per hour)<br>• new-account purchase caps<br>• mismatched-geo flags<br>• duplicate-photo detection (sha256 or perceptual hash) to catch stolen photos<br>• Stripe Radar rules turned on                                                                                                                                                                              |
| SR-5.7  | **Order state machine:** transitions are enforced in `packages/core`. Illegal transitions throw an error and write to the audit log. Money-affecting transitions happen only from verified webhooks, never from client input.                                                                                                                                                                                                                |
| SR-5.8  | **Messaging (if added):** rate-limited, links neutralized, no personal contact info shared before purchase (anti-scam), and an abuse reporting path.                                                                                                                                                                                                                                                                                         |
| SR-5.9  | **Admin actions** (refunds, holds, bans) require step-up auth, record a reason, and write to `audit_log`. Admins with money powers must use passkeys.                                                                                                                                                                                                                                                                                        |
| SR-5.10 | **Security review before launch:**<br>• updated threat model<br>• ASVS L2 checklist complete, plus L3 items for authentication, session management, and business logic<br>• an external pentest or, at minimum, a structured self-pentest (OWASP WSTG) with fixes<br>• a bug bounty or `security.txt` contact live                                                                                                                           |

### 14.3 Acceptance

- **AC-5.1.** Stripe test mode end to end: onboard a seller, list an item, buy it through Checkout, receive the webhook, record the order as paid, ship with tracking, complete the order, and the payout is created.
- **AC-5.2.** A replayed webhook (same event ID) is a no-op. A forged signature returns 400.
- **AC-5.3.** Uploading a polyglot file (a JPEG header with a script payload) or the EICAR test file is rejected. EXIF GPS is absent from served images.
- **AC-5.4.** A buyer cannot mark their own order `completed` or change its price through the API (business-logic tests).
- **AC-5.5.** The pentest or WSTG report has no open High or Critical findings.

---

## 15. Deploy Track: Hostinger KVM VPS

Start once Phase 1 works locally. Until a domain is bought, staging can be reached through Tailscale only.

### 15.1 VPS provisioning (Hostinger panel)

1. Choose a KVM plan (≥2 vCPU, ≥8 GB RAM, ≥100 GB NVMe) and a US region near users.
2. OS: **Ubuntu 24.04 LTS** (clean image, no control panel).
3. Add your SSH public key during setup. Record the root password in the password manager, then disable password login (below).
4. Turn on Hostinger's snapshot and backup feature as an extra layer on top of restic (§21).
5. If Hostinger's firewall feature is available, allow only 80/443 inbound, plus 41641/udp for Tailscale direct connections (optional).

### 15.2 Host hardening (Ansible roles in `infra/vps/`, idempotent, run from WSL)

| Role        | Controls                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base`      | Set hostname and timezone (UTC). `apt full-upgrade`. Install `unattended-upgrades` (security updates on, auto-reboot at 04:00 if required). `needrestart`. Chrony time sync. Remove unused packages.                                       |
| `users`     | Create a `deploy` user (sudo with password, SSH key only) and an `app` system user (no shell). Root login disabled.                                                                                                                        |
| `ssh`       | `PasswordAuthentication no`, `PermitRootLogin no`, `KbdInteractiveAuthentication no`, `AllowUsers deploy`, `MaxAuthTries 3`, modern ciphers and KEX only. After Tailscale is verified, SSH listens **only on the Tailscale interface**.    |
| `tailscale` | Join the tailnet with a tagged, pre-approved key. ACL: only the owner's devices and the `tag:ci` ephemeral node may reach `tag:vps:22`. Tailscale SSH or standard SSH over the tailnet.                                                    |
| `firewall`  | UFW default deny incoming and allow outgoing. Allow 80/443 (only from Cloudflare IP ranges once the domain is on Cloudflare) and `tailscale0`. Or **Cloudflare Tunnel**, which needs zero inbound ports (preferred once there's a domain). |
| `crowdsec`  | CrowdSec agent with the sshd, caddy, and http-cve collections, plus the firewall bouncer.                                                                                                                                                  |
| `docker`    | Docker Engine from the official repo. `daemon.json`: `userns-remap: default`, `no-new-privileges: true`, `live-restore: true`, log driver `local` with rotation, `icc: false`. The Docker socket is never mounted into containers.         |
| `kernel`    | sysctl hardening: `kernel.kptr_restrict=2`, `kernel.dmesg_restrict=1`, `net.ipv4.conf.all.rp_filter=1`, `accept_redirects=0`, `send_redirects=0`, `tcp_syncookies=1`, `fs.protected_*=1`.                                                  |
| `audit`     | `auditd` with basic rules on identity files, sudoers, docker, and ssh config. **Lynis** audit run with the score recorded in `docs/runbooks/vps-baseline.md`. Target ≥75.                                                                  |
| `sops`      | Install the VPS age private key (root-owned, 0400). Decrypt `prod.sops.yaml` at deploy time into a tmpfs-backed env file.                                                                                                                  |
| `backups`   | restic plus a systemd timer (§21).                                                                                                                                                                                                         |
| `app`       | Directory layout `/srv/gth/{staging,prod}`, compose files, Caddyfile, and the systemd unit for compose.                                                                                                                                    |

### 15.3 Reverse proxy (`infra/caddy/Caddyfile`)

```
{
  email ops@<domain>
  servers { protocols h1 h2 h3 }
}
(security_headers) {
  header {
    Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(self)"
    Cross-Origin-Opener-Policy "same-origin"
    Cross-Origin-Resource-Policy "same-site"
    -Server
    -X-Powered-By
  }
}
<domain> {
  import security_headers
  encode zstd gzip
  reverse_proxy web:3000
}
api.<domain> {
  import security_headers
  reverse_proxy api:4000
}
```

CSP is set by the app (nonces), not by Caddy. Request body size is capped at 1 MB except upload presign routes (Phase 5 uploads go straight to object storage).

### 15.4 Domain and edge (when a domain is bought)

- **Registrar:** Cloudflare Registrar or similar. Turn on registrar lock and 2FA.
- **Cloudflare:**
  - proxied DNS, SSL mode **Full (strict)**
  - WAF managed rules plus OWASP ruleset on
  - Bot Fight Mode on
  - rate-limit rules on `/api/auth/*`
  - "Always Use HTTPS"
  - HSTS preload submitted after 30 stable days
- **Origin lock:** UFW accepts 80/443 from Cloudflare IP ranges only, or use Cloudflare Tunnel.
- **Email:** SPF, DKIM (from the SMTP provider), and DMARC `p=quarantine` moving to `reject`. An MTA-STS policy is optional.
- **`/.well-known/security.txt`** with contact details and an expiry date.
- **CAA DNS record** restricting certificate issuers.

### 15.5 Deploy procedure (automated in `release.yml`, documented in `docs/runbooks/deploy.md`)

1. CI connects to the tailnet with an ephemeral `tag:ci` auth key.
2. SSH as `deploy` to the VPS.
3. `cosign verify ghcr.io/<owner>/gth-<svc>@<digest> --certificate-identity-regexp '^https://github.com/<owner>/gundam-tcg-hub/.github/workflows/release.yml@refs/heads/main$' --certificate-oidc-issuer https://token.actions.githubusercontent.com` for every service. **Abort on any failure.**
4. Decrypt secrets with `sops -d` into `/run/gth/<env>.env` (tmpfs, mode 0400).
5. `docker compose pull`, then run the migration job (`app_migrator` role, one-off container). **Abort on failure.**
6. `docker compose up -d --wait`. Healthchecks must pass within 120 s.
7. Smoke tests: `/healthz`, `/readyz`, one catalog API call, and a check that security headers are present.
8. **On failure:** automatic rollback to the previous digests (kept in `/srv/gth/<env>/last-good.txt`). Migrations must be backward-compatible (expand/contract pattern) so rollback is safe.
9. Record the deployed digests and git SHA in `audit_log` and the GitHub deployment.

---

## 16. Cross-Cutting Security Requirements Catalog

Every item applies to all phases unless noted otherwise. It is tracked in `docs/asvs-checklist.md`, mapped to ASVS 5.0 chapters.

### 16.1 Authentication (ASVS V6)

| #      | Requirement                                                                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-X.1 | No passwords stored. Sign-in methods are OAuth (Discord), magic link, and passkeys. If passwords are ever added: Argon2id (m=19 MiB, t=2, p=1), a breached-password check (k-anonymity HIBP), and a minimum of 12 characters. |
| SR-X.2 | Magic links: single use, 15-minute expiry, bound to the requesting browser via a cookie nonce, 32-byte token hashed at rest.                                                                                                  |
| SR-X.3 | Admin, creator-with-money, and seller accounts require MFA (passkey preferred, TOTP accepted). Recovery codes are hashed.                                                                                                     |
| SR-X.4 | Account enumeration resistance: identical responses and timing for existing and non-existing identifiers on auth endpoints.                                                                                                   |
| SR-X.5 | Users are notified by email or Discord of new sign-ins from new devices and of MFA changes.                                                                                                                                   |

### 16.2 Session management (ASVS V7)

SR-1.7 and SR-1.8 apply globally. In addition, users can see and revoke their active sessions in `/account/security`.

### 16.3 Authorization (ASVS V8)

| #      | Requirement                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| SR-X.6 | Deny by default. Every route declares a required permission, and a lint or test checks that no route lacks one.          |
| SR-X.7 | Central `authorize(subject, action, resource)` in `packages/auth`. It never trusts client-supplied `owner_id` or `role`. |
| SR-X.8 | RLS on user-owned tables as defense in depth (§7).                                                                       |
| SR-X.9 | Role changes are admin-only, require step-up, and are audited.                                                           |

### 16.4 Input, output, and injection (ASVS V1/V2)

| #       | Requirement                                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-X.10 | zod validation at every entry point: HTTP, queue job payloads, webhook bodies, CSV rows, bot command options, and env. Reject unknown fields (`.strict()`).                                              |
| SR-X.11 | Only parameterized queries through Drizzle. `sql.raw` is banned outside `packages/db/migrations` (a lint rule).                                                                                          |
| SR-X.12 | Output encoding: React by default. JSON responses always carry `Content-Type: application/json`. User-supplied Markdown is never rendered, or only through a strict sanitizer (DOMPurify on the server). |
| SR-X.13 | No user-controlled file paths, shell commands, template names, or redirect targets. Redirects go through an allowlist (`next` parameter validated as a same-origin relative path).                       |

### 16.5 Security headers and browser controls (ASVS V3)

| #       | Requirement                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SR-X.14 | The CSP from SR-2.3 plus the headers from §15.3 on every response, verified by an automated test.                                                                                    |
| SR-X.15 | Cookies: `__Host-` prefix, Secure, HttpOnly, SameSite as specified. No sensitive data in `localStorage`.                                                                             |
| SR-X.16 | Subresource integrity is not needed because no third-party scripts are loaded. Analytics, if added, must be self-hosted and cookieless (for example Umami or Plausible self-hosted). |

### 16.6 Cryptography (ASVS V11)

| #       | Requirement                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SR-X.17 | Use Node `crypto` only (no custom crypto). AES-256-GCM for field encryption, HMAC-SHA256 for tokens and signing, SHA-256 for hashing tokens with a pepper, `crypto.randomBytes` for all secrets. |
| SR-X.18 | Keys come from secrets, carry versioned key IDs, and are rotated through re-encryption jobs.                                                                                                     |
| SR-X.19 | TLS 1.2+ only at the edge (Caddy and Cloudflare defaults). Internal traffic stays on the private Docker network.                                                                                 |

### 16.7 Logging, audit, and monitoring (ASVS V16)

| #       | Requirement                                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SR-X.20 | Structured JSON logs (pino) with request ID, user ID (never email), route, status, and latency. Redaction list maintained in `packages/observability`.                                                                                                 |
| SR-X.21 | `audit_log` records auth events (login, MFA change, session revoke), role changes, admin actions, catalog edits, API key create and revoke, deploys, and money-affecting actions. It is append-only and retained for 1 year.                           |
| SR-X.22 | Security alerts go to Discord (private ops channel) and email, triggered by: spikes in failed logins, rate-limit bans, webhook signature failures, circuit-breaker storms, CrowdSec bans, a failed deploy signature verification, or a backup failure. |
| SR-X.23 | Log retention is 30 days for app logs and 1 year for audit logs. Logs contain no PII beyond hashed IPs.                                                                                                                                                |

### 16.8 Privacy and data protection

| #       | Requirement                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SR-X.24 | Data minimization: store Discord ID and username, email only if the user opts into email, and IPs as salted hashes (daily-rotating salt) except in the short-lived rate-limit store. |
| SR-X.25 | Users can export their data (JSON) and delete their account (hard delete within 30 days, keeping only anonymized, tax-required, or legally required records).                        |
| SR-X.26 | Privacy policy and ToS live before public launch. Age gate: 13+ for accounts and 18+ for selling (Stripe requirement).                                                               |

### 16.9 Availability and abuse

| #       | Requirement                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| SR-X.27 | Rate limits on every public endpoint (per IP, per user, per key). Cloudflare in front once there's a domain.   |
| SR-X.28 | Queue backpressure: maximum job concurrency per queue, dead-letter queues, and alerts on DLQ growth.           |
| SR-X.29 | Request timeouts at every layer (Caddy 30 s, app 15 s, DB statement timeout 5 s for web and 60 s for workers). |

### 16.10 Third-party integrations

| #       | Requirement                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-X.30 | Every integration (Discord, eBay API, Stripe, SMTP, R2) is listed in `docs/data-sources.md` with its scopes, credential location, rotation date, ToS link, and data shared. |
| SR-X.31 | Inbound webhooks are always signature-verified and idempotent. Outbound calls have timeouts, retries with jitter, and circuit breakers.                                     |

---

## 17. Threat Model

The full version lives in `docs/threat-model.md`, is reviewed at the start of every phase, and uses STRIDE. Initial register:

| #   | Threat                                                             | STRIDE | Boundary | Mitigations                                                                                        | Phase  |
| --- | ------------------------------------------------------------------ | ------ | -------- | -------------------------------------------------------------------------------------------------- | ------ |
| T1  | Account takeover through a stolen session or OAuth misuse          | S      | TB1/TB2  | SR-1.7, SR-X.3 to SR-X.5, OAuth state/PKCE, `__Host-` cookies                                      | 1+     |
| T2  | SSRF through the scanner fetching attacker-influenced URLs         | I/E    | TB4      | SR-1.1 to SR-1.3, domain allowlist, no user URLs                                                   | 1      |
| T3  | Malicious retailer HTML exploiting the parser or headless browser  | E      | TB4      | cheerio (no JS), isolated Playwright container, size caps                                          | 1      |
| T4  | IDOR on watches, collections, or orders                            | I/T    | TB2/TB3  | SR-X.6 to SR-X.8, RLS, two-user test matrix                                                        | 1+     |
| T5  | XSS through break titles or card notes on web and OBS overlay      | T/E    | TB1      | React escaping, nonce CSP, lint ban                                                                | 2+     |
| T6  | Overlay or API token leakage on stream or in logs                  | I      | TB1      | Hashed tokens, rotation, log redaction, no-referrer                                                | 2+     |
| T7  | Price index manipulation through fake reports or live-sale entries | T      | TB2      | Moderation, outlier detection, reputation weighting, rate limits                                   | 3–4    |
| T8  | Break-result tampering or accusations of rigging                   | T/R    | TB3      | Commit-reveal, hash chain, append-only DB role                                                     | 4      |
| T9  | Forged or replayed payment webhooks                                | S/T    | TB6      | Signature verification, idempotency table, async processing                                        | 5      |
| T10 | Malicious upload (polyglot, malware, EXIF PII leak)                | T/I/E  | TB1      | Presigned constraints, magic-byte check, re-encode, ClamAV, EXIF strip                             | 5      |
| T11 | Marketplace fraud (empty envelopes, counterfeits, chargebacks)     | R      | Business | Tracking requirements, holds, photo requirements, disputes flow, Radar                             | 5      |
| T12 | Dependency compromise (malicious npm package, install-script worm) | T/E    | TB7      | Lockfile, `minimumReleaseAge`, `onlyBuiltDependencies`, OSV and Dependabot, review policy          | 0+     |
| T13 | CI/CD compromise (malicious action, leaked token, poisoned image)  | T/E    | TB7      | SHA-pinned actions, minimal permissions, environment protections, cosign verify at deploy          | 0+     |
| T14 | VPS compromise through SSH brute force or unpatched service        | E      | TB8      | SSH over Tailscale only, key auth, CrowdSec, unattended upgrades, Lynis                            | Deploy |
| T15 | Secret leakage to git, logs, or screenshots on stream              | I      | All      | gitleaks (local and CI), push protection, SOPS, redaction, stream-safe UI                          | 0+     |
| T16 | DoS or scraping of our API and site                                | D      | TB1      | Cloudflare, rate limits, quotas, caching, timeouts                                                 | 1+     |
| T17 | Data loss (disk failure, ransomware, bad migration)                | D      | TB3      | restic off-site encrypted backups, restore drills, expand/contract migrations, Hostinger snapshots | Deploy |
| T18 | Legal takedown or ban from a third-party platform (ToS or IP)      | D      | TB4      | Official APIs only, robots compliance, image-link policy, `docs/data-sources.md`                   | 1+     |

---

## 18. CI/CD and Security Pipeline

### 18.1 Workflow hardening (all workflows)

- `permissions: {}` at the top level. Each job requests only what it needs, for example `contents: read`, plus `security-events: write` for SARIF upload or `id-token: write` and `packages: write` for release.
- Every `uses:` is pinned by 40-character SHA with a `# vX.Y.Z` comment.
- `step-security/harden-runner` is the first step, in egress `audit` mode first and later `block` with an allowlist.
- `concurrency` groups cancel superseded runs.
- No `pull_request_target` with a checkout of PR code. Fork PRs never get secrets.
- `timeout-minutes` is set on every job.

### 18.2 `ci.yml`: on `pull_request` and `push` to `main`

| Job                 | Tools                                                                                                                                                                              | Fail condition                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `setup`             | checkout, pnpm/action-setup, setup-node (with cache), `pnpm install --frozen-lockfile`                                                                                             | Lockfile drift                                                                                                 |
| `lint`              | eslint (`--max-warnings=0`), prettier `--check`, commitlint (PR title)                                                                                                             | Any error                                                                                                      |
| `typecheck`         | `turbo run typecheck`                                                                                                                                                              | Any error                                                                                                      |
| `unit`              | Vitest with coverage                                                                                                                                                               | Test failure; coverage below 80% on `packages/core`, `packages/security`, `packages/auth`, below 60% elsewhere |
| `integration`       | Vitest + Testcontainers (Postgres 17, Valkey 8)                                                                                                                                    | Failure                                                                                                        |
| `e2e`               | Playwright against `docker-compose.ci.yml` (built images)                                                                                                                          | Failure (traces uploaded as an artifact)                                                                       |
| `sast-semgrep`      | Semgrep CE: `p/typescript`, `p/nodejs`, `p/react`, `p/owasp-top-ten`, `p/secrets`, and repo `.semgrep.yml` custom rules (banned APIs, `sql.raw`, missing `authorize()`)            | Any ERROR-severity finding                                                                                     |
| `sast-codeql`       | GitHub CodeQL `javascript-typescript`, `security-extended` queries                                                                                                                 | High or Critical alerts (via the required check)                                                               |
| `secrets`           | gitleaks over the PR commit range, using `.gitleaks.toml` with the custom `gth_live_` rule                                                                                         | Any finding                                                                                                    |
| `sca`               | `osv-scanner --lockfile pnpm-lock.yaml`; `pnpm audit --audit-level=high --prod`; `license-checker` against the allowlist (MIT, Apache-2.0, BSD-2/3, ISC, 0BSD, MPL-2.0 for review) | High or Critical with a fix available; disallowed license                                                      |
| `iac`               | hadolint (all Dockerfiles), `trivy config` (compose, Ansible, Dockerfiles), actionlint + zizmor (workflow security linter)                                                         | Error-level findings                                                                                           |
| `container`         | Docker Buildx build for each service; `trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1`; Syft SBOM (CycloneDX JSON) uploaded as an artifact                    | Fixable High or Critical                                                                                       |
| `dependency-review` | `actions/dependency-review-action` (PRs only)                                                                                                                                      | Adds a dependency with a High vulnerability or a denied license                                                |

SARIF from Semgrep, Trivy, and CodeQL is uploaded to GitHub code scanning so findings show inline on PRs.

### 18.3 `nightly.yml`: cron `0 7 * * *` (UTC)

- Build and start the full stack in CI with seeded data.
- **DAST:**
  - OWASP ZAP baseline against the web app
  - ZAP API scan against `/docs/openapi.json`
  - authenticated scan using a test user's session (ZAP context)
  - fails on High or Medium alerts that aren't in `zap-rules.tsv` accepted-risk entries (each entry has a justification and an expiry)
- `trivy image` on the **currently deployed** digests from GHCR, to catch newly disclosed CVEs in images already running.
- `osv-scanner` on `main`.
- Results are posted to the private Discord ops channel.

### 18.4 `release.yml`: on `push` to `main`, after `ci` succeeds

1. Build multi-stage images (§19) for `web`, `api`, `worker`, `restock-scanner`, `discord-bot`, and `migrator`.
2. Push to `ghcr.io/<owner>/gth-<svc>` tagged with `sha-<gitsha>`. Record the digests.
3. `cosign sign --yes <image>@<digest>` (keyless, GitHub OIDC).
4. `actions/attest-build-provenance` and attach the SBOM (`cosign attest --type cyclonedx`).
5. **Deploy staging** (environment `staging`) using the §15.5 procedure.
6. Post-deploy smoke tests and a ZAP baseline against staging, over Tailscale.
7. **Deploy prod** (environment `production`, manual approval) with the same digests. Never rebuild for prod.
8. Create a GitHub Release with the changelog (from Conventional Commits), digests, and SBOM links.

### 18.5 Other workflows

- `scorecard.yml`: OpenSSF Scorecard weekly, SARIF to code scanning, target score ≥7.
- `codeql.yml`: advanced setup if custom queries are needed; otherwise default setup.
- Dependabot PRs go through the same `ci.yml`. Auto-merge is allowed only for patch-level devDependencies once all checks pass.

### 18.6 Branching and release policy

- Trunk-based development: short-lived feature branches, PRs into `main`, squash merge, and the PR title as a Conventional Commit.
- Every PR fills in the template's security checklist:
  - new inputs validated?
  - authz declared?
  - secrets?
  - new dependencies justified?
  - migrations backward-compatible?
  - threat model impact?
- Feature flags (DB-backed, simple) for incomplete features so trunk stays deployable.

---

## 19. Container Hardening

### 19.1 Dockerfile template (`infra/docker/Dockerfile.node`)

```dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:<pinned>
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/*/package.json packages/*/package.json ./   # (use turbo prune in practice)
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
ARG APP
COPY . .
RUN pnpm turbo run build --filter=@gth/${APP}... && pnpm deploy --filter=@gth/${APP} --prod /out

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime   # pin digest
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out ./
USER nonroot
EXPOSE 3000
HEALTHCHECK NONE   # healthchecks defined in compose (distroless has no shell)
CMD ["dist/index.js"]
```

Use `turbo prune --docker` to produce minimal build contexts. `web` uses Next.js `output: 'standalone'` on the same distroless base.

### 19.2 Compose runtime security (`docker-compose.prod.yml`, applied to every service)

```yaml
x-hardening: &hardening
  read_only: true
  tmpfs: ['/tmp:size=64m,mode=1777']
  security_opt: ['no-new-privileges:true']
  cap_drop: ['ALL']
  user: '65532:65532'
  pids_limit: 256
  restart: unless-stopped
  logging: { driver: local, options: { max-size: '10m', max-file: '5' } }
  deploy: { resources: { limits: { cpus: '1.0', memory: 512M } } }
```

**Networks**

- `edge`: Caddy ↔ web, api
- `internal: true`: apps ↔ postgres, valkey, clamav. No egress.
- `egress`: scanner and worker only, for outbound fetches.

**Rules**

- Only Caddy publishes ports (80/443).
- Postgres and Valkey publish **no** ports.
- Postgres runs with `ssl=on` internally (optional), `password_encryption=scram-sha-256`, `log_connections=on`, and `statement_timeout` set per role.
- Valkey runs with `requirepass`, ACL users per service, `rename-command FLUSHALL ""`, and `protected-mode yes`.

---

## 20. Observability, Alerting, and SLOs

| Signal  | Implementation                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| Logs    | pino JSON → stdout → Docker `local` driver. Promtail or Alloy ships them to Loki (prod) or otel-lgtm (local).              |
| Metrics | OTel metrics: HTTP RED metrics, queue depth, job latency, scanner success rate, alert delivery latency, and DB pool stats. |
| Traces  | OTel traces across web → api → worker (trace context propagated through job data).                                         |
| Uptime  | Uptime Kuma on the VPS, **plus** an external free uptime checker. Kuma on the same box can't report the box being down.    |
| Errors  | Error tracking through OTel exceptions in Grafana, or self-hosted GlitchTip (optional, ADR).                               |

**SLOs (initial)**

- Web availability: 99.5% monthly.
- Restock alert latency (detection to Discord delivery): p95 under 60 s.
- Scanner check success rate ≥95% per retailer per day.
- API p95 under 300 ms for `/v1/cards/{id}/prices`.

**Alerts (to the Discord ops channel)**

- SLO burn.
- DLQ size above 0 for 10 minutes.
- An open scanner circuit breaker for more than 2h.
- Disk above 80%.
- Backup failure.
- Certificate expiry under 14 days.
- Security events (SR-X.22).

---

## 21. Backup and Disaster Recovery

| Item          | Policy                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres      | `pg_dump -Fc` nightly at 03:00 UTC, plus WAL archiving with `pgBackRest` or `wal-g` once there's real user data. Target **RPO ≤ 24h**, reduced to ≤15 min with WAL archiving in Phase 5. |
| Volumes       | Valkey AOF and Caddy data (certificates).                                                                                                                                                |
| Tool          | **restic** with the repository on Cloudflare R2 or Backblaze B2. Encrypted client-side, with the password stored in SOPS and the password manager.                                       |
| Retention     | 7 daily, 4 weekly, 12 monthly (`restic forget --prune`).                                                                                                                                 |
| Immutability  | Object lock or versioning on the bucket where supported. The backup credentials can't delete (separate prune key kept offline).                                                          |
| Restore drill | Monthly: restore to a scratch container, run the integrity query suite, and record the time. Target **RTO ≤ 4h**.                                                                        |
| Config        | Everything else (compose, Caddyfile, Ansible) is in git. A new VPS is rebuilt from Ansible plus the latest backup. The procedure is `docs/runbooks/restore.md`.                          |
| Secondary     | Hostinger weekly snapshots as an extra layer, not the primary backup.                                                                                                                    |

---

## 22. Incident Response

`docs/runbooks/incident.md` covers:

1. **Detect:** alerts (§20), user reports, GitHub security alerts, CrowdSec.
2. **Triage** by severity:
   - SEV1: data breach, money loss, or prod down
   - SEV2: degraded service or a vulnerability being exploited
   - SEV3: everything else
3. **Contain:**
   - Kill switches (feature flags) for alerts, the API, uploads, and the marketplace.
   - Revoke sessions globally (rotate the session secret).
   - Rotate the affected secrets (key-rotation runbook).
   - Block IPs through Cloudflare or CrowdSec.
4. **Eradicate and recover:** patch, redeploy a signed image, and restore from backup if needed.
5. **Notify:** users within 72h if personal data is affected (and per applicable state law), Stripe if payments are involved, and Discord if a bot token leaked.
6. **Postmortem:** blameless, within 5 days, with action items tracked as GitHub issues labeled `security`.

**Kill switches** are DB-backed flags cached in Valkey with a 10 s TTL:

- `alerts.enabled`
- `api.public.enabled`
- `uploads.enabled`
- `market.checkout.enabled`
- `scanner.<retailer>.enabled`

---

## 23. Compliance, Legal, and Data-Source Policy

| Area               | Requirement                                                                                                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scraping and ToS   | Only retailers whose ToS and robots.txt allow automated stock checks, or that provide feeds or APIs. Reviewed and dated in `retailers.tos_reviewed_at`. No login-walled scraping. No circumventing bot protection. Prefer official APIs, user-connected data, and our own generated data (outline Part 4 §IV). |
| Marketplace data   | No scraping of TCGplayer, eBay, or Whatnot. eBay data only through approved APIs under their license terms.                                                                                                                                                                                                    |
| Card IP            | Card names and game text are the publisher's IP. Show card images only by linking or embedding from permitted sources, or use user-taken photos. Add attribution and a "not affiliated with Bandai" disclaimer. Review the publisher's fan-content and IP guidelines before rehosting any images.              |
| Privacy            | Privacy policy covering what's collected (§16.8), cookies (essential only), a data subject rights process, and retention. CCPA and GDPR basics if EU users are allowed.                                                                                                                                        |
| Children           | Minimum age 13 for accounts. No targeted advertising.                                                                                                                                                                                                                                                          |
| Payments (Phase 5) | Stripe Connect (no money transmission by us). PCI SAQ-A. Stripe Tax for marketplace-facilitator states. 1099-K through Stripe. Seller terms, buyer protection policy, and a prohibited items list (counterfeits, proxies).                                                                                     |
| Terms              | ToS, acceptable use, API terms (rate limits, attribution requirements for our open pricing data, e.g. CC BY 4.0 for index data — decide in an ADR), and a DMCA/takedown contact.                                                                                                                               |
| Records            | `docs/data-sources.md` and `docs/compliance-log.md` record reviews with dates.                                                                                                                                                                                                                                 |

_Not legal advice. Get a lawyer's review before Phase 5 launch._

---

## 24. Testing Strategy

| Level                    | Tooling                                                     | Scope                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                     | Vitest                                                      | Pricing math, state machines, `authorize()`, safeFetch, crypto helpers, CSV guards, randomization known-answer tests                                           |
| Integration              | Vitest + Testcontainers                                     | Repositories, RLS policies, BullMQ processors, webhook handlers, rate limiter                                                                                  |
| Contract                 | OpenAPI schema tests (zod ↔ OpenAPI), Schemathesis on `/v1` | Public API stability and fuzzing                                                                                                                               |
| E2E                      | Playwright                                                  | Sign-in (a mock OAuth provider in CI), watches, restock flow with the mock retailer, break logging with the overlay, collections, checkout in Stripe test mode |
| Security (automated)     | ZAP, Semgrep, CodeQL, Trivy, OSV, gitleaks                  | §18                                                                                                                                                            |
| Security (tests as code) | Vitest/Playwright                                           | IDOR matrix, CSP/header assertions, rate-limit 429s, SSRF corpus, XSS payload corpus, webhook replay/forgery, upload polyglots/EICAR, DB permission tests      |
| Performance              | k6 (manual before launches)                                 | Catalog search, API price endpoint, SSE fan-out (100 overlays)                                                                                                 |
| Restore                  | Scripted drill                                              | §21                                                                                                                                                            |

**Test data:** synthetic only. Factories in `packages/db/seed`. No production data in tests, ever.

---

## 25. Global Definition of Done (every PR and phase)

- [ ] All `ci.yml` gates are green. No new High or Critical findings (Semgrep, CodeQL, Trivy, OSV, ZAP nightly).
- [ ] New inputs validated with zod. New routes declare an authz permission and have IDOR tests.
- [ ] No secrets in code, logs, or fixtures. Redaction list updated for new sensitive fields.
- [ ] Migrations are backward-compatible (expand/contract) and tested for rollback.
- [ ] `audit_log` entries added for new sensitive actions.
- [ ] Docs updated: README, ADR for any significant decision, threat model on a new trust boundary, runbooks on an ops change, `data-sources.md` on a new integration.
- [ ] Observability: new jobs and endpoints emit metrics and traces. Alerts added where there's an SLO.
- [ ] Phase-level: the phase's AC list passes, the ASVS checklist delta is reviewed, and it's deployed to staging with a green smoke test and ZAP run.

---

## 26. Execution Order and Milestone Checklist

### M0: Kickoff (first session after approval)

- [ ] Copy this document to `TCG Market Project\docs\devsecops-build-plan.md`.
- [ ] Save the ".md outputs" preference to memory.

### M1: Phase 0 foundation

- [ ] Workstation installs (user runs the admin installers; Claude verifies with version checks).
- [ ] SSH, signing key, and gh auth; GitHub 2FA confirmed.
- [ ] Create the repo and scaffold the monorepo, configs, lefthook, and Dependabot.
- [ ] Dev compose stack, env validation, and DB roles.
- [ ] `ci.yml` with all gates. `nightly.yml` skeleton. `scorecard.yml`.
- [ ] Rulesets, security settings, and environments.
- [ ] SECURITY.md, ADRs 001–012, threat model v0.

### M2: Phase 1 catalog and restock alerts

- [ ] DB schema and migrations (Phase 1 tables, RLS, roles).
- [ ] Catalog admin and import CLI; seed the first Gundam sets.
- [ ] `safeFetch` plus the SSRF test corpus.
- [ ] Mock retailer, first adapter, and scheduler.
- [ ] Auth (Discord OAuth and passkeys), sessions, rate limits.
- [ ] Watches UI and bot commands.
- [ ] Alert fan-out (webhook, DM, email, push) with idempotency.
- [x] Admin scanner health dashboard. (`/admin/operations`, ADR-033, 2026-09-23)
- [ ] AC-1.1 to AC-1.6 green.

### M3: Deploy track (staging over Tailscale)

- [ ] Buy the VPS, run Ansible hardening, record the Lynis score.
- [ ] `release.yml` with signing, verification, staging deploy, and rollback.
- [ ] restic backups plus the first restore drill.
- [ ] Monitoring and alerts.

### M4: Domain and prod

- [ ] Buy the domain, set up Cloudflare, Caddy TLS, email authentication, and `security.txt`.
- [ ] Privacy policy and ToS.
- [ ] Prod environment and first production deploy.

### Later milestones

- **M5:** Phase 2 creator tooling (AC-2.x).
- **M6:** Phase 3 price tracker, collections, and public API (AC-3.x).
- **M7:** Phase 4 live-sale capture and break transparency (AC-4.x).
- **M8:** Phase 5 marketplace. Pre-launch security review (SR-5.10), legal review, then AC-5.x.

---

## 27. Verification (End-to-End)

### Local

```bash
pnpm stack:up                         # all services healthy (docker compose ps)
pnpm db:migrate && pnpm db:seed
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e
pnpm sec:scan                         # gitleaks + osv-scanner + semgrep: zero blocking findings
```

### Guardrail proofs (each is run once and the result recorded in `docs/runbooks/guardrail-proofs.md`)

| #   | Action                                                | Expected result                    |
| --- | ----------------------------------------------------- | ---------------------------------- |
| 1   | Stage a fake AWS key and commit                       | The pre-commit hook blocks it      |
| 2   | Push a commit containing a secret                     | GitHub push protection blocks it   |
| 3   | Open a PR adding a dependency with a known High CVE   | `sca` and `dependency-review` fail |
| 4   | Open a PR with `dangerouslySetInnerHTML` or `sql.raw` | Lint or Semgrep fails              |
| 5   | Open a PR with a Dockerfile running as root           | hadolint or Trivy config fails     |
| 6   | Try to deploy an unsigned or tampered image digest    | `cosign verify` aborts the deploy  |
| 7   | Push to `main` without a PR                           | Blocked by the ruleset             |

### Functional and security acceptance

- Phase ACs: AC-1.x to AC-5.x as each phase completes.
- ZAP nightly: no High alerts. Trivy on deployed images: no fixable Criticals. Scorecard ≥7.

### Deploy track

- The Lynis score is recorded and ≥75.
- External `nmap -Pn <vps-ip>` shows only 80/443 open, or nothing at all with Cloudflare Tunnel. Port 22 is closed publicly.
- SSH works only over Tailscale.
- Restore drill succeeds within the RTO target. Its timing is recorded.
- A deliberately failed healthcheck triggers automatic rollback to the last good digests.

---

## 28. Open Items

| #   | Item                                                                              | Decide by                      |
| --- | --------------------------------------------------------------------------------- | ------------------------------ |
| O1  | Which 1–3 retailers to scan first. Each needs its ToS and robots reviewed.        | Start of M2                    |
| O2  | Gundam catalog data source and image policy (link, embed, or user photos)         | Start of M2                    |
| O3  | Solo PR approval model (status checks only vs a second reviewer account): ADR-012 | M1                             |
| O4  | Local S3-compatible store for Phase 5 development                                 | Start of M8                    |
| O5  | Open data license for the published price index (for example CC BY 4.0)           | Start of M6                    |
| O6  | eBay developer program application for official API access                        | Early M6 (approval takes time) |
| O7  | Product name and domain                                                           | Before M4                      |
| O8  | Error tracking: Grafana-only vs GlitchTip                                         | M3                             |

---

## 29. Appendix A: Environment Variable Catalog

| Variable                                                                  | Phase  | Secret?  | Used by                   | Notes                                                  |
| ------------------------------------------------------------------------- | ------ | -------- | ------------------------- | ------------------------------------------------------ |
| `NODE_ENV`                                                                | 0      | No       | all                       |                                                        |
| `LOG_LEVEL`                                                               | 0      | No       | all                       | `info` in prod                                         |
| `APP_BASE_URL` / `API_BASE_URL`                                           | 0      | No       | web, api                  |                                                        |
| `DATABASE_URL_WEB` / `_WORKER` / `_READONLY` / `_MIGRATOR`                | 0      | Yes      | per service               | A separate DB role per service                         |
| `PG_SUPERUSER` / `PG_SUPERPASSWORD`                                       | 0      | Yes      | Postgres init only        | Never used by apps                                     |
| `VALKEY_URL` (per-service ACL user)                                       | 0      | Yes      | api, worker, scanner, bot |                                                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                             | 0      | No       | all                       |                                                        |
| `BETTER_AUTH_SECRET`                                                      | 1      | Yes      | web, api                  | 32+ bytes                                              |
| `BETTER_AUTH_URL`                                                         | 1      | No       | web                       |                                                        |
| `DISCORD_CLIENT_ID`                                                       | 1      | No       | web                       |                                                        |
| `DISCORD_CLIENT_SECRET`                                                   | 1      | Yes      | web                       |                                                        |
| `DISCORD_BOT_TOKEN`                                                       | 1      | Yes      | discord-bot, worker       |                                                        |
| `DISCORD_OPS_WEBHOOK_URL`                                                 | 1      | Yes      | worker                    | Ops and security alerts                                |
| `DATA_ENCRYPTION_KEYS`                                                    | 1      | Yes      | api, worker               | JSON `{kid: base64key}` + `DATA_ENCRYPTION_ACTIVE_KID` |
| `TOKEN_PEPPER`                                                            | 1      | Yes      | api, web                  | For hashing overlay, API, and magic-link tokens        |
| `SMTP_URL` / `EMAIL_FROM`                                                 | 1      | Yes / No | worker                    | Mailpit locally                                        |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`                                  | 1      | No / Yes | web, worker               |                                                        |
| `SCANNER_USER_AGENT`                                                      | 1      | No       | scanner                   | Includes a contact URL                                 |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`                                   | 3      | No / Yes | worker                    | Only if approved                                       |
| `STRIPE_SECRET_KEY` (restricted, per service)                             | 5      | Yes      | api, worker               | Separate RAKs                                          |
| `STRIPE_WEBHOOK_SECRET`                                                   | 5      | Yes      | api                       |                                                        |
| `STRIPE_PUBLISHABLE_KEY`                                                  | 5      | No       | web                       |                                                        |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 5      | Mixed    | api, worker               | Private bucket                                         |
| `CLAMAV_HOST`                                                             | 5      | No       | worker                    |                                                        |
| `RESTIC_REPOSITORY` / `RESTIC_PASSWORD` / backup bucket keys              | Deploy | Yes      | host timer                | Not in app containers                                  |

---

## 30. Appendix B: Tooling Inventory

| Purpose                | Tool                                                                  | Where it runs                |
| ---------------------- | --------------------------------------------------------------------- | ---------------------------- |
| Secret scanning        | gitleaks, GitHub secret scanning with push protection                 | pre-commit, CI, GitHub       |
| SAST                   | Semgrep CE, CodeQL, eslint-plugin-security                            | CI, editor                   |
| SCA                    | Dependabot, OSV-Scanner, pnpm audit, dependency-review-action         | GitHub, CI                   |
| License compliance     | license-checker (allowlist)                                           | CI                           |
| IaC and config         | hadolint, Trivy config, actionlint, zizmor                            | CI                           |
| Container scanning     | Trivy image                                                           | CI, nightly                  |
| SBOM                   | Syft (CycloneDX)                                                      | release                      |
| Signing and provenance | cosign (keyless), GitHub build provenance attestations                | release, deploy verify       |
| DAST                   | OWASP ZAP (baseline, API, authenticated)                              | nightly, post-staging deploy |
| API fuzzing            | Schemathesis                                                          | CI (Phase 3+)                |
| Repo posture           | OpenSSF Scorecard, StepSecurity harden-runner                         | CI                           |
| Host security          | Ansible, UFW, CrowdSec, unattended-upgrades, auditd, Lynis, Tailscale | VPS                          |
| Edge                   | Cloudflare (WAF, DNS, Tunnel), Caddy                                  | Internet edge, VPS           |
| Secrets                | SOPS + age, GitHub environment secrets                                | repo, CI, VPS                |
| Backups                | restic, pg_dump or pgBackRest/wal-g                                   | VPS → R2 or B2               |
| Observability          | pino, OpenTelemetry, Grafana LGTM, Uptime Kuma, external uptime check | all                          |
| Testing                | Vitest, Testcontainers, Playwright, k6                                | local, CI                    |
