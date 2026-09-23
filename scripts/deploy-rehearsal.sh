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

step "find two published releases"
# Two, because rolling back to the release you are already running proves nothing.
RELEASES=()
for sha in $(git log --format=%H -25 main); do
  api=$(docker buildx imagetools inspect "ghcr.io/trstncyphr007/gth-api:sha-${sha}" 2>/dev/null | awk '/^Digest:/ {print $2}')
  [ -n "$api" ] || continue
  web=$(docker buildx imagetools inspect "ghcr.io/trstncyphr007/gth-web:sha-${sha}" 2>/dev/null | awk '/^Digest:/ {print $2}')
  [ -n "$web" ] || continue
  RELEASES+=("${sha} ${api} ${web}")
  echo "release ${sha:0:12}"
  [ "${#RELEASES[@]}" -eq 2 ] && break
done
[ "${#RELEASES[@]}" -ge 1 ] || { echo "no published release found" >&2; exit 1; }

# shellcheck disable=SC2206  # deliberately splitting the three fields
NEWER=(${RELEASES[0]})
OLDER=("${NEWER[@]}")
[ "${#RELEASES[@]}" -eq 2 ] && { read -ra OLDER <<< "${RELEASES[1]}"; }

step "deploy the older release (this is the one a rollback must return to)"
bash infra/vps/deploy.sh "$ENVIRONMENT" "${OLDER[1]}" "${OLDER[2]}"

step "what a visitor gets"
for path in / /v1/games; do
  printf '%s  %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1${path}")" "$path"
done

step "what the deploy recorded"
cat "${ROOT}/last-good.env"

# --------------------------------------------------------------------------- #
# The half that only ever runs when something is already wrong.
#
# Breaking it realistically matters: a release that cannot start would be caught by the
# healthcheck, but a release that starts perfectly and cannot be *reached* is the nastier
# case, and it is the one this project has already walked into once (SITE_ADDRESS must be a
# domain or :80 — see runbooks/vps-setup.md).
step "break the next release the way a bad setting does, and deploy it"
sops -d "${ROOT}/secrets.sops.env" > "${WORK}/broken.env"
sed -i 's|^SITE_ADDRESS=.*|SITE_ADDRESS=:8088|' "${WORK}/broken.env"
sops --encrypt --age "$RECIPIENT" --input-type dotenv --output-type dotenv \
  "${WORK}/broken.env" > "${ROOT}/secrets.sops.env"
rm -f "${WORK}/broken.env"

set +e
bash infra/vps/deploy.sh "$ENVIRONMENT" "${NEWER[1]}" "${NEWER[2]}"
DEPLOY_STATUS=$?
set -e

step "did it roll back?"
[ "$DEPLOY_STATUS" -ne 0 ] || { echo "the deploy reported success on a broken release" >&2; exit 1; }
echo "deploy exited ${DEPLOY_STATUS} (non-zero, as it must)"

recorded=$(grep -E '^API_IMAGE=' "${ROOT}/last-good.env" | cut -d= -f2-)
running=$(docker inspect "gth-${ENVIRONMENT}-api-1" --format '{{.Config.Image}}')
echo "last-good still: ${recorded##*@}"
echo "actually running: ${running##*@}"
[ "$recorded" = "ghcr.io/trstncyphr007/gth-api@${OLDER[1]}" ] || {
  echo "last-good.env was overwritten by a failed deploy" >&2; exit 1; }
[ "$running" = "$recorded" ] || { echo "the running image is not the rolled-back one" >&2; exit 1; }

printf '\n\033[1;32mREHEARSAL PASSED\033[0m — deploy works, and a failed release rolls back\n'
cat <<'NOTE'

One thing the rollback deliberately does not do: it restores the previous *images*, not the
previous *secrets*. The broken setting above is still in place afterwards, so the site is
still unreachable until somebody fixes it — which is correct (nobody wants a deploy silently
reverting a secret) but is worth knowing at the moment it happens.
NOTE
echo "Run with KEEP=1 to leave the stack up for inspection."
[ "${KEEP:-0}" = "1" ] && trap - EXIT && echo "left in ${WORK}"
exit 0
