# ADR-014: Compensating controls for GitHub Free + private repo

- Status: Accepted (2026-09-20)
- Context: On GitHub Free, a private repo gets none of the following:
  - branch protection or rulesets
  - secret scanning or push protection
  - CodeQL or code-scanning uploads
  - the dependency-review action
  - private deployment environments with reviewers

  The owner chose to stay private and on Free.

- Decision:
  | Missing feature                   | Compensating control                                                                   |
  | --------------------------------- | -------------------------------------------------------------------------------------- |
  | Secret scanning + push protection | gitleaks pre-commit (lefthook) + gitleaks over full history in CI                      |
  | CodeQL                            | Semgrep (registry + `.semgrep.yml`) + type-aware ESLint security rules, blocking in CI |
  | Dependency review                 | OSV-Scanner + `pnpm audit` + license allowlist, blocking in CI                         |
  | Code-scanning UI                  | SARIF/SBOM uploaded as workflow artifacts                                              |
  | Branch protection                 | lefthook pre-push guard on `main` + ADR-012 merge discipline                           |
  | Environment reviewers             | Prod deploy is a manual `workflow_dispatch` (deploy track)                             |
  | (free, kept on)                   | Dependabot alerts + security updates + version updates                                 |
- Consequences: Local hooks can be bypassed with `--no-verify`, but CI re-runs every gate.
  Upgrade path: make the repo public, or move it to an org on Team with GitHub Secret
  Protection / Code Security, which restores SR-0.1, SR-0.2 and SR-0.4.
