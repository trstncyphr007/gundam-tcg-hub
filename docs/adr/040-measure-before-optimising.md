# ADR-040: Measure the speed promises, and leave the index alone

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** FR-1.3, §20 (SLOs), §24 (performance testing)

## Context

The plan promises card search "under 200 ms p95 on **10k cards**" and a price endpoint under
300 ms. The development catalog holds three cards. Both promises were therefore untested, and
"fast enough" was a belief.

## Decision

### The promises become a check that can fail

`pnpm db:seed-scale` fills the catalog to the size the plan talks about — ten thousand cards
of a realistic _shape_, sharing words and prefixes so a search has to discriminate rather than
match everything. `bash scripts/measure-slos.sh` then drives the API with k6, and the
thresholds in `perf/catalog.js` **are** the promises: a regression exits non-zero.

Measured through the API rather than against the database, because a 6 ms query behind a
300 ms endpoint is entirely possible, and only one of those is what a visitor waits for.

### The answer is "there is nothing to fix"

| Catalog | search p95 | prices p95 |
| ------- | ---------- | ---------- |
| 10,000  | 12.0 ms    | 6.6 ms     |
| 108,574 | 77.7 ms    | 6.0 ms     |

Search is linear in table size, about 7 ms per 10,000 cards, and holds its 200 ms budget to
roughly 280,000 cards — twenty times the whole game. The price endpoint is flat because it is
an indexed lookup.

### The trigram index is not used, and stays anyway

`cards_name_trgm_idx` was created for FR-1.3. The search is
`name ILIKE '%term%' OR number ILIKE '%term%'`, and the `OR` against an unindexed column makes
the planner scan the table. Remove the `OR` and the index is used at once. **Adding a matching
index on `number` was measured and changed nothing** — the planner still preferred the scan,
because ten thousand narrow rows really are cheaper than two bitmap scans.

So there were three options: add an index that measurably does not help, rewrite the search to
use the index it has, or leave it. Rewriting would change search _semantics_ — what matches a
card number — which is a product decision made on a performance pretext, at a size where the
current answer uses 6% of its budget. The index stays because dropping it is equally
unjustified: it costs 10 MB and some write time, and it becomes the right index the moment the
query changes or the catalog grows.

What changes is that this is now **written down with its numbers**, rather than being
rediscovered by whoever next wonders why search is slow.

### Nothing is dropped on the strength of a workstation

`pg_stat_user_indexes` shows three indexes with almost no scans, 39 MB between them. They are
listed in `docs/runbooks/performance.md` and **not touched**: the traffic on this database is
tests and seeding, and an index unused here can be the one that matters in production. The
decision is deferred to a month of real traffic, with the evidence already gathered.

## Consequences

- §24's performance testing exists and is repeatable. The SSE fan-out case (100 overlays) is
  still unmeasured and is named as such in the runbook.
- The limiter must be raised to measure, because 120 requests a minute against 40 a second
  measures the limiter. The script refuses to report a number when it sees a 429 — the first
  run of this produced exactly that false result, with the old server still holding the port
  and a very fast 429 masquerading as a good p95.
- The baseline is a workstation. Only the _shape_ transfers to a 2-vCPU VPS; the runbook says
  to re-measure there.
