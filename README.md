# gundam-tcg-hub

Gundam TCG platform: restock alerts → creator tools → price index & collections → live-sale
capture & break transparency → marketplace. Built security-first; see
[`docs/devsecops-build-plan.md`](docs/devsecops-build-plan.md).

The restock **scanner** lives in its own Python repo (`trstncyphr007/gundam-scanner`) and
integrates with this platform in Phase 1 (ADR-013).

## Quickstart (WSL2 Ubuntu)

```bash
pnpm install          # also installs git hooks (lefthook)
pnpm env:init         # generates .env with random local secrets (never committed)
pnpm stack:up         # Postgres 17 + Valkey 8 on 127.0.0.1
pnpm db:migrate       # apply migrations (runs as app_migrator)
pnpm db:seed          # sample catalog for local dev
pnpm dev              # API on http://127.0.0.1:4000/healthz
```

## Public API (v1)

| Endpoint            | Notes                                                    |
| ------------------- | -------------------------------------------------------- |
| `GET /healthz`      | Liveness. Never touches dependencies                     |
| `GET /readyz`       | Readiness. Reports database health, 503 when unavailable |
| `GET /v1/games`     | Games in the catalog                                     |
| `GET /v1/sets`      | `?game=<slug>&limit=&cursor=`                            |
| `GET /v1/cards`     | `?q=&setId=&limit=&cursor=` (trigram search)             |
| `GET /v1/cards/:id` | One card with its variants                               |
| `GET /v1/products`  | Sealed products, `?game=<slug>`                          |

Reads go through the **read-only** database role. Responses are cached (`max-age=300`) with
ETags for conditional GETs. Every query parameter is validated; unknown parameters are rejected
and invalid values are never echoed back.

## Accounts

| Endpoint                                        | Notes                                                     |
| ----------------------------------------------- | --------------------------------------------------------- |
| `POST /api/auth/sign-in/magic-link`             | Emails a one-time link (15 min, single use), 5/min per IP |
| `GET /api/auth/sign-in/social?provider=discord` | Discord OAuth, scopes `identify` + `email`                |
| `POST /api/auth/sign-out`                       | Revokes the session server-side                           |
| `GET /v1/me`                                    | The signed-in account (`no-store`)                        |
| `PATCH /v1/me`                                  | Update `displayName` only                                 |
| `GET /v1/admin/ping`                            | Requires the `admin` role                                 |
| `GET /v1/watches`                               | The caller's watch subscriptions                          |
| `POST /v1/watches`                              | Watch a product or one listing (max 50 per user)          |
| `DELETE /v1/watches/:id`                        | Remove one of the caller's watches                        |

**No passwords exist.** Sign-in is Discord OAuth or a one-time email link. Sessions are
`HttpOnly`, `SameSite=Lax`, `Path=/` cookies (plus `Secure` and a `__Host-` prefix in
production), 30-day absolute lifetime. Roles are server-controlled: clients cannot set or
change `role`.

Watches are **row-level secured**: Postgres itself restricts every row to its owner, so even a
missing `WHERE` clause cannot leak another user's data. Queries run through `asUser()`, which
declares the acting user for the duration of one transaction.

Locally, sign-in links go to **Mailpit** (`--profile mail`, inbox at http://127.0.0.1:8025).
Without SMTP configured, the link is logged in development and the API refuses to start in
production.

### Enabling Discord sign-in

1. Create an application at https://discord.com/developers/applications.
2. OAuth2 → add redirect `http://127.0.0.1:4000/api/auth/callback/discord` (and the production
   URL later).
3. Copy the client ID/secret into `.env` as `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`.
   Without them the provider stays disabled and magic links still work.

Optional services: `docker compose --env-file .env -f infra/compose/docker-compose.dev.yml --profile mail --profile observability up -d`
(Mailpit on :8025, Grafana LGTM on :3001).

## Everyday commands

| Command                                                    | What it does                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck`                             | ESLint (type-aware + security rules) / `tsc`                        |
| `pnpm test` / `pnpm test:coverage`                         | Vitest (80% coverage floor on `core`, `security`)                   |
| `pnpm build`                                               | Build all apps                                                      |
| `pnpm sec:scan`                                            | Run the CI security gates locally (gitleaks, osv, semgrep, trivy …) |
| `pnpm db:generate`                                         | Generate a migration from schema changes (Drizzle)                  |
| `pnpm stack:down` / `pnpm stack:reset`                     | Stop the stack / stop and **delete** local data                     |
| `docker build -f infra/docker/api.Dockerfile -t gth-api .` | Hardened distroless API image                                       |

## Layout

```
apps/api            Fastify API (health, security headers, rate limits)
packages/core       env validation + shared domain code
packages/security   token generation / hashing / constant-time compare
packages/db         Postgres least-privilege roles (Drizzle schema in Phase 1)
packages/config     shared tsconfig
infra/              compose stacks, Dockerfiles
scripts/            env init, security scan, license check, git hook helpers
docs/               plan, ADRs, threat model
```

## Workflow

Trunk-based: branch → PR → CI green → squash merge. `main` is guarded locally by a pre-push
hook (GitHub Free private repos have no branch protection, see ADR-014). Commits must be
signed and follow Conventional Commits.
