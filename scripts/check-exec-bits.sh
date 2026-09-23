#!/usr/bin/env bash
# Every committed script with a shebang must be executable.
#
#   bash scripts/check-exec-bits.sh
#
# This exists because it kept happening: a shell script edited from a Windows editor comes
# back into git as mode 100644, and nothing notices until the file is run on a server —
# `permission denied`, on the deploy or the preflight, at the worst moment. It has been fixed
# by hand three times, which is two more than any recurring problem deserves.
set -euo pipefail
cd "$(dirname "$0")/.."

bad=()
while IFS=$'\t' read -r mode path; do
  # Only files git is tracking, and only ones that claim to be programs.
  [ -f "$path" ] || continue
  head -c 2 "$path" 2>/dev/null | grep -q '^#!' || continue
  [ "$mode" = "100755" ] || bad+=("$path")
done < <(git ls-files -s | awk '{print $1 "\t" $4}')

if [ ${#bad[@]} -gt 0 ]; then
  echo "These committed scripts start with a shebang but are not executable:" >&2
  printf '  %s\n' "${bad[@]}" >&2
  echo >&2
  echo "Fix with:" >&2
  printf '  git update-index --chmod=+x %s\n' "${bad[@]}" >&2
  exit 1
fi

echo "exec bits: all shebang scripts are executable"
