import { notFound } from 'next/navigation';

/**
 * Every URL nothing else matches, routed into the site so it gets the site's 404.
 *
 * The app has two root layouts (site and overlay) and no shared one above them, so an
 * unmatched URL used to fall through to Next's own global 404 — which styles itself with
 * inline `style` attributes, and so rendered unstyled under the production CSP (ADR-031).
 * Next offers `global-not-found` for this, but only behind an experimental flag in 16.x; a
 * catch-all is the stable way to the same place.
 *
 * It is the lowest-priority route there is: every real page, the overlay, and the proxied
 * `/v1`, `/api/auth` and `/docs` paths (rewrites run before dynamic routes) all win first.
 */
export default function Missing(): never {
  notFound();
}
