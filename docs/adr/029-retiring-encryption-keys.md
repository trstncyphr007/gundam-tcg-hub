# ADR-029: Retiring an encryption key, not just adding one

- **Status:** Accepted
- **Date:** 2026-09-22
- **Plan reference:** SR-X.18 ("rotated through re-encryption jobs"), SR-1.6, SR-4.2, SR-4.5,
  ASVS 11.4

## Context

Two fields are encrypted with `DATA_ENCRYPTION_KEYS`: a break's server seed until it's
revealed, and a live-sale buyer handle until it's erased. Every ciphertext names the key that
wrote it (`v1:<kid>:…`), so a new key can be added and made active without breaking anything.

What was missing is the other half. The old key stayed load-bearing for every value it had
ever written. For a routine rotation that's untidy. For the case rotation actually exists
for, a key that may have leaked, it's the whole problem: you can't stop trusting a key that
half your data still needs. The ASVS checklist had 11.4 as Partial for exactly this reason.

## Decision

### 1. A re-encryption job, run by an operator

`pnpm keys:rotate` (`--dry-run` first) walks every encrypted value and does four things:

1. Counts it under the key that wrote it.
2. If that isn't the active key, decrypts it and re-encrypts it with the active one.
3. Checks the new value decrypts back to the same plaintext before writing anything.
4. Writes it only if the stored value is still the one it read.

It ends with the one line an operator needs: **which keys are safe to remove.** The procedure
around it (add, switch, deploy, re-encrypt, remove) is in `runbooks/key-rotation.md`.

It's a command, not a scheduled job. A rotation is a decision with steps on either side,
adding a key and removing one, and a timer can't take them.

### 2. It runs inside the row policies, not around them

Both columns live in FORCE'd tables, where even the table owner sees nothing without saying
whose rows these are. The job therefore walks accounts and works _as_ each one, under the
same policies a request would face.

Two alternatives were rejected:

- **A role that can read every seed and handle at once.** That's exactly the privilege the
  existing column grants were written to deny.
- **Relaxing FORCE for the job.** That weakens the table for everyone.

Walking accounts is slower. At this platform's size that's minutes, not hours. It needs no
new privilege and no loosened policy.

It connects as the migrator, as `role:set` and the other operator commands do. That
connection has never been available to a request.

### 3. It fails safe, in every direction

- **A value it can't decrypt** (written with a key already removed from the ring, or not a
  ciphertext at all) is left exactly as it was. It's reported as `FAILED`, the key is listed
  as still needed, and the command exits non-zero. It never "rotates" something into a value
  nobody can read.
- **A value that changed under it**, such as a seller logging a sale mid-rotation, isn't
  overwritten, because the write is conditional on the old value. The new write already used
  the active key.
- **Plaintext meaning is preserved.** A seed's published commitment is `sha256(seed)`, so
  re-encrypting must not change the seed by a byte. A test decrypts before and after and
  compares.
- **Running it twice does nothing the second time.** It's safe to re-run after a crash.

### 4. What happens to backups

A backup holds values encrypted with whatever key was active when it was taken, and the
runbook makes that trade-off explicit. After a routine rotation the old key goes offline
until the backups that need it age out. After a suspected exposure it's destroyed. Old
backups then hold seeds and handles nobody can read, which is the right result for handles
and an acceptable loss for seeds.

## Consequences

- ASVS 11.4 is Met.
- Tested at the query layer (dry run, full rotation across accounts, idempotence, undecryptable
  values left alone) and run end to end on the dev stack. There it re-encrypted 3 seeds and 2
  handles, reported the old key safe to remove, and read everything back with the new key
  alone.
- **A future encrypted column must be added to the job.** It isn't discovered automatically.
  The job's own docs, and this ADR, say so.
