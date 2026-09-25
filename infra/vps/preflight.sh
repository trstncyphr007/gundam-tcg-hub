#!/usr/bin/env bash
# Installed on the VPS at /srv/gth/preflight.sh (root-owned, 0750).
#
#   sudo /srv/gth/preflight.sh <staging|production> [<api-digest> <web-digest>]
#
# Everything a first deploy needs, checked before a deploy is attempted, so the first one is a
# formality rather than an investigation. Changes nothing: it reads, decrypts secrets into
# tmpfs for a moment, and removes them again.
#
# Each line is PASS, FAIL or SKIP (a check that cannot run here, said so rather than passed).
# Exit status is non-zero if anything FAILed.
#
# Paths can be overridden, for exercising this off the server: GTH_ROOT, AGE_KEY_FILE.
set -uo pipefail

ENVIRONMENT="${1:?usage: preflight.sh <staging|production> [<api-digest> <web-digest>]}"
API_DIGEST="${2:-}"
WEB_DIGEST="${3:-}"
case "$ENVIRONMENT" in
  staging | production) ;;
  *) echo "unknown environment: $ENVIRONMENT" >&2; exit 2 ;;
esac

GTH_ROOT="${GTH_ROOT:-/srv/gth}"
ROOT="${GTH_ROOT}/${ENVIRONMENT}"
AGE_KEY_FILE="${AGE_KEY_FILE:-/root/.config/sops/age/keys.txt}"
OWNER="trstncyphr007"
REPO="trstncyphr007/gundam-tcg-hub"
COMPOSE_FILE="${ROOT}/docker-compose.prod.yml"

