# ADR-041: The overlay keeps polling, and here is what that costs

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** FR-2.3, SR-2.4, AC-2.1, §24

## Context

The OBS overlay is a server-sent event stream, and each open connection polls the database on
its own one-second timer for new pulls. That is the simplest thing that works, and it was
never measured: §24 asks for a hundred concurrent overlays and nothing had ever held two open
at once outside a unit test.

ADR-040 measured the catalog. This measures the part of the system that runs **during** the
event it exists for — a break night, when being wrong is most visible.

## Decision

### Measure it, including the thing that is easy not to check

`scripts/measure-overlays.sh` opens the streams, logs a pull and times its arrival at every
overlay watching that break. Results on the workstation:

| Overlays | Idle database load | Pull → overlay p95 | Refused | Cross-talk |
| -------- | ------------------ | ------------------ | ------- | ---------- |
| 100      | 106 tx/s           | 989 ms             | 0       | 0          |
| 200      | 206 tx/s           | 968 ms             | 0       | 0          |
| 400      | 406 tx/s           | 938 ms             | 0       | 0          |

The last column is the one that is easy not to check. Under load, a shared cache or a mixed-up
key shows up as one creator's overlay displaying another's pull — a privacy failure that no
single-stream test can see. It is asserted at every size.

### Keep the polling

One transaction per viewer per second, with nothing happening at all. At the plan's hundred
overlays that is about a hundred transactions a second, which a 2-vCPU server will not notice.
Delivery is a second, which meets AC-2.1 ("under 1 s locally") — **with no margin**, because
the latency _is_ the poll interval.

The alternative is `LISTEN`/`NOTIFY`: idle cost to zero, delivery in milliseconds, and a second
delivery mechanism to keep working, debug and reason about during the event it matters most
in. That trade is not worth making at a hundred viewers.

**The trigger to revisit is written down** rather than left to instinct: around five hundred
concurrent overlays, where idle polling becomes a visible fraction of a small server. The
measurement script is how that gets checked rather than guessed.

## Consequences

- §24's SSE fan-out case is measured, and `docs/runbooks/performance.md` carries the numbers
  and the trade.
- AC-2.1 passes with no headroom. Shortening the poll would buy latency at exactly
  proportional cost; that is a knob, not a fix, and it is documented as such.
- The measurement is bounded by our own rate limiter when run from a single machine: past
  about 120 streams the per-IP limit refuses them, which looks exactly like an overlay failure.
  The script now says so and requires the limit to be raised deliberately — the second time
  today a load test measured a control instead of the thing it was pointed at (ADR-040).
