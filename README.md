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
pnpm dev              # API on http://127.0.0.1:4000/healthz
```

Optional services: `docker compose --env-file .env -f infra/compose/docker-compose.dev.yml --profile mail --profile observability up -d`
(Mailpit on :8025, Grafana LGTM on :3001).

## Everyday commands

| Command                                                    | What it does                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck`                             | ESLint (type-aware + security rules) / `tsc`                        |
| `pnpm test` / `pnpm test:coverage`                         | Vitest (80% coverage floor on `core`, `security`)                   |
| `pnpm build`                                               | Build all apps                                                      |
| `pnpm sec:scan`                                            | Run the CI security gates locally (gitleaks, osv, semgrep, trivy …) |
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
