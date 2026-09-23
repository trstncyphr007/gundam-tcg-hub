#!/usr/bin/env bash
# How the OBS overlay holds up with a hundred viewers (plan §24).
#
#   bash scripts/measure-overlays.sh
#   STREAMS=200 bash scripts/measure-overlays.sh
#
# Creates its own breaks, opens the streams, logs one pull and times the arrival at every
# overlay watching that break — then removes what it created. Needs the API running and
# DATABASE_URL_MIGRATOR set (`.env` provides it locally).
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
if ! curl -fsS -o /dev/null "${BASE_URL}/healthz"; then
  echo "No API at ${BASE_URL}. Start the stack first (pnpm stack:up && pnpm dev)." >&2
  exit 1
fi

# Every stream here opens from one address, so more than ~120 of them trips the per-IP limit
# (SR-1.9) — and a hundred and eighty refusals look exactly like an overlay that cannot cope.
# In production those connections arrive from as many different machines as there are viewers.
if [ "${STREAMS:-100}" -gt 100 ]; then
  probe=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE_URL}/v1/games")
  if [ "$probe" != "429" ] && [ "${API_RATE_LIMIT_RAISED:-}" != "1" ]; then
    cat >&2 <<'MSG'
Opening more than 100 streams from one address will be refused by the per-IP rate limit,
not by anything to do with overlays. Restart the API with the limit raised for the run:

  API_RATE_LIMIT_MAX=100000 pnpm --filter @gth/api dev

then re-run with API_RATE_LIMIT_RAISED=1 so this check knows you meant it.
MSG
    exit 1
  fi
fi

BASE_URL="$BASE_URL" exec node perf/sse-fanout.mjs "$@"
