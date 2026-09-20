# syntax=docker/dockerfile:1.7
# API image (plan §19.1). Build from the repo root:
#   docker build -f infra/docker/api.Dockerfile -t gth-api .
# Base images are pinned by digest; Dependabot bumps them (SR-0.11).

FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    LEFTHOOK=0 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# Fetch deps from the lockfile alone so this layer caches across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --ignore-scripts --filter @gth/api...
RUN pnpm --filter @gth/api build

# Production-only dependency tree, taken straight from the lockfile (no re-resolution),
# so the image ships exactly the versions CI scanned.
FROM build AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --offline --frozen-lockfile --ignore-scripts --prod --filter @gth/api

# Runtime: distroless (no shell, no package manager), non-root (plan §19).
# Debian 13: the debian12 variant shipped unpatched OpenSSL (CVE-2026-31789 et al.) on 2026-09-20.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:bb6b03d81066993293a10feda7250e8e1cc034035fe9b61cfceededa7c8bf04d AS runtime
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000
WORKDIR /app/apps/api
# Files stay root-owned so the app user cannot modify its own code.
# pnpm's layout is kept (apps/api/node_modules symlinks into /app/node_modules/.pnpm).
COPY --from=prod-deps /repo/node_modules /app/node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./node_modules
COPY --from=build /repo/apps/api/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
# The bundled migration runner resolves its SQL relative to dist/ (../migrations).
COPY --from=build /repo/packages/db/migrations ./migrations
USER 65532:65532
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/index.js"]
