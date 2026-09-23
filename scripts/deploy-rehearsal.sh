#!/usr/bin/env bash
# Run the real deploy script, on this machine, against the real published images (§15.5).
#
#   bash scripts/deploy-rehearsal.sh
#
# `infra/vps/deploy.sh` is the one critical path that has never been executed: it verifies
# signatures, decrypts secrets, migrates, starts the stack, smoke-tests it and rolls back on
# failure — and until now every word of that was a claim. It runs here unmodified, with only
# its roots pointed at a temporary directory, so the thing being rehearsed is the thing that
# will run on the server.
#
# What is real: the published image digests, the signature verification against this
# repository's release workflow, the SOPS decryption, the migration job, the compose stack, the
# smoke test and the rollback. What is not: the server.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v cosign > /dev/null || { echo "cosign is not installed (see roles/app for how the server gets it)" >&2; exit 1; }
command -v sops > /dev/null || { echo "sops is not installed" >&2; exit 1; }
command -v age-keygen > /dev/null || { echo "age is not installed" >&2; exit 1; }

WORK="$(mktemp -d)"
export GTH_ROOT="${WORK}/srv"
export GTH_RUNTIME_DIR="${WORK}/run"
export SOPS_AGE_KEY_FILE="${WORK}/age.txt"
ENVIRONMENT=production
ROOT="${GTH_ROOT}/${ENVIRONMENT}"

# shellcheck disable=SC2329  # invoked by the trap below
cleanup() {
  docker compose -p "gth-${ENVIRONMENT}" -f "${ROOT}/docker-compose.prod.yml" \
    --env-file "${GTH_RUNTIME_DIR}/${ENVIRONMENT}.env" down -v --remove-orphans > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

step "lay out what the app role installs"
install -d -m 0755 "$ROOT" "${ROOT}/db-init"
cp infra/compose/docker-compose.prod.yml "$ROOT/"
cp infra/caddy/Caddyfile "$ROOT/"
# The roles the database creates on first start. Shipping these is what the app role does;
# forgetting them is what made the first rehearsal fail.
cp packages/db/init/* "${ROOT}/db-init/"

step "make an age key and an encrypted secrets file, as the operator does"
age-keygen -o "$SOPS_AGE_KEY_FILE" 2> "${WORK}/age.log"
RECIPIENT=$(grep -o 'age1[a-z0-9]*' "${WORK}/age.log" | head -n1)
rand() { openssl rand -hex 24; }
PG_SUPER=$(rand); PG_MIG=$(rand); PG_WEB=$(rand); PG_WORK=$(rand); PG_RO=$(rand)
umask 077
cat > "${WORK}/plain.env" <<EOF
SITE_ADDRESS=:80
ACME_EMAIL=ops@localhost
API_BASE_URL=http://127.0.0.1
APP_BASE_URL=http://127.0.0.1
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
VALKEY_PASSWORD=$(rand)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
TOKEN_PEPPER=$(openssl rand -base64 32)
DATA_ENCRYPTION_KEYS={"k1":"$(openssl rand -base64 32)"}
DATA_ENCRYPTION_ACTIVE_KID=k1
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=http://localhost:8088
SMTP_URL=smtp://mailpit:1025
EMAIL_FROM=gundam-tcg-hub <no-reply@localhost>
EOF
sops --encrypt --age "$RECIPIENT" --input-type dotenv --output-type dotenv \
  "${WORK}/plain.env" > "${ROOT}/secrets.sops.env"
rm -f "${WORK}/plain.env"
echo "encrypted to ${RECIPIENT}"

step "find the newest published release"
API_DIGEST=""; WEB_DIGEST=""
for sha in $(git log --format=%H -20 main); do
  API_DIGEST=$(docker buildx imagetools inspect "ghcr.io/trstncyphr007/gth-api:sha-${sha}" 2>/dev/null | awk '/^Digest:/ {print $2}')
  [ -n "$API_DIGEST" ] || continue
  WEB_DIGEST=$(docker buildx imagetools inspect "ghcr.io/trstncyphr007/gth-web:sha-${sha}" 2>/dev/null | awk '/^Digest:/ {print $2}')
  [ -n "$WEB_DIGEST" ] && { echo "release for ${sha:0:12}"; break; }
done
[ -n "$API_DIGEST" ] && [ -n "$WEB_DIGEST" ] || { echo "no published release found" >&2; exit 1; }
echo "api ${API_DIGEST}"
echo "web ${WEB_DIGEST}"

step "run the deploy script, unmodified"
bash infra/vps/deploy.sh "$ENVIRONMENT" "$API_DIGEST" "$WEB_DIGEST"

step "what a visitor gets"
for path in / /v1/games; do
  printf '%s  %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1${path}")" "$path"
done

step "what the deploy recorded"
cat "${ROOT}/last-good.env"

printf '\n\033[1;32mREHEARSAL PASSED\033[0m — the deploy path works end to end\n'
echo "Run with KEEP=1 to leave the stack up for inspection."
[ "${KEEP:-0}" = "1" ] && trap - EXIT && echo "left in ${WORK}"
exit 0