passes=0; fails=0; skips=0
pass() { printf 'PASS  %s\n' "$*"; passes=$((passes + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }
skip() { printf 'SKIP  %s\n' "$*"; skips=$((skips + 1)); }
have() { command -v "$1" >/dev/null 2>&1; }
is_root() { [ "$(id -u)" -eq 0 ]; }

echo "== tools"
for tool in docker cosign sops curl; do
  if have "$tool"; then pass "$tool installed"; else fail "$tool is not installed"; fi
done
if docker compose version >/dev/null 2>&1; then pass 'docker compose available'; else fail 'docker compose is not available'; fi
if docker info >/dev/null 2>&1; then pass 'docker daemon reachable'; else fail 'docker daemon is not reachable'; fi

echo "== host"
if is_root && have sshd; then
  sshd_config=$(sshd -T 2>/dev/null)
  grep -qx 'passwordauthentication no' <<<"$sshd_config" && pass 'SSH: passwords refused' || fail 'SSH: password authentication is not off'
  grep -qx 'permitrootlogin no' <<<"$sshd_config" && pass 'SSH: root login refused' || fail 'SSH: root login is not refused'
else
  skip 'SSH hardening (needs root and sshd)'
fi
if is_root && have ufw; then
  ufw status | grep -q '^Status: active' && pass 'firewall active' || fail 'ufw is not active'
else
  skip 'firewall (needs root and ufw)'
fi
if have tailscale; then
  tailscale status >/dev/null 2>&1 && pass 'Tailscale up' || fail 'Tailscale is not connected'
else
  skip 'Tailscale (not installed here)'
fi
if have timedatectl; then
  # Keyless signatures are short-lived certificates: a clock that has drifted makes valid
  # signatures fail to verify, and looks like tampering.
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] \
    && pass 'clock synchronised' || fail 'clock is not NTP-synchronised (signature checks depend on it)'
else
  skip 'clock synchronisation (no timedatectl)'
fi
if have findmnt; then
  # Secrets are decrypted to /run/gth; that must be memory, never disk.
  [ "$(findmnt -n -o FSTYPE --target /run)" = tmpfs ] && pass '/run is tmpfs' || fail '/run is not tmpfs — decrypted secrets would touch disk'
else
  skip '/run filesystem (no findmnt)'
fi
if docker info >/dev/null 2>&1; then
  docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
  free_gb=$(df -BG --output=avail "${docker_root:-/nonexistent}" 2>/dev/null | tail -n 1 | tr -dc '0-9')
  if [ -z "$free_gb" ]; then
    # Docker's data directory is not on this filesystem (e.g. Docker Desktop). Unknown is not
    # "full"; say so rather than invent a shortage.
    skip "disk space (cannot see ${docker_root:-the Docker data directory} from here)"
  elif [ "$free_gb" -ge 10 ]; then
    pass "disk: ${free_gb} GB free for images"
  else
    fail "disk: only ${free_gb} GB free for images (want ≥ 10)"
  fi
fi

echo "== files"
for f in docker-compose.prod.yml Caddyfile secrets.sops.env; do
  if [ -s "${ROOT}/${f}" ]; then pass "${ROOT}/${f}"; else fail "${ROOT}/${f} is missing or empty"; fi
done
[ -x "${GTH_ROOT}/deploy.sh" ] && pass "${GTH_ROOT}/deploy.sh is executable" || fail "${GTH_ROOT}/deploy.sh is missing or not executable"

echo "== scheduled jobs"
# The retention job deletes personal data on a clock (ADR-035), so "is it scheduled?" is a
# question worth answering before a deploy rather than after a subject access request.
#
# This list drifted: it was written with three timers and stayed that way while `watchdog` and
# `alert-retry` were added, so the one check that runs on launch day would have reported a clean
# bill of health on a host where the dead man's switch itself had no timer. It is kept explicit
# — enumerating whatever is installed could not detect a missing one — and `scripts/check-jobs.sh`
# now fails CI if it stops matching `jobs_schedule`.
if have systemctl && [ -d /run/systemd/system ]; then
  for unit in gth-rollup.timer gth-retention.timer gth-watchdog.timer gth-alert-retry.timer \
    gth-complete-orders.timer gth-backup.timer; do
    if systemctl is-enabled "$unit" >/dev/null 2>&1; then
      pass "${unit} enabled"
    else
      fail "${unit} is not enabled — run the ansible playbook (roles/jobs)"
    fi
  done
else
  skip 'job timers (no systemd here)'
fi
# A failed job that alerts nobody is a job nobody knows stopped.
if [ -r /etc/gth/ops.env ] && grep -q '^DISCORD_OPS_WEBHOOK_URL=.\+' /etc/gth/ops.env; then
  pass 'failures have somewhere to go (DISCORD_OPS_WEBHOOK_URL)'
elif [ -r /etc/gth/restic.env ] && grep -q '^DISCORD_OPS_WEBHOOK_URL=.\+' /etc/gth/restic.env; then
  pass 'failures have somewhere to go (DISCORD_OPS_WEBHOOK_URL, from restic.env)'
elif is_root; then
  fail 'no DISCORD_OPS_WEBHOOK_URL in /etc/gth/ops.env — a failed job or backup would alert nobody'
else
  skip 'ops alert configuration (needs root to read /etc/gth)'
fi
# The timer being enabled says the backup will *run*, not that it has anywhere to write. The
# install template in backups.md is full of angle-bracket placeholders, so "the file exists" is
# not the question either.
if ! is_root; then
  skip 'backup credentials (needs root to read /etc/gth)'
elif [ ! -r /etc/gth/restic.env ]; then
  fail 'no /etc/gth/restic.env — the backup timer would run and save nothing (backups.md)'
elif grep -qE '^(RESTIC_REPOSITORY|RESTIC_PASSWORD)=.*<' /etc/gth/restic.env; then
  fail '/etc/gth/restic.env still has placeholders from the install template'
elif grep -q '^RESTIC_REPOSITORY=.\+' /etc/gth/restic.env &&
  grep -q '^RESTIC_PASSWORD=.\+' /etc/gth/restic.env; then
  pass 'backups have a repository and a password'
else
  fail 'RESTIC_REPOSITORY or RESTIC_PASSWORD is missing from /etc/gth/restic.env'
fi

echo "== age key"
if [ -f "$AGE_KEY_FILE" ]; then
  mode=$(stat -c '%a' "$AGE_KEY_FILE")
  case "$mode" in 400 | 600) pass "age key present, mode ${mode}" ;; *) fail "age key is mode ${mode}; want 400" ;; esac
  if is_root; then
    [ "$(stat -c '%U' "$AGE_KEY_FILE")" = root ] && pass 'age key owned by root' || fail 'age key is not owned by root'
  fi
else
  fail "no age key at ${AGE_KEY_FILE}"
fi

