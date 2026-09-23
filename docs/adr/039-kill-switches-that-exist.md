# ADR-039: The kill switches the runbook already promised

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** §22, SR-X.21

## Context

`docs/runbooks/incident.md` — the one document read under pressure, by one person, while
something is actively going wrong — has always said "contain before you investigate" and
listed three switches to pull. None of them existed. There was no flag table, no flag code,
nothing.

This is the same failure as ADR-036 (units that invoked a service that did not exist) and
ADR-034's `security.txt` reasoning: a document describing a control that is not there is worse
than one that admits the gap, because it is believed exactly when there is no time to check.

## Decision

### Absent means on, and off is remembered

Only overrides are stored. The table is empty in normal operation, so anything that goes wrong
with reading it — no row, no table, no database — leaves the site **working** rather than
dark. The reader keeps its last known answer when a read throws, and defaults to "everything
enabled" before its first successful one. A database wobble must not be able to switch the
site off by itself; the switches exist for a person to pull.

Turning something back on sets the row to true rather than deleting it, and **no role has
DELETE**. "The API was off for two hours, because X, flipped by Y" is not erasable through the
application.

### It must not lock the operator out

Switching off the public API leaves three things up on purpose: **sign-in**, **the admin
console**, and **`/healthz`**. The first two because an admin has to be able to get in and turn
it back on — a switch that shuts the door on the room it lives in is a trap, not a control.
The third because a dark health check tells the orchestrator the container is broken, and it
would be restarted, repeatedly, while somebody is deliberately holding it closed.

A test asserts all three, because this is exactly the property that is discovered to be
missing at the worst possible moment.

### Each switch stops as little as possible

`alerts.enabled` stops alerts being **sent**; restocks are still recorded, because turning off
alerting during an incident must not also make the shop's stock history wrong. `api.public.
enabled` answers **503 with `Retry-After`** — the service exists and is coming back, which is
what caches and clients need to hear, unlike 404 or 403. `scanner.ingest.enabled` refuses
reports without revoking anybody's key, so the scanner backs off instead of concluding its
credentials are bad.

Per-retailer scanning was already switchable through `retailers.enabled`, so the runbook now
points there instead of promising a per-retailer flag.

### Ten seconds of staleness, and one read per expiry

Asking the database on every request, to answer "no" a few times a year, is the wrong trade.
The reader caches for ten seconds and coalesces concurrent misses into a single query. An
incident where ten more seconds of traffic genuinely matters is one where the answer is
`docker compose stop`, not a flag.

### The watchdog nags

A switch is pulled in a hurry and turned back on when somebody remembers. So the watchdog
(ADR-038) reports any switch still off once a day, quoting the reason typed when it was
pulled. That turns "we switched alerts off during Tuesday's incident" into something noticed
on Wednesday rather than in three weeks.

## Consequences

- The incident runbook now describes controls that exist, with the page to click.
- **A recurring bug is now impossible rather than repeatedly fixed.** `scripts/check-exec-bits.sh`
  runs in CI and fails when a committed script has a shebang and is not executable — a
  Windows-side edit silently drops the bit, and it had been fixed by hand three times. It
  immediately found four more, including `infra/vps/deploy.sh`.
- Uploads and checkout switches from §22 are not here: neither feature exists yet, and a
  switch for nothing is decoration. They go in with Phase 5.
- No Valkey. The plan suggested caching flags there; an in-process cache with a ten-second
  window needs no second system and behaves identically for a single instance. It becomes
  worth revisiting when there is more than one.
