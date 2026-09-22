# ADR-036: The nightly jobs ship in the image, and their failures are audible

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** §15.5, §19, §20, SR-X.22, SR-X.23

## Context

ADR-035 shipped a retention sweep that deletes personal data on a clock, and the privacy
policy now promises it. Checking how it would actually run on the server produced three
findings, in increasing order of embarrassment:

1. **The runbook's systemd units invoked a service that does not exist.**
   `docker compose run --rm worker pnpm db:retention` — there is no `worker` service in
   `docker-compose.prod.yml`, and never was.
2. **Even with one, it could not have worked.** The production image is distroless: no pnpm,
   no tsx, no repository. `pnpm db:retention` is a workstation command. Both nightly jobs
   existed only as developer commands.
3. **The one failure alert that existed alerted nobody.** `gth-backup-failed.service` read
   `DISCORD_OPS_WEBHOOK_URL` from `/etc/gth/restic.env`, and the runbook's own template for
   that file never contained it. `test -n "$DISCORD_OPS_WEBHOOK_URL" || exit 0` — so a
   by-the-book install had an alert unit that exited 0 every time.

Put together: neither nightly job could run, and if one had, nobody would have heard it fail.

## Decision

### The jobs ship inside the image, as their own entry points

`dist/job-retention.js` and `dist/job-rollup.js` join `dist/migrate.js` in the API image, from
the same tsup build. The server therefore runs the code that was built, scanned and signed —
the same reason the migration runner ships there (§15.5).

Their bodies moved to `packages/db/src/jobs.ts`, so `pnpm db:retention` on a workstation and
`docker compose --profile jobs run --rm retention` on the server are the same code rather than
two things that resemble each other. Each returns its output lines instead of printing them,
which is what let a test assert them.

Both run as **app_worker**, whose grants are the point, and both are `restart: 'no'`: a
one-off that failed should stay failed and alert, not loop.

### Ansible installs the schedule; the runbook stops asking for hand-written units

`infra/vps/ansible/roles/jobs` installs both services, both timers, `gth-job.sh` and one
alert unit. A rebuilt host is scheduled without anyone remembering to be (threat T17).

`gth-job.sh` decrypts the secrets itself rather than reusing the deploy's copy in `/run`.
That copy is on tmpfs and is gone after a reboot, so a job that depended on it would fail
every time the host restarted — at 04:30, for the job that must not stop.

### One alert path, for every kind of failure

`gth-alert@.service` takes the failed unit's name as its instance, so `OnFailure=` on any unit
reports through it: both jobs, the backup, and whatever comes next. The bespoke backup unit is
removed. The webhook moves to `/etc/gth/ops.env` — its own file, because it is not a restic
credential and the job units read it too; the alert unit still reads `restic.env` as well, so
a host that already put it there keeps working.

It posts the unit, the host and the time, and **no log output**. "Go and look" is the whole
message: a journal excerpt is the easiest way to spill a connection string into a chat room
(SR-X.20). It exits 0 when unconfigured, because an `OnFailure` handler that fails buries the
failure it was reporting.

`preflight.sh` now fails when the timers are not enabled or no webhook is configured, so this
is caught before a deploy rather than after a subject access request.

## Consequences

- **A real bug fell out of running it properly.** The rollup had always run as the _migrator_
  on a workstation; as the worker it dies with `permission denied for table break_pulls` —
  migration 0011 revoked exactly that, for a reason that predated the rollup existing. It
  would have failed every night on the server. Migration 0036 grants the worker **column-level**
  SELECT on the six columns the rollup reads, so a break's title, creator, seeds and overlay
  token hash stay unreadable to that role. Row-level security needed no change: the existing
  policy already shows an un-scoped connection exactly the non-draft breaks.
- `scripts/verify-prod-stack.sh` now runs both jobs against the real production stack, so the
  next missing grant fails on a workstation instead of at 03:30 on the server.
- **SR-X.22 is only partly met.** Job and backup failures are now audible. The rest of its
  trigger list — failed-login spikes, rate-limit bans, CrowdSec bans, a refused deploy
  signature — has no data source yet: nothing records a failed login, and the rate limiter
  keeps no ban. That is the next piece of work, and it is application-side.
- The alert path still needs a webhook from the owner. Until then the units are installed, the
  timers run, and the alert unit says so in the journal instead of pretending.
