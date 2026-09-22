# ADR-033: The operations dashboard judges the scanner by its reports

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** FR-1.12, §20

## Context

FR-1.12 asks for an admin dashboard: scanner health, queue depth and alert delivery. It was
the last unchecked Phase 1 item. The questions it has to answer are the ones an operator asks
first on a live server. Is the scanner still reporting? Are restocks being found? Are alerts
going out, and if not, why?

The scanner is a separate Python service (ADR-013) with its own circuit breakers and
schedules, none of which this database can see.

## Decision

### Health is what the scanner has reported, not what it believes

A listing is **stale** when its latest stock snapshot is older than **twice its retailer's
minimum interval**. It's **never checked** when it has no snapshot at all. Twice, because the
scanner adds ±20% jitter to every interval (FR-1.6): one jitter late is normal, a whole
interval late is not.

This deliberately ignores the scanner's own view. A scanner that thinks it is healthy while
its reports stopped arriving is exactly the failure to catch, and the database is the one
place both halves of the system agree on.

Paused retailers are shown with their counts but left out of the "needs attention" list.
Nobody should be paged for a retailer an admin switched off.

### Queue depth is the delivery backlog

Pending deliveries, and the age of the oldest one. A backlog older than fifteen minutes is
called out as "deliveries have stopped moving": a queue that is merely busy drains, one that
is stuck gets older.

### Failures are grouped by reason, and name nobody

Delivery failures from the last seven days are grouped by `last_error`, which is written
without recipient addresses (SR-X.20). The whole summary is aggregate; a test asserts that no
user id or email appears in it. It still sits behind the same four gates as the moderation
console (session, admin role, passkey session, twelve-hour freshness). Which retailers are
watched, and how alerting is failing, isn't public.

### One gate component for every admin page

The moderation page's refusal handling moved into a shared `AdminGate`, and the web client's
admin fetch into one `adminGet`. The next admin page can't forget a case, or word the same
refusal differently.

## Consequences

- FR-1.12 is done. The page reads on the web pool: none of these tables is row-secured, and
  `watch_subscriptions`, which is, isn't touched.
- **No alerting yet.** The dashboard shows a stalled scanner or a stuck backlog, but nothing
  pages anyone. That's SR-X.22, which waits on the Discord ops webhook. The same queries are
  what those alerts should be built on.
