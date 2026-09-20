# ADR-018: How the price index is computed

- Status: Accepted (2026-09-21). Implements plan §12 (Phase 3), FR-3.1 and FR-3.2.

## Context

The index is the part of this project that has to be **defensible**. It gets published, people
will argue with it, and Phase 5 eventually prices real money against it. The threat is not
someone reading a price — prices are public — it is someone **moving** one (threat T7).

So the rules are deliberately dull, written down, and enforced in more than one place.

## Decisions

### A trimmed median, not a mean

Drop the top and bottom 10%, then take the middle. One absurd sale must not move the number.

Trimming starts at 10 observations: `floor(n × 0.1)` per end. With 3 observations, 10% is
0.3, and dropping one from each end would leave a single value being called a median. A trim
that discards most of a small sample is not a trim, it is a different statistic.

**p25 and p75 are published alongside**, so the spread is visible rather than hidden behind
one number, and **low/high come from the untrimmed set** — the point of showing a range is to
show what actually happened, including the ends the median ignores.

### Below three observations, publish nothing

"Insufficient data" is a real answer, and a more useful one than a median of two.

The floor counts **real observations, not the weighted expansion**. This distinction is not
academic: weighting a trusted source ×3 turns two sales into six numbers, and checking the
weighted list would let two sales publish as though they had cleared a bar of three. The
first implementation got this wrong and a database CHECK constraint caught it — which is why
the constraint exists as well as the code path.

### Sources are weighted by how well we know them

| Source                    | Weight | Why                                 |
| ------------------------- | ------ | ----------------------------------- |
| `break_pull`, `live_sale` | 3      | We watched it happen                |
| `ebay_api`, `walmart_api` | 2      | Official, but someone else's number |
| `user_report`             | 1      | Someone told us                     |

Weights are **integers**, and weighting works by repeating the observation rather than
multiplying it. A weighted median stays a real median that way; a float multiplier would
produce a number that is not any observed price.

### User reports count only after a human approves them

A report arrives unapproved and is invisible to the rollup. This is the control against T7,
and it is enforced twice: in the query layer, and by a row policy that refuses an insert
carrying `approved_at`.

**The sources we weight most are not reachable from a session at all.** A row policy
restricts the web role to `source = 'user_report'`, as itself. A compromised web process
cannot claim its number came from a break we never ran.

Per-account cap of 20 pending reports, so one account cannot bury the moderation queue.

### Recomputed nightly, never updated in place

A trimmed median is order-dependent — it cannot be nudged by adding one number to yesterday's
answer. Recomputing is cheap at this scale and means a late-arriving or newly-approved
observation is picked up on the next pass instead of being lost.

Re-running is therefore safe, and the rollup is idempotent.

### Currencies are never mixed

A median across USD and CAD is a number with no meaning. Currency is part of the index's
unique key — it was missing from the first version, and the effect was that whichever
currency the rollup wrote second silently replaced the other.

## Deviation from the plan: no monthly partitioning

Plan §7 calls for `price_observations` to be partitioned monthly. It is a plain table with
indexes.

Partitioning earns its keep when old data has to be dropped cheaply or an index stops fitting
in memory. A card game's price observations are thousands a month, not millions, and Postgres
is entirely comfortable there. Partitioning now would be machinery maintained for a problem we
do not have.

It is not free to change later — converting a populated table means a rewrite — so the trigger
is written down in the schema: partition by `observed_at` if the table passes ~50M rows, or if
a retention policy appears. Both are far off and both are visible well in advance.

## Consequences

- Every pull logged in Phase 2 becomes an observation, approved on arrival because we watched
  it. That is what makes the break calculator able to fill in values instead of the creator
  typing them.
- Ingestion is idempotent on `break_pull_id`, so re-running cannot inflate the sample — which
  matters most for the source we weight most heavily.
- The methodology has to be published at `/methodology` before the index is. A benchmark
  nobody can audit is a benchmark nobody should trust.
