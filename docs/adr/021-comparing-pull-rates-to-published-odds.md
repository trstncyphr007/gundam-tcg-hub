# ADR-021: Comparing pull rates to published odds

- **Status:** Accepted
- **Date:** 2026-09-21
- **Plan reference:** FR-4.3, SR-4.4

## Context

A breaker profile publishes, next to a named person, what they pulled against what the
publisher said they should have pulled. There is only one way a reader interprets "pulled SR
at half the published rate", and it is not "interesting sample".

So this is not really a statistics decision. It is a decision about what the platform is
willing to assert about someone, automatically, at scale, from data it collected itself. The
maths follows from that.

The pressure runs the other way too: a page that can never say anything is a page nobody
reads, and "verified randomisation" would be a sticker rather than a finding. The goal is a
comparison that is **capable** of being damning and almost never is.

## Decision

### 1. Packs are the denominator, and they are entered by hand

Published odds are stated per pack. A pull log counts cards. Thirty pulls could be thirty
packs or six, and nothing in the log distinguishes them.

`breaks.packs_opened` is nullable and entered by the creator. **A break without one is
excluded from every comparison**, and the profile states how many breaks that was rather than
quietly shrinking the sample.

Rejected: inferring packs from pull counts. It would produce a denominator that looks like
data and is a guess, and the guess would be wrong in the direction that flatters whoever
logs the least.

### 2. Comparisons are per product, never pooled

Odds differ between sets and printings. An SR from a 1-in-12 product and an SR from a
1-in-24 product pooled together give a rate comparable to neither — and that is a quiet way
to make an honest breaker look lucky, or a lucky one look ordinary.

### 3. Wilson, not the textbook normal interval

At the rates pack odds actually use, the Wald interval is badly behaved: at zero hits it
collapses to `[0, 0]`, asserting the true rate is exactly zero from a sample of thirty, and
at low `p` it can run below zero.

Wilson is well behaved down to zero successes and gives a sensible upper bound instead.

### 4. Two floors before anything is compared at all

- at least **30 packs**, and
- at least **5 expected hits** (`packs × published rate`).

The second is the one that bites. At 1-in-72 odds it takes 360 packs before the published
rate can be distinguished from anything, so most breakers will never reach it for their
rarest slot. The verdict there is `insufficient`, permanently, and the page says so in words
rather than leaving a suggestive blank.

### 5. The confidence level is adjusted for how many rarities are tested

Six rarities tested at 95% gives about a 26% chance that one of them clears the line by luck
— and that one is the row a reader would screenshot. The interval is widened with a Šidák
adjustment over the number of rarities that actually have published odds; rarities with no
odds were never a test and do not inflate the count.

### 6. `pack_odds.source_url` is NOT NULL, and the app cannot write the table

Odds we cannot cite are not published odds, they are our claim about published odds. The
citation is shown beside every comparison.

The column being NOT NULL is the smaller half of this. The larger half is that `app_web` has
`SELECT` on `pack_odds` and nothing else (migration 0022), so no web request can edit a
citation or invent a rate. An admin screen for it will have to grant the privilege
explicitly and argue with that migration.

### 7. More hits than packs is reported as not comparable

A pack can contain two of a rarity; "1 in 12 packs" says nothing about that case. When the
data contradicts the one-per-pack model the odds assume, the row says so instead of
producing a verdict from a model that does not apply.

### 8. The badge can be lost

"Verified randomisation" requires a revealed commit–reveal **and** no broken hash chain — the
two halves of the claim. Commit–reveal shows the shuffle was not chosen after the fact; the
chain shows the log was not edited after the fact.

If any re-checked chain fails to re-derive, the badge becomes `broken` and the page leads
with it. A badge that can only ever be awarded is decoration.

### 9. The profile re-checks a bounded number of chains, and says how many

Re-hashing every pull of 200 breaks would make a public page do hundreds of thousands of
SHA-256 operations per request — slow, and a cheap way to load the server. The profile
re-verifies the 25 most recent finished breaks and **states that number** rather than
implying it checked everything. Every break remains checkable in full, in the reader's own
browser, on its own page.

## Consequences

- Most rows on most profiles will read "too few packs" for a long time. That is the correct
  outcome and the UI treats it as an ordinary answer, not a placeholder.
- A creator who wants their hit rates compared has to record pack counts. The form says so.
- Publishing real odds for real sets waits on the catalog import and its IP review (plan
  §23, open item O2). Until then the seeded odds are invented, and their `.invalid` source
  URL says so.
- The comparison lives in `packages/core/src/rarity.ts` with known-answer tests, so the API,
  the page and any future consumer cannot reach different verdicts from the same tallies.

## Alternatives considered

**A chi-squared test across all rarities at once.** Gives one number for "is this whole
sample odd", which is a worse fit: readers want to know about a specific rarity, and a
significant overall result would have to be attributed to a row anyway.

**Bayesian posterior with a prior from the published odds.** Defensible, and harder to
explain on a page whose whole purpose is to be checkable by a sceptical viewer. The value of
this page is that its method fits on one screen.

**No comparison at all — publish counts and let readers do the maths.** Tempting, and it
loses the actual product: readers will do the maths badly, in public, about a named person.
Doing it carefully and stating the uncertainty is the service.
