#!/usr/bin/env bash
# Build the production images and run the production compose stack on this machine,
# then prove it works end to end (plan §27 "Verification").
#
#   bash scripts/verify-prod-stack.sh
#
# Uses plain HTTP on 127.0.0.1:8080 (no ACME for "localhost"); everything else — hardened
# containers, internal networks, Caddy in front, migrations as a one-off job — is the real
# production configuration.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f infra/compose/docker-compose.prod.yml -f infra/compose/docker-compose.prod-local.yml)
ENV_FILE=/tmp/gth-prod-local.env

step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

step "build images"
docker build -q -f infra/docker/api.Dockerfile -t gth-api:local . >/dev/null
docker build -q -f infra/docker/web.Dockerfile -t gth-web:local . >/dev/null
echo "api $(docker image ls gth-api:local --format '{{.Size}}') · web $(docker image ls gth-web:local --format '{{.Size}}')"

step "generate a throwaway env"
rand() { openssl rand -hex 24; }
PG_SUPER=$(rand); PG_MIG=$(rand); PG_WEB=$(rand); PG_WORK=$(rand); PG_RO=$(rand)
umask 077
cat > "$ENV_FILE" <<EOF
SITE_ADDRESS=:8080
ACME_EMAIL=ops@localhost
API_IMAGE=gth-api:local
WEB_IMAGE=gth-web:local
API_BASE_URL=http://127.0.0.1:8080
APP_BASE_URL=http://127.0.0.1:8080
LOG_LEVEL=warn
PG_SUPERUSER=gth_admin
PG_SUPERPASSWORD=${PG_SUPER}
PG_DATABASE=gth
PG_MIGRATOR_PASSWORD=${PG_MIG}
PG_WEB_PASSWORD=${PG_WEB}
PG_WORKER_PASSWORD=${PG_WORK}
PG_READONLY_PASSWORD=${PG_RO}
DATABASE_URL_MIGRATOR=postgres://app_migrator:${PG_MIG}@postgres:5432/gth
DATABASE_URL_WEB=postgres://app_web:${PG_WEB}@postgres:5432/gth
DATABASE_URL_WORKER=postgres://app_worker:${PG_WORK}@postgres:5432/gth
DATABASE_URL_READONLY=postgres://app_readonly:${PG_RO}@postgres:5432/gth
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
TOKEN_PEPPER=$(openssl rand -base64 32)
DATA_ENCRYPTION_KEYS='{"k1":"$(openssl rand -base64 32)"}'
DATA_ENCRYPTION_ACTIVE_KID=k1
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=http://localhost:8080
SMTP_URL=smtp://mailpit:1025
EMAIL_FROM="gundam-tcg-hub <no-reply@localhost>"
EOF
echo "wrote $ENV_FILE"

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "KEEP=1: leaving the stack and $ENV_FILE in place for inspection"
    return
  fi
  "${COMPOSE[@]}" --env-file "$ENV_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

step "start the stack"
"${COMPOSE[@]}" --env-file "$ENV_FILE" up -d --wait 2>&1 | tail -n 5

step "run migrations as a one-off job"
"${COMPOSE[@]}" --env-file "$ENV_FILE" --profile migrate run --rm migrator 2>&1 | tail -n 3

step "seed the sample catalog (local verification only)"
DATABASE_URL_MIGRATOR="postgres://app_migrator:${PG_MIG}@127.0.0.1:5433/gth" \
  pnpm -s db:seed 2>&1 | tail -n 1

step "every scheduled job runs in the production image"
# What systemd runs at 03:30, 04:30 and every few minutes, in the production image, on the
# worker role. These were pnpm scripts until #45, which the production image has no way to run
# — so this proves the thing the server will actually execute rather than the developer command
# that resembles it. A grant the worker is missing fails here, not at 04:30. The watchdog runs
# with no webhook configured, which must still be a clean exit.
#
# **The exit code is checked.** This used to pipe each job through `sed | tail`, so the status
# came from `tail` and every job "passed" however it ended. `alert-retry` was broken the whole
# time it was in this list: it read the whole application's configuration instead of its own
# handful, so it died on secrets it never uses.
jobs_failed=''
for job in rollup retention watchdog alert-retry; do
  if out=$("${COMPOSE[@]}" --env-file "$ENV_FILE" --profile jobs run --rm "$job" 2>&1); then
    printf '  ok    %-12s %s\n' "$job" "$(printf '%s' "$out" | grep -v '^ *Container ' | tail -n 1)"
  else
    printf '  FAIL  %-12s\n' "$job"
    printf '%s\n' "$out" | tail -n 12 | sed 's/^/          /'
    jobs_failed="${jobs_failed} ${job}"
  fi
