# ADR-022: Live sales, and what happens to a buyer's name

- **Status:** Accepted
- **Date:** 2026-09-22
- **Plan reference:** FR-4.1, SR-4.4, SR-4.5

## Context

A card sold on a live stream leaves no public trace: no listing, no sold-price page, nothing
to scrape. That is exactly why it is worth recording — it is the half of the market nobody
else has — and exactly why recording it is delicate. Every other source in the index can be
checked against something. This one exists only because we say it happened.

It also introduces the project's first real PII. A buyer handle is somebody's name on another
platform, typed in by a third party who never agreed to anything with us.

## Decision

### 1. A seller writes to `live_sales`, never to `price_observations`

Migration 0013 forbids the web role from inserting any observation except an unapproved
`user_report`. That rule is the reason the index is worth believing: **the sources we weight
most heavily cannot be reached from a session at all.** A compromised web process cannot
claim it watched a sale that never happened.

So the logger does not write an observation. It writes its own row, and a worker — a
different role, on a different schedule — turns those rows into observations. The seller's
entry appears instantly; it becomes evidence only after crossing a boundary a request cannot
cross.

Rejected: granting `app_web` permission to insert `live_sale` observations. It would have
saved a table and a job, and it would have dismantled the one control that makes a
first-party price mean anything.

### 2. An odd price is held, not dropped and not counted

Each entry is compared to the published spread for that printing before it counts. More than
three interquartile ranges outside and it is inserted **flagged**, which the rollup excludes.

Flagged is not rejected. A $900 sale of a $12 card is either a mistyped entry or the most
interesting data point of the week, and only a person can tell which — so the sale is
recorded either way and a human decides whether it moves the number.

Nothing is flagged when there is no published baseline within 30 days. You cannot call a
price an outlier with nothing to be outside of, and judging tonight's sale against a number
from six months ago would manufacture review work out of ordinary drift.

### 3. The buyer handle is encrypted, and the ingestion cannot read it

Four defences, none of which trusts application code:

1. **AES-256-GCM at rest**, so a database backup contains no buyer handles.
2. **`app_worker` has no `SELECT` on that column** (migration 0024). The ingestion path that
   writes public observations runs as that role. If a future version of the query asks for
   the handle, it fails — loudly, in a test — instead of publishing someone's name.
3. **It appears in no public view and no observation.** The only route that returns it is the
   seller's own listing, behind a row policy that admits the owner alone.
4. **It is erased 90 days after the sale**, by a job that may write that column and still
   cannot read it.

### 4. `has_buyer_handle` exists because of how Postgres privileges work

Point 3 nearly did not survive contact with the retention sweep. Postgres requires `SELECT`
on every column a statement _reads_, including in its own `WHERE` clause — so
`UPDATE ... WHERE buyer_handle_encrypted IS NOT NULL` needs exactly the privilege the split
grant exists to withhold, and the sweep failed with _permission denied_.

The fix separates two different facts. _Whether_ there is a name stored here is operational
metadata that anyone may read; _what it is_ is not. A boolean column carries the first, the
encrypted column carries the second, and a `CHECK` constraint keeps them in step.

That is worth stating plainly because the obvious alternative — granting the worker `SELECT`
so the predicate compiles — would have quietly removed the control while leaving every
comment about it in place.

### 5. An entry can be removed until it reaches the index, then not

A mistyped entry is deleted, not corrected in place. After ingestion it stays, and the policy
says so (`price_observation_id IS NULL` in the `DELETE` predicate) rather than a comment: a
published number has to keep something behind it.

### 6. Selling and running a break are separate rights held by the same people

`live_sale:read` / `live_sale:write` go to the `seller` role **and** the `creator` role,
because the two overlap in practice — somebody running a break sells singles between packs.
Making them hold two roles to describe one evening would mean granting the wrong one, or
granting both to everybody. A seller does not get the overlay, the pull log or a breaker
profile in return.

### 7. Retention is its own command

`pnpm db:retention` runs on its own rather than as a step inside the price rollup. A deletion
job that only runs when some other job succeeds is a deletion job that silently stops.

## Consequences

- A logged sale is not a published one, and the UI shows three states rather than two: _not
  yet counted_, _held for review_, _in the index_.
- Flagged entries need a reviewer. The queue is `listFlaggedObservations`; an admin screen
  for it is not built yet and is the obvious next piece.
- Losing `DATA_ENCRYPTION_KEYS` makes existing buyer handles unrecoverable. That is the
  intended property, and the runbook already treats that key as password-manager material.
- An entry with no catalogued card is recorded but never priced. It is reported as
  `unpriceable` by the ingestion rather than retried forever.

## Alternatives considered

**Hash the buyer handle instead of encrypting it.** SR-4.5 allows either. A hash is
irreversible, which is better — and useless: the seller's whole reason for storing it is to
know who to post the card to. Encryption with a short retention keeps the use and bounds the
exposure.

**Flag on write rather than on ingestion.** The entry would be marked the moment it is typed,
which reads better. It would also put an index lookup in the path of a logger that has three
seconds an entry, and would let a seller see immediately which prices trip the check — which
is a map of how to avoid it.

**Omit buyer handles entirely.** Cleanest for us and wrong for the seller, who then keeps the
same names in a spreadsheet with no encryption, no retention and no policy.
