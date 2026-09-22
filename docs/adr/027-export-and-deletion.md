# ADR-027: Downloading your data, and deleting your account

- **Status:** Accepted
- **Date:** 2026-09-22
- **Plan reference:** SR-X.25, SR-X.24, SR-X.5, SR-3.5, SR-4.5, ASVS V14.5

## Context

SR-X.25: users can export their data as JSON and delete their account, "hard delete within 30
days, keeping only anonymised, tax-required or legally required records". It was the last
V14 item still Open, and the plan marks it as required before public launch.

Building deletion turned up a bug that had been there since Phase 3: **no account that had
ever reported a price could be deleted at all.** `price_observations.reporter_id` references
`users` with `on delete set null`, which is how a report was meant to outlive its reporter
anonymously. But a check constraint said every user report must name its reporter. The two
contradicted each other, so the delete failed. Nobody had tried it yet.

## Decision

### 1. Deletion is immediate, not a 30-day grace period

"Within 30 days" is a ceiling, not a waiting room. A grace period means building an undo, a
job to finish the deletion, and a state where the account half-exists. It also means an
attacker who deleted someone's account can be reversed, but so can the owner's own clear
intent. Immediate deletion is simpler and more honest, _if_ it's hard to trigger by
accident or by someone else. So:

- **Type the address.** The request carries the account's email, compared case-insensitively.
  A stray click can't do it, and neither can a script that holds only a session cookie.
- **A sign-in from the last ten minutes.** This is the same freshness as changing passkeys
  (ADR-025). A stolen, days-old cookie deletes nothing.
- **A passkey session if the account has a passkey.** This is the ADR-025 ladder once more:
  whoever holds the inbox can't destroy an account the owner protected with a passkey.
- **Admins can't delete themselves.** An operator demotes them first (SR-X.9). Otherwise
  one stolen admin session could take the platform's last admin, and the audit trail's most
  important actor, with it.
- **Five an hour, counted per account.** The limit runs after the session is resolved, so a
  household behind one IP doesn't share five between everyone. That's tested.

The owner gets an email afterwards to the address the account had, with no links.

### 2. What goes, what stays

| Record                                                                                    | On deletion                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Sessions, sign-in methods, passkeys, known devices, watches (and their alert deliveries)  | Deleted (cascade)                                                                                       |
| Collections and items, breaks with their pulls, commitments and evidence, creator profile | Deleted (cascade)                                                                                       |
| Live sales (and the buyer handles in them), API keys                                      | Deleted (cascade)                                                                                       |
| Price reports never approved (pending or rejected)                                        | Deleted: they were the person's unpublished submissions                                                 |
| **Approved** price reports                                                                | **Kept, anonymised**: the reporter is set to null. They're part of the published index                  |
| Price observations derived from their breaks' pulls                                       | Kept, anonymised: the link to the pull is set to null when the pull goes                                |
| Pending sign-in links                                                                     | Deleted: they hold the address in a JSON value no foreign key can reach                                 |
| Audit log                                                                                 | Kept. Rows carry an opaque id and never an email; one more row, `account.deleted`, records the deletion |

Keeping approved reports is the "anonymised records" the requirement allows. The published
index was computed from them, and removing its inputs after the fact would make yesterday's
number unreproducible. Pending and rejected reports never counted, so there's nothing to
preserve.

### 3. The deletion is one database function the web tier can call but not improvise

`app.delete_account(user_id)` (migration 0033) is `SECURITY DEFINER`. It deletes the
never-approved reports, then the `users` row, and the foreign keys do the rest.

- **Why a function:** the web role must not be able to delete price observations in general.
  A live account could then wipe its rejection history, which is what reputation weighting
  reads (SR-3.5). Here, that deletion is reachable only as part of deleting the whole account.
- **It must be the declared account.** The function refuses unless the transaction has
  declared the same account it's deleting, so a caller that hasn't said who it's acting for
  gets nothing.
- **The web role lost its plain `DELETE` on `users`.** Nothing used it, and the function is
  now the only way the web tier deletes a person.
- **Cascades reach FORCE'd tables.** Foreign-key actions run as the table owner, so they
  reach tables that no application role could delete from directly. Tests prove this rather
  than assume it: each table is counted _as the deleted user_ afterwards, because an
  undeclared count of a FORCE'd table sees nothing and would prove nothing.

Migration 0032 fixes the contradiction. A user report must name its reporter _while it's
being judged_; once approved it can outlive them.

### 4. The export: everything, minus what opens things and what is someone else's

`GET /v1/account/export` returns one JSON document, downloaded as a file:

- profile, sign-in methods and passkeys
- sessions, including IP address and user agent
- known devices, watches, and collections with their items
- creator profile, and breaks with their pulls, commitments and VOD evidence
- live sales, price reports, API key metadata, and the account's audit activity

Cards are named, not just given as ids.

It reads everything in one transaction that declares the user, so row security applies to
every table that has it. The function _can't_ read anyone else's rows, whatever a bug in it
asks for; a test proves it.

The file lists what it leaves out, under `withheld`:

- **Anything that opens something:** session tokens, OAuth tokens, API key hashes, overlay
  token hashes and unrevealed break seeds. An export is a file people email to themselves and
  leave in Downloads, so nothing in it should work as a credential. Tests check the body for
  each.
- **Other people's personal data:** buyer handles from the live-sale logger (SR-4.5). The
  seller sees them in their own listing, and they're erased after 90 days. A portable copy
  would outlive that. The export says a handle _was_ recorded (`hadBuyerHandle`), not what it
  was.

Session IP addresses _are_ included, even though ADR-026 keeps them off the sessions page.
The difference is who's asking and why. The page is a quick view that a thief might also
look at. The export is the owner's right to see what's held about them, and it's gated by a
fresh sign-in, rate-limited, and emailed to the owner. (Since ADR-028, what is held — and so
what is exported, as `ipHash` — is a same-day hash, not the address.)

The audit activity lists what was done and when, but not _who_ did it when that was an admin.
An admin's id isn't the requester's data.

### 5. Restores must not bring people back

A backup taken before a deletion still contains the account. `restore.md` now has a step for
every restore: read the `account.deleted` rows from the audit log newer than the snapshot,
and re-run `app.delete_account` for each before serving traffic. Backups themselves age out
on the retention schedule, and that is what bounds how long a deleted account survives in
one.

## Consequences

- ASVS V14.5 is Met, and SR-X.25 is done.
- A bug present since Phase 3 is fixed: accounts with price reports can now be deleted.
- `developer.test.ts` had a random failure: the API key's secret can contain `_`, and the
  test split on the last one. It surfaced here and is fixed.
- **Not done:** no self-service undo, by design. Mistakes are prevented by the typed
  confirmation, the fresh sign-in and the passkey rule, not reversed.
