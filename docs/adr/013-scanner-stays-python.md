# ADR-013: Scanner stays Python, in its own repo

- Status: Accepted (2026-09-20). Supersedes plan D5 and amends ADR-001.
- Context: The restock/price scanner already exists and works:
  - `trstncyphr007/gundam-scanner`, Python
  - about 20 sources
  - Docker and systemd timers
  - a pytest suite

  The plan had assumed a TypeScript rebuild.

- Decision: Keep it in Python, in its own repo. This monorepo integrates with it through a
  data contract (scanner results written to Postgres or pushed to a queue), defined in Phase 1.
- Consequences:
  - Two toolchains. The scanner repo needs its own CI gates: ruff, bandit, pip-audit, pytest,
    gitleaks, trivy, hadolint.
  - Several scanner sources scrape HTML (Amazon, Walmart, TCGplayer, eBay). Each needs a ToS and
    robots review in Phase 1 (plan §23), preferring the official-API sources (`walmart_api`,
    `ebay_api`).
  - A gitleaks scan of the full scanner history (2026-09-20) found no leaks.