done
[ -z "$jobs_failed" ] || {
  printf '\n\033[1;31mjobs that could not run:%s\033[0m\n' "$jobs_failed" >&2
  exit 1
}

step "the alerts kill switch stops the retry job too"
# The switch an operator pulls at 2am (§22, ADR-039). Fan-out has read it since the switches
# were built; this job did not, so pulling it stopped *new* alerts while the timer kept
# draining the backlog to the same inboxes every five minutes.
#
# Proved here, in the production image, against a real row in `app.feature_flags` — because
# both previous faults in this job were in the wiring and not the logic (#76 no timer, #77
# could not start), and neither would have been caught by a unit test.
flag() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" exec -T -e PGPASSWORD="$PG_SUPER" postgres \
    psql -q -U gth_admin -h 127.0.0.1 -d gth -c \
    "insert into app.feature_flags (key, enabled, reason, updated_by)
     values ('alerts.enabled', $1, 'verify-prod-stack drill', 'drill')
     on conflict (key) do update set enabled = excluded.enabled" >/dev/null
}
flag false
off=$("${COMPOSE[@]}" --env-file "$ENV_FILE" --profile jobs run --rm alert-retry 2>&1) || true
flag true
off=$(printf '%s' "$off" | grep -v '^ *Container ' | tail -n 1)
case "$off" in
*'switched off'*) printf '  ok    refuses to send while alerts.enabled is off: %s\n' "$off" ;;
*)
  printf '  FAIL  the kill switch did not stop it: %s\n' "$off" >&2
  exit 1
  ;;
esac

step "smoke tests through Caddy"
base=http://127.0.0.1:8080
printf 'home            %s\n' "$(curl -s -o /dev/null -w '%{http_code}' $base/)"
printf 'catalog api     %s\n' "$(curl -s -o /dev/null -w '%{http_code}' $base/v1/games)"
# The public API documentation (FR-3.6). It returned 500 in production until 2026-09-24 —
# Caddy sent it to Next, whose rewrite had a build-time address baked into it.
printf 'api docs        %s\n' "$(curl -s -o /dev/null -w '%{http_code}' $base/docs)"
printf 'openapi doc     %s\n' "$(curl -s -o /dev/null -w '%{http_code}' $base/docs/openapi.json)"
printf 'me (anonymous)  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' $base/v1/me)"
printf 'rate limit hdrs %s\n' "$(curl -s -D - -o /dev/null $base/v1/games | grep -ci 'ratelimit')"
printf 'security hdrs   %s\n' "$(curl -s -D - -o /dev/null $base/ | grep -ciE '^(strict-transport-security|x-content-type-options|content-security-policy|referrer-policy)') of 4"
printf 'server header   %s\n' "$(curl -s -D - -o /dev/null $base/ | grep -ci '^server:') (0 = hidden)"

step "containers are hardened"
for svc in api web caddy; do
  cid=$("${COMPOSE[@]}" --env-file "$ENV_FILE" ps -q "$svc")
  docker inspect "$cid" --format "$svc: user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} caps_dropped={{.HostConfig.CapDrop}} no_new_priv={{index .HostConfig.SecurityOpt 0}}"
done

step "the database is not reachable from outside the stack"
printf 'postgres published ports: %s (empty = none)\n' "$(docker inspect "$("${COMPOSE[@]}" --env-file "$ENV_FILE" ps -q postgres)" --format '{{json .NetworkSettings.Ports}}')"

step "browser tests against the production stack"
# Catalog + header specs only: the sign-in specs need Mailpit, which production has no use for.
# Global setup seeds its accounts over the migrator connection (since #16), so it needs one
# here too — without it this step failed before running a single test.
DATABASE_URL_MIGRATOR="postgres://app_migrator:${PG_MIG}@127.0.0.1:5433/gth" \
  PLAYWRIGHT_BASE_URL=$base pnpm --filter @gth/web exec playwright test e2e/catalog.spec.ts \
  --reporter=list 2>&1 | tail -n 8

step "done"
echo "stack verified; tearing down"
