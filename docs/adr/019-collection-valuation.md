# ADR-019: What a collection is worth, and where its CSV is parsed

**Status:** Accepted
**Date:** 2026-09-21
**Context:** Phase 3, FR-3.4 / FR-3.5, SR-3.3 / SR-3.4

---

## Context

A collection manager has one number people actually look at: _what is this worth_. Every
easy way to compute it is wrong in a direction that flatters us, and a price tool that
flatters its users is a price tool nobody can cite. The index (ADR-018) was built to be
argued with; the valuation on top of it has to hold the same line.

Separately, the plan (§12, FR-3.5) says CSV import is parsed in a worker. There is no worker
service — Phase 1's jobs run inside the scanner process — so that instruction cannot be
followed as written today.

## Decision

### 1. A card with no published price is not worth zero

Items the index cannot speak for are counted and reported separately (`unpricedLines`,
`unpricedCards`) and kept out of the total. The headline number covers what we can defend
and says out loud how much it does not cover.

The alternative — treating "no data" as `0` — makes a collection of unpriced cards appear
worthless, which is both wrong and unfalsifiable: the user cannot tell an empty binder from
one full of cards we have no sales for.

### 2. A stale price is not a current price

Only index rows within `maxAgeDays` (default 30) count. An eight-month-old median is a
memory, not a valuation. The oldest day that went into the answer is returned with it, so the
UI can say how fresh the number is instead of implying it was computed this morning.

### 3. Gain and loss are computed over the cards that have both sides

`currentValueCents` covers every priced card. `gainLossCents` covers only the cards that have
**both** a current price **and** a known cost, and the subtotal it was computed from
(`comparableValueCents`) is returned alongside it.

Comparing a total value that includes cards with no cost basis against a cost basis that
excludes them produces a number that is wrong by an amount nobody can estimate. Two smaller,
honest numbers beat one large misleading one.

### 4. The cost basis is per card, and merging averages it by quantity

`acquired_price_cents` is what one card cost, not what the line cost, so changing a quantity
cannot silently rewrite history. When a purchase is added to an existing line the stored cost
becomes the quantity-weighted average of the two, which is what the merged lot actually cost.

If either side's cost is unknown, the merged line's cost becomes unknown. An average that
treats "unknown" as zero is not an average; it is an understatement that compounds every time
the line grows.

### 5. Currencies are kept apart, never converted

An item carries its own ISO currency, and is valued against index rows in that currency.
Lines in another currency are reported in `otherCurrencyLines` rather than converted: we hold
no exchange rates, and inventing one would put a made-up number inside a number people are
being asked to trust.

### 6. CSV import runs in the request, with the worker's guarantees enforced directly

**This is a deviation from the plan, taken knowingly.**

What the worker was _for_ is bounded work: a huge file must not be able to occupy the web
tier. That property is enforced without it —

- the route caps the body at 2 MB and rate-limits imports to 10 a minute per account,
- the parser rejects a file over 2 MB or over 5,000 rows **before doing any work**,
- card resolution is one query for the whole file, not one per row,
- the write is a single transaction, so a half-applied import cannot happen.

`importCollectionCsv` takes text and returns a report, so when `apps/worker` exists it moves
behind a job with no change to its body. The trigger to move it: any import taking longer
than a second, or a second caller wanting the same function.

### 7. Import previews by default

`dryRun` defaults to `true`, and the HTTP route requires `?apply=true` to write. An import
that rewrites someone's collection should have been previewed first, and making the safe path
the one you get by forgetting is the only way that reliably happens.

### 8. A shared collection publishes the cards, never the receipts

Row-level security decides which _rows_ a shared collection hands out. It cannot mask a
column, and sharing a card list was never an offer to publish a purchase history alongside
it. So `listItems` and `valueCollection` null `acquired_price_cents`, `acquired_at` and
`notes` in SQL for any viewer who is not the owner.

In SQL rather than in the route, so there is one place to get it right instead of one per
caller — and the valuation then needs no separate rule, because with the cost null every line
falls out of the comparable subset and the gain reported to a visitor is nothing.

**This was wrong when collections first shipped.** The detail route, the valuation and the
CSV export all returned the owner's prices and notes to anyone who could open a public
collection. It was found while building the share page, and it now has tests at the query
layer and over HTTP.

### 9. Unlisted is enforced by the query, not by the row policy

Row-level security admits `private` rows to their owner and everything else to everyone,
because it cannot know whether the caller already had the id. The difference between
_unlisted_ and _public_ is therefore discoverability, which lives in the listing query
(`visibility = 'public'`) and has its own test. A policy cannot express "only if you were
told the id"; pretending otherwise would have been a comment, not a control.

## Consequences

- The valuation response has more fields than a single total, and the UI has to show at least
  the unpriced count next to the headline. That is the point.
- Gain/loss will read as "not enough information" for collections imported without prices.
  Correct, and it gives people a reason to record what they paid.
- Multi-currency collections are second-class until there is a rate source we would be
  willing to publish. Reporting them as unvalued is honest; converting them would not be.
- The import path will need revisiting when a worker exists. The deviation is written into
  the function's own docstring so it cannot be forgotten.
