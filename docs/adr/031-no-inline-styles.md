# ADR-031: No inline styles, so the CSP can refuse them

- **Status:** Accepted
- **Date:** 2026-09-22
- **Plan reference:** SR-2.3, SR-X.14, ASVS 3.2; closes gap 1 in the ASVS checklist

## Context

The CSP has refused inline _scripts_ since Phase 1: nonce plus `strict-dynamic`, asserted in
CI. It allowed inline _styles_ (`style-src 'self' 'unsafe-inline'`), and that was listed as a
known gap from the first day of the checklist.

The reason it stayed was mechanical. A nonce covers a `<style>` element, but it can't cover a
`style="…"` _attribute_. The web app had 428 of them, React `style` props rendered into the
server HTML. Without `'unsafe-inline'`, the browser drops every one, and React doesn't put them
back on hydration. Pages would pass every functional test and render wrong.

The risk it left open is CSS injection. Wherever user text could reach markup as a style,
attribute selectors can exfiltrate values character by character, and layout can be used to
redress the UI. React's escaping makes that hard, and the CSP is the layer that makes it
impossible.

## Decision

### 1. The palette becomes Tailwind colours

`globals.css` declares the existing CSS variables as Tailwind v4 theme colours (`@theme
inline`): `text-muted`, `bg-surface`, `border-line`, `bg-accent`, `text-danger`, and so on.
They're still defined once, as variables, and components now use classes.

This fixed a latent bug along the way. Components had been using `var(--bg)`, `var(--fg)`
and `var(--danger, …)`, but none of the three was ever defined. Inputs styled with `--bg`
rendered with no background at all. The tokens map `page` and `fg` to the variables that were
evidently meant, and `--danger` and `--warning` are now real variables.

### 2. A codemod did the bulk; the rest by hand

A codemod built on the TypeScript compiler's parser, not regex, converted a `style` prop only
when _every_ property mapped to a known class and the element's `className` was absent or a
plain string. That was 411 of 428. The remaining 17 were conditional or data-driven, and each
became one of:

- **A conditional class:** the active range button, the highlighted search hit, a positive
  total.
- **A class looked up from a fixed set:** fairness badge and verifier colours.
- **An SVG `fill`:** the price-chart legend dot. Presentation attributes aren't styles, and
  the CSP doesn't touch them.
- **An arbitrary Tailwind value:** Discord's brand colour, the destructive button, the
  overlay's profit colour.

### 3. The OBS overlay gets its own stylesheet

The overlay is a separate root layout that never loaded the site's CSS. Its inline styles
worked without any, and the codemod's classes would have done nothing there. It can't load
`globals.css` either, which paints a page background, and OBS needs transparency.
`app/(overlay)/overlay.css` imports Tailwind and sets a transparent, edge-to-edge body plus
the text shadow that keeps the overlay readable on stream.

### 4. The policy

Production is now `style-src 'self' 'nonce-…'`. The dev server keeps `'unsafe-inline'`, as it
already does for scripts, because hot reload injects its own unnonced `<style>` tags.

### 5. Guards, each proven to trip

| Guard                                                                     | What it catches                                                 | Proven by                                                                                       |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ESLint `no-restricted-syntax` on JSX `style`                              | A style prop in a PR                                            | A planted one fails lint                                                                        |
| e2e: no `style="` in the server HTML of public, account and creator pages | One slipping through anyway, on any server, dev included        | It failed on this branch's first run, which is how the live-DOM version was found wrong (below) |
| e2e: no `securitypolicyviolation` event while those pages load            | Anything the production CSP blocks, including Next's own output | An injected `style="color: red"` on the production build was refused and reported               |
| e2e: the policy itself (`style-src` has a nonce, no `'unsafe-inline'`)    | The directive being loosened again                              | Existing production-build test, extended                                                        |
| e2e: overlay computed styles (margin 0, text shadow, 17.6 px title)       | The overlay's stylesheet failing to load                        | Browser defaults would pass the old checks; these would not                                     |
| e2e: a `.text-muted` element really is `#9aa3b8`                          | Classes compiling to nothing                                    | A theme mistake would render unstyled and pass the rest                                         |

One lesson from building them: the first version counted `style` attributes in the _live
DOM_, and failed on every page. Next's route announcer and dev tools set styles from script
through the CSSOM. The CSP allows that, and it shows up as an attribute all the same. What
the CSP refuses is markup, so the check reads the HTML the server sent.

ZAP's CSP rule (10055) was ignored only because of `'unsafe-inline'`. It's now WARN, to be
promoted to FAIL after one clean nightly run.

## Consequences

- ASVS 3.2 is **Met**, and gap 1 is closed.
- **A genuinely dynamic style value** needs an SVG attribute, a class from a fixed set, or a
  CSSOM write from a ref. The lint message says so.
- **Next's default 404 and error pages** use inline styles of their own. Fixed 2026-09-23: the
  site has its own `not-found`, `error` and `global-error`, and a lowest-priority catch-all
  sends unmatched URLs into the site layout rather than Next's global 404 (the stable
  alternative to the experimental `global-not-found`). e2e checks both kinds of 404 for
  status, layout and clean markup, and that the catch-all never swallows `/v1` or
  `/api/auth`.
