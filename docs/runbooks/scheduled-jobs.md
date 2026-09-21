# Runbook: scheduled jobs

Two things have to run nightly. Both are ordinary commands, run as the **worker** role, whose
grants are the point: it can do these jobs and nothing else.

| Job            | Command             | When      | If it stops                                                                                                   |
| -------------- | ------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| Price index    | `pnpm price:rollup` | 03:30 UTC | Prices go stale. Visible, recoverable — the rollup recomputes, so a missed night is picked up by the next run |
| Data retention | `pnpm db:retention` | 04:30 UTC | **Personal data is kept past its retention period.** Not visible, not recoverable after the fact              |

## Why retention is its own command

A deletion job folded into another job is a deletion job that stops silently the first time
the other job fails. `pnpm db:retention` runs on its own schedule and fails on its own terms.

Today it does one thing: erases buyer handles 90 days after the sale (SR-4.5). It runs on the
worker role, which **cannot read that column** — erasing a name is the one operation that
should never require seeing it (ADR-022).

## What the rollup does, in order

1. `ingestBreakPulls` — logged pulls become observations. Only `manual` values; an
   index-filled one is our own quote coming back as evidence (ADR-018).
2. `ingestLiveSales` — logged sales become observations, each checked against the published
   spread first. One that sits far outside is **flagged**, which keeps it out of the index
   until a person clears it.
3. `rollUpDay` — recompute the published index for the day.

Ingestion runs before the rollup because an observation that arrives afterwards would
otherwise wait a whole day to count.

## Systemd units (on the VPS)

```ini
# /etc/systemd/system/gth-rollup.service
[Unit]
Description=Gundam TCG Hub price rollup
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/srv/gth/production
ExecStart=/usr/bin/docker compose run --rm worker pnpm price:rollup
```

```ini
# /etc/systemd/system/gth-retention.service
[Unit]
Description=Gundam TCG Hub data retention
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=/srv/gth/production
ExecStart=/usr/bin/docker compose run --rm worker pnpm db:retention
```

Each with a matching `.timer` (`OnCalendar=*-*-* 03:30:00` / `04:30:00`, `Persistent=true`).
`Persistent=true` matters for retention: a host that was down at 04:30 must still run the
deletion when it comes back, not skip that night.

## Alerting

Both units should alert on failure the same way the backup timer does
(`OnFailure=gth-alert@%n.service`, see `docs/runbooks/backups.md`). A silent retention failure
is the one that costs something.

## Checking it worked

```bash
systemctl list-timers 'gth-*'
journalctl -u gth-retention.service --since yesterday
```

The retention job prints how many handles it erased. A run that erases zero is normal — it
means nothing crossed 90 days that night, not that it did not run.

## The review queue

Flagged observations sit waiting for a person (SR-4.4). There is no admin screen for them
yet; until there is, they are visible through `listFlaggedObservations` and clearable with
`reviewFlaggedObservation`. A flagged entry never counts towards a published price, so a
backlog makes the index slightly less complete — it cannot make it wrong.
