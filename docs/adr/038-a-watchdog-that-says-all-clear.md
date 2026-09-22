# ADR-038: A watchdog that also says "all clear"

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** SR-X.22, §20

## Context

ADR-036 made a failed _job_ audible. ADR-037 started recording the attempts that fail, so
there was finally something to count. Neither of them alerts on anything: the operations page
shows it all, and nobody watches a page at 3am.

## Decision

### Decide in a pure function, so the thresholds can be argued with

`decideAlerts(ops, security, now, thresholds)` takes the two summaries the operations page
takes and returns findings. It touches no database and no clock it was not handed, so every
threshold is exercised directly by a unit test rather than inferred from a dashboard.

The numbers are chosen to be quiet on a normal day and loud on a bad one: 30 failed sign-ins
in an hour, one source refused 15 times in a day, 200 rate-limit refusals in an hour, a
delivery backlog older than 15 minutes, an enabled retailer silent for two hours. They live in
one exported constant, and a test asserts the boundary is the boundary — that the threshold
fires _at_ the number, not one past it.

### The watchdog says "all clear" once a day

This is the part worth defending. A watchdog that only speaks when something is wrong is
indistinguishable, from the outside, from one that died on Tuesday — and silence is exactly
what everyone wants to believe. So a heartbeat goes out every 24 hours, and its absence is the
signal that the watchdog itself is what broke.

It costs one message a day in a channel nobody reads except when something is wrong, which is
the cheapest dead-man's switch available.

### Saying a thing once

Every finding carries a key and a repeat interval, and `app.claim_ops_alert` grants the right
to speak at most once per interval **in a single statement** — so two runs that overlap, which
a fifteen-minute timer makes likely on a slow night, cannot both decide they are the one to
speak. The state is a table, not process memory, so restarting the job does not reset anyone's
peace and quiet.

The claim happens _before_ the send. The other order would re-send everything whenever a post
failed, which is how a broken webhook becomes a flood the moment it comes back.

The worker reaches that table only through the function: it may take its turn and cannot
rewrite the history of what was already said.

### An unconfigured host is a visible state, not a failure

Without `DISCORD_OPS_WEBHOOK_URL` the job prints what it would have said and exits 0. A timer
that fails every fifteen minutes on a host nobody has wired up yet gets disabled by whoever is
tired of it, and then stays disabled.

## Consequences

- **ASVS 16.4 is Met**, with its boundary stated: this covers what the application can see —
  refused sign-ins, rate-limit storms, a stalled scanner, a stuck delivery queue — plus job
  and backup failures from ADR-036. CrowdSec bans and a refused deploy signature happen on the
  host and reach the same channel through `gth-alert@`, but nothing correlates them yet.
- The watchdog is a fourth entry in the jobs role, on a `*:0/15` timer, and posts through the
  one outbound-request file the Semgrep rule allows (ADR-030).
- **It has never posted to a real Discord channel**, because there is no webhook yet. The post
  path is unit-tested against a fake `fetch` — allowlist, truncation, retryability — and the
  job is exercised end to end in the production stack with no webhook configured. The first
  real message is still a thing to watch for on the day the webhook exists, and the runbook
  says how to trigger one deliberately.
