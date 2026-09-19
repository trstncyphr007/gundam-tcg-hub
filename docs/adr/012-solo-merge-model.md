# ADR-012: Solo merge model

- Status: Accepted (2026-09-20)
- Context: One maintainer. GitHub can't require a second approver, and on the Free plan it can't
  enforce status checks on a private repo either (ADR-014).
- Decision: All changes go through a branch + PR. The author merges their own PR **only after
  every CI job is green**. Squash merge, with the PR title as a Conventional Commit. Direct pushes
  to `main` are blocked locally by the lefthook pre-push guard (`ALLOW_MAIN_PUSH=1` is reserved
  for the initial commit and emergencies, and each use is noted in the PR or commit body).
- Consequences: Discipline, not the platform, enforces merge gates until the repo is public or
  on a paid plan. Revisit when a second contributor joins (require a CODEOWNERS review).
