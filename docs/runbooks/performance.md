# Runbook: Performance

**Last measured: 2026-09-23 — both promises met, with room to spare.**

Plan reference: FR-1.3 ("under 200 ms p95 on 10k cards"), §20 SLOs ("API p95 under 300 ms for
`/v1/cards/{id}/prices`"), §24 (k6 before launches).

Those numbers were written before there was anything to measure. The development catalog holds
**three** cards, at which everything is fast and every index looks unnecessary — so until now
both promises were untested.

```bash
pnpm db:seed-scale                 # 10,000 cards + 30 days of prices, ~4 seconds
bash scripts/measure-slos.sh       # 30s per scenario, exits non-zero if a promise is missed
```

The thresholds live in `perf/catalog.js` and **are** the promises, so a regression fails out
loud rather than being noticed by a visitor.

---

## Results (2026-09-23, workstation: WSL2, 16 vCPU, Postgres 17 in Docker)

| Catalog size        | `/v1/cards?q=` p95 | `/v1/cards/{id}/prices` p95 | Failures |
| ------------------- | ------------------ | --------------------------- | -------- |
| 10,000 (the figure) | **12.0 ms**        | **6.6 ms**                  | 0%       |
| 108,574 (ten times) | **77.7 ms**        | **6.0 ms**                  | 0%       |

Budgets: 200 ms and 300 ms. At the size the plan describes, search uses **6%** of its budget.

**Search is linear in catalog size** (about 7 ms per 10,000 cards); the price endpoint is flat,
because it is an indexed lookup whatever the table holds. Extrapolating the line, search meets
its 200 ms budget until roughly **280,000 cards** — more than twenty times the whole Gundam
card game, so this is not a problem waiting to happen. It is a number to re-measure if the
catalog ever covers several games.

One outlier is worth knowing about: at 108k the slowest search took 688 ms while p95 stayed at
78 ms. That is a single cold query, not a trend — but it is why the alerting watches p95 and a
human watches the maximum.

## What the measurement found

**The trigram index is not used by card search.** `cards_name_trgm_idx` exists for FR-1.3, and
the search query is `name ILIKE '%term%' OR number ILIKE '%term%'`. The `OR` against an
unindexed column makes the planner choose a sequential scan of the whole table:

```
Seq Scan on cards  (actual time=0.016..69.337 rows=1037)
  Filter: ((name ~~* '%Zaku Custom%') OR (number ~~* '%Zaku Custom%'))
```

Drop the `OR` and the index is used immediately (`Bitmap Index Scan on cards_name_trgm_idx`,
1.0 ms at 10k). **Adding a second trigram index on `number` does not help** — that was measured
too, and the planner still preferred the sequential scan at both sizes, because scanning ten
thousand narrow rows really is cheaper than two bitmap scans.

So the index is doing nothing for the query it was created for. `pg_stat_user_indexes` agrees:

| Index                           | Scans | Size  |
| ------------------------------- | ----- | ----- |
| `cards_set_number_key`          | 110k  | 6 MB  |
| `cards_pkey`                    | 109k  | 4 MB  |
| `cards_name_trgm_idx`           | **1** | 10 MB |
| `price_index_daily_pkey`        | **0** | 12 MB |
| `price_index_daily_history_idx` | **0** | 17 MB |

**Nothing has been dropped.** Those counts come from a workstation database whose traffic is
tests and seeding, which is not what real visitors do — an index unused here can be the one
that matters in production. The action is to re-read this table on the server after a month of
real traffic, and decide then. It is recorded here so that decision starts from evidence
instead of from scratch.

## Why the limiter has to be raised to measure

The per-IP limit is 120 requests a minute (SR-1.9) and this offers 40 a second, so a naive run
measures the limiter and reports a very fast 429. `measure-slos.sh` detects that and refuses to
produce a number, telling you to restart the API with `API_RATE_LIMIT_MAX` raised for the run.

The first attempt at this measurement did exactly that wrong: the old server kept the port, the
raised-limit one died unnoticed, and the run reported ~120 successes out of 1,200 — the limit,
dressed up as a result. The script's check exists because of that.

## When to re-measure

- Before a launch (plan §24)
- After changing a query on a hot path, or any index
- When the catalog grows by an order of magnitude — the numbers above are the baseline to
  compare against
- On the VPS once it exists: a workstation is not a 2-vCPU server, and only the shape of these
  numbers transfers, not the numbers

## Overlay fan-out (§24: 100 concurrent overlays)

```bash
bash scripts/measure-overlays.sh          # 100 streams across 20 breaks
STREAMS=400 API_RATE_LIMIT_RAISED=1 bash scripts/measure-overlays.sh
```

It creates its own breaks, opens the streams, logs one pull, times the arrival at every overlay
watching that break, then removes what it made. k6 cannot do server-sent events without a
custom build, and this needed to measure something k6 would not anyway: **how long a pull takes
to reach a viewer**.

| Overlays | Idle database load | Pull → overlay p95 | Refused | Cross-talk |
| -------- | ------------------ | ------------------ | ------- | ---------- |
| 100      | 106 tx/s           | **989 ms**         | 0       | 0          |
| 200      | 206 tx/s           | 968 ms             | 0       | 0          |
| 400      | 406 tx/s           | 938 ms             | 0       | 0          |

**Each overlay costs one database transaction per second whether or not anything is
happening.** Every connection polls on its own timer (`OVERLAY_POLL_MS = 1000`), so the
standing load is one query per viewer per second, perfectly linearly: a hundred viewers is
about a hundred transactions a second on a completely idle system.

Delivery is bounded by that same poll — about a second, near enough regardless of how many are
watching. AC-2.1 asks for "under 1 s locally" and this **meets it with no margin**: the latency
is the poll interval, not the work.

"Cross-talk" is the correctness check: no overlay was ever shown another break's pull, at any
size. Worth asserting under load, because a shared cache or a mixed-up key would show up
exactly here and nowhere in a single-stream test.

### Measuring more than ~100 from one machine needs the limiter raised

Every connection here comes from one address, so past about 120 the per-IP limit (SR-1.9)
refuses them — and 180 refusals look precisely like an overlay that cannot cope. In production
those connections arrive from as many machines as there are viewers. `measure-overlays.sh`
refuses to run the larger sizes until the limit is raised deliberately.

### The trade, if these numbers ever stop working

A shorter poll means faster overlays and proportionally more load; a longer one, the reverse.
The alternative is Postgres `LISTEN`/`NOTIFY`, which takes the idle cost to zero and delivers in
milliseconds — at the price of a second delivery mechanism to keep working. Not worth it at a
hundred viewers and a hundred transactions a second. It starts being worth it when a break
night regularly draws enough viewers for idle polling to be a visible fraction of a 2-vCPU
server, somewhere around five hundred (ADR-041).
