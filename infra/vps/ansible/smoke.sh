#!/usr/bin/env bash
# Run the playbook against a throwaway Ubuntu container.
#
# **What this does and does not prove.** It exercises the package, file, template and
# repository tasks against a real Ubuntu 24.04 — enough to catch a typo, a bad template, a
# wrong package name or a task that is not idempotent. It does *not* prove the systemd,
# sysctl, ufw or Tailscale work, because a container has none of those; those tasks are
# skipped by `gth_container_smoke` and remain unexercised until there is a host.
#
# It is still worth running: everything it skips is configuration, and everything it covers
# is the part that historically breaks on someone else's machine.
set -euo pipefail

NAME=gth-ansible-smoke
IMAGE=ubuntu:24.04
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" "$IMAGE" sleep infinity >/dev/null
# Ansible needs python3 and sudo in the target; a bare Ubuntu image has neither.
docker exec "$NAME" bash -c 'apt-get update -qq && apt-get install -y -qq python3 sudo >/dev/null'
# `sshd -t` refuses to validate a config without its privilege-separation directory, which
# systemd would normally create. The ssh role validates before installing anything — that
# check is worth keeping, so the harness provides what it needs instead of dropping it.
docker exec "$NAME" mkdir -p /run/sshd

# The connection plugin by its full name: ansible-core 2.21 no longer resolves the short
# `docker`. It comes from community.docker, which only this harness needs — install it with
#   ansible-galaxy collection install community.docker
cat > /tmp/gth-smoke-inventory.ini <<EOF
[vps]
${NAME} ansible_connection=community.docker.docker ansible_python_interpreter=/usr/bin/python3
EOF

# shellcheck disable=SC2120  # "$@" is there for running this by hand with extra ansible flags.
run() {
  ansible-playbook -i /tmp/gth-smoke-inventory.ini "${HERE}/site.yml" \
    -e gth_container_smoke=true \
    --skip-tags crowdsec,docker \
    "$@"
}

echo "== first run =="
run

echo
echo "== second run (must report no changes: that is what idempotent means) =="
run | tee /tmp/gth-smoke-second.log
if grep -qE 'changed=[1-9]' /tmp/gth-smoke-second.log; then
  echo "NOT IDEMPOTENT: the second run changed something" >&2
  exit 1
fi
echo "idempotent"
