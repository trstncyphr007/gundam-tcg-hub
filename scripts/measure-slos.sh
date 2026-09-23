#!/usr/bin/env bash
# Measure the plan's speed promises against a running stack (FR-1.3, §20).
#
#   pnpm db:seed-scale            # 10,000 cards, once
#   bash scripts/measure-slos.sh  # then this, as often as you like
#
# The thresholds live in perf/catalog.js and are the promises themselves, so this exits
# non-zero when one is missed. Numbers from a workstation are not numbers from the VPS — what
# this is for is catching the change that makes something ten times slower, which looks the
# same on any hardware.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
DURATION="${DURATION:-30s}"
K6_IMAGE="grafana/k6:1.4.1@sha256:200d24a0770ad12761569993c723fd7d48b29fc7983ff5f976bf8b8dba4c7d21"

if ! curl -fsS -o /dev/null "${BASE_URL}/healthz"; then
  echo "No API at ${BASE_URL}. Start the stack first (pnpm stack:up && pnpm dev)." >&2
  exit 1
fi

# The per-IP limiter refuses this load long before the endpoint struggles — 120/min by
# default, and this offers 40/second. A run against the limiter measures the limiter, which
# has its own tests and is not what any of these thresholds are about.
probe=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE_URL}/v1/games")
if [ "$probe" = "429" ]; then
  cat >&2 <<'MSG'
The API is rate limiting this address, so a measurement now would measure the limiter.

Restart the API with the limit raised for the run:

  API_RATE_LIMIT_MAX=100000 pnpm --filter @gth/api dev

and put it back afterwards. The limiter itself is covered by its own tests (SR-1.9).
MSG
  exit 1
fi

cards=$(curl -fsS "${BASE_URL}/v1/cards?limit=1" | grep -o '"total":[0-9]*' | head -n1 | cut -d: -f2 || true)
echo "measuring ${BASE_URL} · catalog holds ${cards:-?} cards · ${DURATION} per scenario"
if [ -n "${cards:-}" ] && [ "${cards:-0}" -lt 5000 ]; then
  echo "WARNING: fewer than 5,000 cards. The promise is about 10,000 — run pnpm db:seed-scale." >&2
fi

# Inside the container, "localhost" is the container. Docker Desktop's host is not this WSL
# distro either, so the loopback address is rewritten to the host gateway — which is also why
# the health check above runs out here, against the address a person would use.
CONTAINER_URL="${BASE_URL//127.0.0.1/host.docker.internal}"
CONTAINER_URL="${CONTAINER_URL//localhost/host.docker.internal}"

docker run --rm \
  --add-host "host.docker.internal:host-gateway" \
  -v "$PWD/perf:/perf:ro" \
  -e "BASE_URL=${CONTAINER_URL}" \
  -e "DURATION=${DURATION}" \
  "$K6_IMAGE" run /perf/catalog.js
