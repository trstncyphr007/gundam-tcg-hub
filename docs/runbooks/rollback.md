# Runbook: Rollback

**When:** the deploy failed its healthcheck or smoke test, or something is visibly broken
after a deploy that "succeeded".

## What the automatic rollback does, and what it leaves alone

Rehearsed for real on 2026-09-24 (`scripts/deploy-rehearsal.sh`): an older release was
deployed, a newer one was then deployed with a setting that made the site unreachable, and the
failure path ran. Observed, not assumed:

| Step                                        | What happened                                          |
| ------------------------------------------- | ------------------------------------------------------ |
| Signatures verified for the **new** release | Yes — the rollback path is not a way around them       |
| Migrations run                              | **Yes, before the failure was noticed**                |
| Stack started, then smoke test              | Started healthy; smoke test failed (`000`)             |
| Images restored to the previous release     | Yes, and the container really is running them          |
| `last-good.env`                             | **Untouched** — a failed deploy does not record itself |
| Exit code                                   | 1                                                      |

**Two things it deliberately does not do**, both worth knowing at the moment it happens:

- **It does not undo the migrations.** They run before the smoke test, so a rollback puts the
  _old code_ back against the _new schema_. That is exactly why migrations are written
  expand/contract — the rule earns its keep in this five-second window, not in theory.
- **It does not revert secrets.** If the bad release was really a bad _setting_, that setting is
  still in place afterwards and the site stays broken until someone fixes it. Nobody wants a
  deploy quietly reverting a secret — but it means "it rolled back" is not the same as "it is
  working again". **Check the site, not the exit code.**

## First: it may already have rolled back

`deploy.sh` traps failures after the migration step. On failure it rewrites the runtime env
back to the digests in `last-good.env` and restarts, then exits non-zero.

```bash
ssh deploy@<vps>
sudo cat /srv/gth/production/last-good.env      # what is meant to be running
sudo docker compose -p gth-production ps        # what is running
sudo docker compose -p gth-production logs --tail=100 api
```

If those agree and the service is healthy, the rollback worked. Find out why the deploy
failed before trying again.

## Manual rollback

Re-run the **deploy** workflow with the previous release's digests and the same environment.
That path is identical to a forward deploy — signatures verified twice, migrations run,
healthchecks enforced — so it is the safest way back.

Get the previous digests from `last-good.env`, or from the release run that produced them.

### If the workflow itself is unavailable

```bash
ssh deploy@<vps>
sudo /srv/gth/deploy.sh production sha256:<previous-api> sha256:<previous-web>
```

Same script, same checks. Do not hand-edit compose files or `docker run` an image directly:
that skips signature verification and leaves nothing recorded.

## The schema is the hard part

Rolling code back is easy. Rolling a **migration** back is not, which is why migrations must
be expand/contract:

1. Add the new thing, nullable
2. Backfill
3. Only then constrain or drop

Done that way, the old code keeps working against the new schema and a rollback is just a
code change. Done the other way — rename a column, drop one — the old code breaks and
rollback stops being an option exactly when you need it.

**If a migration ran and the rollback cannot work against the new schema**, you are in a
restore, not a rollback. See [`restore.md`](restore.md).

## After any rollback

- Say what happened in `#ops` (or wherever alerts land)
- Open an issue labelled `incident` — a rollback is a near miss and near misses are free
  lessons
- Work out why CI passed. Every rollback means something ran green that should not have; the
  gap in the gates is the real finding, not the bug

## What this does not cover

Data written by the bad release. Rolling images back does not un-write rows. If the release
corrupted data, stop and go to [`incident.md`](incident.md) — restoring is a decision with
data-loss consequences and should not be improvised.
