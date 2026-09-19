#!/usr/bin/env bash
# pre-push guard: refuse direct pushes to main (ADR-014 compensating control for
# GitHub Free private repos, which have no branch protection).
# Override deliberately with: ALLOW_MAIN_PUSH=1 git push
set -euo pipefail

if [ "${ALLOW_MAIN_PUSH:-0}" = "1" ]; then
  exit 0
fi

# git feeds "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin.
while read -r _local_ref _local_sha remote_ref _remote_sha; do
  if [ "$remote_ref" = "refs/heads/main" ]; then
    echo "✋ Direct push to main is blocked. Push a branch and open a PR:"
    echo "   git switch -c feat/<name> && git push -u origin HEAD"
    echo "   (override only if you really mean it: ALLOW_MAIN_PUSH=1 git push)"
    exit 1
  fi
done
exit 0
