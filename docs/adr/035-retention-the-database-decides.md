# ADR-035: The retention period is a database rule, not a job parameter

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** SR-X.21, SR-X.23, SR-X.24, §16.7

## Context

ADR-034 published a privacy policy whose claims all matched the code, with one exception it
stated openly: the audit log "is not yet pruned automatically". Three kinds of row were being
kept for ever, none of them by decision:

- **`audit_log`** entries. The plan retains them for a year. Migration 0001 made the table
  append-only for every application role, which also means no application role can prune it.
- **Expired `sessions` and `verifications`.** A session past `expires_at` cannot sign anyone
  in, but still carries that day's IP hash and a user-agent string; a lapsed magic-link row
  still carries its token hash. Better Auth never deletes them.
- **`sign_in_devices`** nobody has signed in from for a year. The table exists to answer "is
  this device new?" — a device not seen in a year is new again, so the row is personal data
  kept for a question nobody is asking.

The obvious implementation is a nightly job with a cutoff: grant the worker DELETE and let it
pass `now() - 365 days`. That undoes the point of the append-only table. A worker that can
delete audit entries can delete _recent_ audit entries, and the first thing worth deleting is
the record of what the worker just did.

## Decision

### One function, no arguments

`app.run_retention()` (migration 0035) is `SECURITY DEFINER`, executable only by
`app_worker`, and **takes no parameters**. The periods are written into the function body.
The caller chooses _when_ the sweep runs; it can never choose _how far back_ it reaches.

Changing a period means a migration and a review, which is the right amount of friction for a
deletion schedule. The application roles keep exactly the grants they had: no DELETE on
`audit_log`, none on `sessions`, none on `sign_in_devices`. A test asserts each of those still
fails, because the function is only a control while the direct route stays shut.

Everything it deletes is already dead: a session that cannot authenticate, a token that cannot
be redeemed, a device that would be treated as new anyway, an audit entry past the published
retention. Sessions and tokens get a day of slack past expiry rather than being deleted the
moment they lapse — a sweep racing a browser mid-refresh buys nothing.

### The prune leaves a footprint in the log it pruned

When audit entries go, the function writes one `audit_log.pruned` entry recording how many and
from when. History that can be shortened silently is history that can be shortened; this way
the shortening is itself part of the record. A night that prunes nothing writes nothing, so
the log doesn't fill with noise.

### The device floor is a policy on the table, not a line in the function

`sign_in_devices` forces row-level security, which applies to the role the function runs as
too. Instead of exempting that role, the retention rule became two policies on the table: it
may **see** and **delete** a device row only once the row is past a year. The floor then holds
for the function, for a migration run by hand, and for anything else that is ever granted
DELETE on that table.

That is worth the extra migration because of what the table does (ADR-026): deleting a recent
device row is exactly how someone would suppress the "new device" email announcing their own
sign-in. And pruning fails safe in the other direction — a device row that goes early means the
next sign-in from it is announced as new, not silently accepted.

**Two policies, not one.** `DELETE ... WHERE` has to read the rows it deletes, and that read
goes through the SELECT policies. With only a DELETE policy the sweep matches nothing and
reports success: a retention job that deletes zero rows for ever while looking healthy. It
behaved exactly that way in the first test run. Both policies are scoped `TO app_migrator`;
written without that clause the SELECT policy would widen for `app_web` too, and one account
could then read another account's old devices.

## Consequences

- SR-X.23 is closed for audit logs, and the privacy page now states a year instead of a
  caveat. The e2e suite asserts that sentence, so the two cannot drift apart.
- `pnpm db:retention` is still the single deletion command, and still fails on its own terms.
  It now prints a line per category; all zeroes is a normal night.
- **Nothing alerts if it stops running.** The systemd unit should carry `OnFailure=`, as the
  backup timer does (`docs/runbooks/scheduled-jobs.md`), but a job that is never scheduled
  fails silently by definition. That is the remaining gap, and it belongs with SR-X.22.
- App logs are still retained by Docker's rotation (`max-size 10m`, 5 files), not by this
  sweep. Nothing in them is personal beyond hashed values (SR-X.20).
