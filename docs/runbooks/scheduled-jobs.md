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

It does two things.

**Buyer handles**, erased 90 days after the sale (SR-4.5). This runs on the worker role, which
**cannot read that column** — erasing a name is the one operation that should never require
seeing it (ADR-022).

**The sweep** (`app.run_retention()`, migration 0035, ADR-035): expired sessions and
verification tokens, devices nobody has signed in from for a year, and audit entries past the
year the privacy policy publishes. Those tables are append-only or off-limits to the worker, so
the deletions live in one database function the worker may call and **cannot steer** — it takes
no arguments, so a caller chooses when the sweep runs, never how far back it reaches. Pruning
the audit log writes one `audit_log.pruned` entry saying how much went and from when.

A run prints a line per category, and all zeroes is a normal night.

## What the rollup does, in order

1. `ingestBreakPulls` — logged pulls become observations. Only `manual` values; an
   index-filled one is our own quote coming back as evidence (ADR-018).
2. `ingestLiveSales` — logged sales become observations, each checked against the published
   spread first. One that sits far outside is **flagged**, which keeps it out of the index
   until a person clears it.
3. `rollUpDay` — recompute the published index for the day.

Ingestion runs before the rollup because an observation that arrives afterwards would
otherwise wait a whole day to count.

## On the VPS: nothing to write by hand

Ansible installs both units and their timers (`infra/vps/ansible/roles/jobs`), so a rebuilt
host schedules them without anyone remembering to. They run:

```
/usr/local/bin/gth-job.sh production <rollup|retention>
```

which decrypts the secrets itself with sops, takes the currently deployed image digest from
`last-good.env`, and runs the matching one-off service from the production compose file:

```
docker compose --profile jobs run --rm retention
```

Three details that are deliberate:

- **The jobs ship inside the API image** (`dist/job-retention.js`, `dist/job-rollup.js`), so
  the server runs the code that was built, scanned and signed. They were pnpm scripts until
  ADR-036, which the production image — distroless, no pnpm, no repository — cannot run at
  all. The units in the previous version of this runbook referred to a `worker` service that
  did not exist.
- **The job decrypts its own secrets** rather than reusing the deploy's copy in `/run`. That
  copy is on tmpfs and vanishes at reboot, so a job depending on it would fail every time the
  host restarted, at 04:30, for the job that must not stop.
- **`Persistent=true`** on both timers: a host that was off at 04:30 must still delete when it
  comes back, not skip that night.

## Alerting

Both units carry `OnFailure=gth-alert@%n.service`, and so does the backup timer. That one unit
posts `⚠️ <unit> FAILED on <host> at <time>` to `DISCORD_OPS_WEBHOOK_URL`, and deliberately
includes no log output — "go and look" is the message, and a journal excerpt is the easiest
way to spill a connection string into a chat room (SR-X.20).

Put the webhook in `/etc/gth/ops.env`, root-owned, mode 0400:

```
DISCORD_OPS_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

**Until that file exists, a failed job or backup alerts nobody** — the alert unit exits 0
rather than failing on top of the failure it was reporting. `preflight.sh` checks for it, and
the playbook warns when it is missing.

## Checking it worked

```bash
systemctl list-timers 'gth-*'
journalctl -u gth-retention.service --since yesterday

# Run one now, without waiting for the timer:
sudo systemctl start gth-retention.service

# Prove the alert path works, before you need it — this posts to the ops channel:
sudo systemctl start gth-alert@manual-test.service
```

The retention job prints how many handles it erased, then a line per sweep category. A run
that erases zero is normal — it means nothing crossed its period that night, not that it did
not run. To tell the difference after the fact, look for the unit's own exit status; a night
that pruned audit entries also leaves an `audit_log.pruned` row.

## The review queue

Flagged observations sit waiting for a person (SR-4.4). There is no admin screen for them
yet; until there is, they are visible through `listFlaggedObservations` and clearable with
`reviewFlaggedObservation`. A flagged entry never counts towards a published price, so a
backlog makes the index slightly less complete — it cannot make it wrong.
