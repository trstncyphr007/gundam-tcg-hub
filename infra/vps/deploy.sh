#!/usr/bin/env bash
# Installed on the VPS at /srv/gth/deploy.sh (root-owned, 0750).
# Called by the deploy workflow over SSH:
#   sudo /srv/gth/deploy.sh <staging|production> <api-digest> <web-digest>
#
# Verifies signatures again on the server (the CI check could be bypassed by anyone who
# reached the box), decrypts secrets to tmpfs, migrates, then rolls forward - or back.
set -euo pipefail

ENVIRONMENT="${1:?usage: deploy.sh <staging|production> <api-digest> <web-digest>}"
API_DIGEST="${2:?}"
WEB_DIGEST="${3:?}"

case "$ENVIRONMENT" in
  staging|production) ;;
  *) echo "unknown environment: $ENVIRONMENT" >&2; exit 1 ;;
esac
for d in "$API_DIGEST" "$WEB_DIGEST"; do
  [[ "$d" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "not a digest: $d" >&2; exit 1; }
done

# The three paths below are overridable **only** so the deploy can be rehearsed end to end on
# a workstation (`scripts/deploy-rehearsal.sh`) without root. Nothing sets them in production:
# the workflow calls `sudo /srv/gth/deploy.sh`, and these defaults are what it gets.
GTH_ROOT="${GTH_ROOT:-/srv/gth}"
GTH_RUNTIME_DIR="${GTH_RUNTIME_DIR:-/run/gth}"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/root/.config/sops/age/keys.txt}"

ROOT="${GTH_ROOT}/${ENVIRONMENT}"
OWNER="trstncyphr007"
REPO="trstncyphr007/gundam-tcg-hub"
RUNTIME_ENV="${GTH_RUNTIME_DIR}/${ENVIRONMENT}.env"
LAST_GOOD="${ROOT}/last-good.env"
COMPOSE=(docker compose -p "gth-${ENVIRONMENT}" -f "${ROOT}/docker-compose.prod.yml")

log() { printf '[deploy] %s\n' "$*"; }

log "verifying signatures"
for pair in "api:${API_DIGEST}" "web:${WEB_DIGEST}"; do
  name="${pair%%:*}"; digest="${pair#*:}"
  cosign verify "ghcr.io/${OWNER}/gth-${name}@${digest}" \
    --certificate-identity-regexp "^https://github.com/${REPO}/.github/workflows/release.yml@refs/heads/main$" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com >/dev/null
done

# Remember what is currently running so a failure can roll straight back.
PREVIOUS_API=$(grep -E '^API_IMAGE=' "$LAST_GOOD" 2>/dev/null | cut -d= -f2- || true)
PREVIOUS_WEB=$(grep -E '^WEB_IMAGE=' "$LAST_GOOD" 2>/dev/null | cut -d= -f2- || true)

NEW_API="ghcr.io/${OWNER}/gth-api@${API_DIGEST}"
NEW_WEB="ghcr.io/${OWNER}/gth-web@${WEB_DIGEST}"

# The secrets and the two image references are written in one pass and the file is sealed
# afterwards. It used to be sealed at 0400 first and appended to twice — which works only
# because this runs as root, and root ignores the permissions it just set. Writing it once
# means the file is never half-built, and the script stops depending on that.
write_runtime_env() {
  install -d -m 0700 "$GTH_RUNTIME_DIR"
  rm -f "$RUNTIME_ENV"
  {
    SOPS_AGE_KEY_FILE="$AGE_KEY_FILE" sops -d "${ROOT}/secrets.sops.env"
    echo "API_IMAGE=$1"
    echo "WEB_IMAGE=$2"
    # Where the shipped files actually are. The compose file's own relative paths are correct
    # inside the repository and wrong here, where it sits alone in this directory.
    echo "CADDYFILE=${ROOT}/Caddyfile"
    echo "DB_INIT_DIR=${ROOT}/db-init"
  } > "$RUNTIME_ENV"
  chmod 0400 "$RUNTIME_ENV"
}

log "decrypting secrets to tmpfs"
write_runtime_env "$NEW_API" "$NEW_WEB"

log "pulling images"
docker pull -q "$NEW_API" >/dev/null
docker pull -q "$NEW_WEB" >/dev/null

log "running migrations (one-off, as app_migrator)"
"${COMPOSE[@]}" --env-file "$RUNTIME_ENV" --profile migrate run --rm migrator

rollback() {
  if [ -z "${PREVIOUS_API}" ]; then
    log "no previous release recorded; leaving the stack as-is for inspection"
    exit 1
  fi
  log "FAILED - rolling back to ${PREVIOUS_API}"
  # Rewritten, not edited in place: the file is read-only by then, and `sed -i` on it worked
  # only by virtue of running as root.
  write_runtime_env "$PREVIOUS_API" "$PREVIOUS_WEB"
  "${COMPOSE[@]}" --env-file "$RUNTIME_ENV" up -d --wait || true
  exit 1
}
trap rollback ERR

log "starting the new release"
"${COMPOSE[@]}" --env-file "$RUNTIME_ENV" up -d --wait --remove-orphans

log "smoke test"
# Through Caddy, the way a visitor arrives. With a real domain Caddy answers plain HTTP with
# a redirect to HTTPS, so the test has to speak HTTPS to that name, resolved to this box —
# an earlier version sent plain HTTP with a Host header and would have "failed" (308) and
# rolled back every deploy on a real domain. A bare `:port` address (no domain yet, reached
# over Tailscale) is plain HTTP on that port.
site=$(grep -E '^SITE_ADDRESS=' "$RUNTIME_ENV" | cut -d= -f2- | cut -d, -f1 | tr -d ' ')
if [[ "$site" == :* ]]; then
  base="http://127.0.0.1${site}"
  resolve=()
else
  base="https://${site}"
  resolve=(--resolve "${site}:443:127.0.0.1")
fi
# Retried for up to a minute: on a new domain Caddy obtains its first certificate only after
# the containers are healthy, and a smoke test that ran into that gap would roll back a good
# release.
for path in / /v1/games; do
  code=000
  for _ in $(seq 1 12); do
    code=$(curl -sS "${resolve[@]}" -o /dev/null -w '%{http_code}' "${base}${path}" 2>/dev/null || true)
    [ "$code" = "200" ] && break
    sleep 5
  done
  [ "$code" = "200" ] || { log "smoke test failed: ${base}${path} -> ${code}"; false; }
done

trap - ERR
{
  echo "API_IMAGE=${NEW_API}"
  echo "WEB_IMAGE=${NEW_WEB}"
  echo "DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$LAST_GOOD"
log "deployed ${ENVIRONMENT}: api=${API_DIGEST} web=${WEB_DIGEST}"