echo "== secrets"
if [ -s "${ROOT}/secrets.sops.env" ] && [ -f "$AGE_KEY_FILE" ] && have sops; then
  tmpdir=/run/gth
  install -d -m 0700 "$tmpdir" 2>/dev/null || tmpdir=$(mktemp -d)
  env_file=$(umask 077 && mktemp "${tmpdir}/preflight.XXXXXX")
  trap 'rm -f "$env_file"' EXIT
  if SOPS_AGE_KEY_FILE="$AGE_KEY_FILE" sops -d --input-type dotenv --output-type dotenv \
       "${ROOT}/secrets.sops.env" >"$env_file" 2>/dev/null; then
    pass 'secrets decrypt with this host key'

    value_of() { grep -E "^$1=" "$env_file" | tail -n 1 | cut -d= -f2- | sed -E "s/^['\"](.*)['\"]\$/\1/"; }

    # Everything compose insists on (`${NAME:?}`), except the two images deploy.sh adds.
    missing=()
    while read -r name; do
      case "$name" in API_IMAGE | WEB_IMAGE) continue ;; esac
      [ -n "$(value_of "$name")" ] || missing+=("$name")
    done < <(grep -oE '\$\{[A-Z0-9_]+:\?' "$COMPOSE_FILE" 2>/dev/null | sed -E 's/\$\{([A-Z0-9_]+):\?/\1/' | sort -u)
    if [ "${#missing[@]}" -eq 0 ]; then pass 'every required setting is present'; else fail "missing settings: ${missing[*]}"; fi

    # Placeholders from .env.example or the runbook, left in by hand. Names only — never values.
    placeholders=$(grep -nE '=(.*)(generated-by-env-init|dev-only-insecure|<domain>|<openssl|<provider>|<you@|change-?me)' "$env_file" | cut -d= -f1 | cut -d: -f2 | sort -u | tr '\n' ' ')
    if [ -z "$placeholders" ]; then pass 'no placeholder values'; else fail "placeholder values in: ${placeholders}"; fi

    if [ "$ENVIRONMENT" = production ]; then
      rp=$(value_of WEBAUTHN_RP_ID)
      if [ -z "$rp" ] || [ "$rp" = localhost ] || [[ "$rp" =~ ^[0-9.:]+$ ]]; then
        fail "WEBAUTHN_RP_ID is '${rp:-unset}' — production needs the real domain, and it cannot change later"
      else
        pass "passkeys bound to ${rp}"
      fi
      [[ "$(value_of WEBAUTHN_ORIGIN)" == https://* ]] && pass 'WEBAUTHN_ORIGIN is https' || fail 'WEBAUTHN_ORIGIN is not https'
      [[ "$(value_of SITE_ADDRESS)" == :* || -z "$(value_of SITE_ADDRESS)" ]] \
        && fail 'SITE_ADDRESS is not a domain — production needs one for TLS' || pass "site address $(value_of SITE_ADDRESS)"
    fi

    if API_IMAGE=preflight WEB_IMAGE=preflight docker compose -f "$COMPOSE_FILE" --env-file "$env_file" config -q 2>/tmp/preflight-compose.err; then
      pass 'compose accepts the configuration'
    else
      fail "compose rejects the configuration: $(head -n 1 /tmp/preflight-compose.err)"
    fi
    rm -f /tmp/preflight-compose.err
  else
    fail 'secrets do not decrypt with this host key (was the file encrypted to it?)'
  fi
else
  skip 'secret checks (need the secrets file, the age key and sops)'
fi

echo "== images"
# Public packages (ADR-032): anyone may read them, so the server needs no credential. If this
# fails the packages have gone private again, and every pull below would too.
for img in gth-api gth-web; do
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:${OWNER}/${img}:pull" 2>/dev/null | sed -E 's/.*"token":"([^"]+)".*/\1/')
  code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token:-none}" \
    "https://ghcr.io/v2/${OWNER}/${img}/tags/list" 2>/dev/null)
  [ "$code" = 200 ] && pass "${img} is publicly readable" || fail "${img} is not publicly readable (HTTP ${code}) — see runbooks/deploy.md, Registry access"
done
if [ -n "$API_DIGEST" ] && [ -n "$WEB_DIGEST" ] && have cosign; then
  for pair in "api:${API_DIGEST}" "web:${WEB_DIGEST}"; do
    name="${pair%%:*}"; digest="${pair#*:}"
    if cosign verify "ghcr.io/${OWNER}/gth-${name}@${digest}" \
         --certificate-identity-regexp "^https://github.com/${REPO}/.github/workflows/release.yml@refs/heads/main$" \
         --certificate-oidc-issuer https://token.actions.githubusercontent.com >/dev/null 2>&1; then
      pass "gth-${name}@${digest:7:12}… signed by release.yml on main"
    else
      fail "gth-${name}@${digest:7:12}… does not verify — deploy.sh would refuse it"
    fi
  done
else
  skip 'signature check (pass the api and web digests to include it)'
fi

echo
printf '%s passed, %s failed, %s skipped\n' "$passes" "$fails" "$skips"
[ "$fails" -eq 0 ]
