# ADR-023: VOD timestamps live outside the hash chain

- **Status:** Accepted
- **Date:** 2026-09-22
- **Plan reference:** FR-4.4, SR-4.1

## Context

A pull log says what came out of a pack. A VOD timestamp says _go and watch it happen_, which
is the difference between a record people have to accept and one they can check.

The obvious implementation — a `vod_url` column on `break_pulls` — is impossible and would be
wrong even if it were possible.

**Impossible:** `break_pulls` has `UPDATE` and `DELETE` revoked from every application role
(migration 0011), because a pull log that can be edited is not a log. Timestamps are added
_after_ the stream, when the VOD exists, so they could never be written there.

**Wrong anyway:** the hash chain commits to six fields — `seq`, `cardVariantId`, `label`,
`valueCentsAtPull`, `valueSource`, `pulledAt`. Adding a seventh would invalidate every chain
ever written. Leaving it out of the hashed set while storing it on the same row would invite
the reading that the link is covered by the proof, when it is not.

## Decision

### 1. Its own table, editable by its owner

`pull_evidence` holds an offset and an optional URL override, one row per pull, written and
edited by the break's creator. That is the opposite of `break_pulls` on purpose: a timestamp
is typed by a person watching a VOD back, and a typo in one should be fixable.

It is not a way around the append-only rule. The only columns are an offset and a URL —
nothing here can change what was pulled, what it was worth, or when.

### 2. The link is on the break; the offset is on the pull

One VOD per break is the normal case. Pasting the same URL forty times is forty chances to
paste the wrong one, so `breaks.vod_url` carries it once and each pull stores only seconds.

A per-pull `vod_url` override exists for a break split across two VODs, which is common
enough in long sessions to be worth one nullable column.

### 3. The public page says which half is proven

The break page shows the timestamp as a link and states, in the same sentence as the values
disclaimer, that timestamps are **not** covered by the hashes — the log is proven, the
timestamp is the creator saying where to look.

This is the actual decision. A viewer who assumes the link is proven has been misled by us,
not by the creator, and "we did not explicitly claim it" is not a defence when the
surrounding page is entirely about what can be verified.

### 4. Deep links are built server-side, per platform

Twitch wants `t=1h02m03s`; almost everything else takes plain seconds. Getting that wrong is
not harmless — Twitch silently ignores a numeric `t` and drops the viewer at the start of a
six-hour VOD, which reads as the link being broken rather than as a format mismatch.

Built in `packages/core/src/vod.ts` and applied in the query layer, so the API and the site
point at the same second. `https:` only: the output is a link handed to a reader.

We never fetch these URLs. The link is evidence for a person, not an input to anything of
ours, and fetching it would create an SSRF surface (SR-1.1) in exchange for nothing.

### 5. Timestamps are read out of pasted links, and typed as clock readings

Creators copy from the platform's own "copy at current time" button, so the offset is usually
already in the URL — reading it beats asking them to retype it, and retyping is where a wrong
number comes from. It is offered as a suggestion for pulls with nothing set, never an
overwrite.

The same parser accepts `1:02:03`, `3723`, `1h2m3s` and `90s`, and returns null for anything
else rather than guessing. A misread timestamp points a viewer at the wrong moment, and to
them that looks like the log being wrong.

### 6. The public view still carries no pull ids

Timestamping needs a pull's id, so the creator's list has one and the public view does not.
A public page hands out no handle to anything writable.

## Consequences

- A creator can point a viewer at the wrong moment, deliberately or by accident. That is
  inherent to evidence added after the fact; what the design guarantees is that doing so
  cannot alter the log, and that the page never claims otherwise.
- Clearing the break's VOD link removes every deep link at once while keeping the offsets —
  a creator re-uploading has not retracted their timestamps.
- Parsing is string handling only, so there is no dependency on any platform's API and no
  behaviour to break when one changes.

## Alternatives considered

**Version the canonicalisation to `v2` and hash the timestamp.** Old breaks would verify
under v1, new ones under v2. It would make timestamps tamper-evident — and it would also mean
a creator could never correct a typo, and that the chain's meaning now depends on which
algorithm version a break was opened under. The cost is real and the benefit is small: the
thing worth proving is what was pulled.

**A full URL per pull, no link on the break.** Simpler schema, worse to use, and it makes
every pull an independent opportunity to paste the wrong link.

**Resolve deep links in the browser.** Would let the page adapt per platform without a
deploy. It would also mean the API's answer and the site's answer could differ, which is
exactly the class of bug this project keeps choosing to design out.
