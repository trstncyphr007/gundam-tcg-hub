/**
 * The Content-Security-Policy, built here so it can be tested without a request.
 *
 * It lives in its own module because of `photoOrigin`. Everything else in the policy is a
 * literal; that one is configuration, and configuration interpolated into a header is how a
 * policy gets an extra directive it never asked for. A CSP is semicolon-separated, so a value
 * of `https://evil.test; script-src *` would be two directives, the second of which undoes the
 * whole file. `originOf` is what makes that impossible, and it is worth a test of its own.
 */

/**
 * The scheme, host and port of a URL, and nothing else.
 *
 * Rebuilt from a parsed URL rather than trimmed from the string, so whatever arrives — a path,
 * a query, credentials, a semicolon, a newline — cannot survive into the header. Anything
 * unparseable, or not http(s), is `null`: a CSP that silently gained a `file:` source would be
 * worse than one that blocks an image.
 */
export function originOf(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // `url.host` is the host plus the port when there is a non-default one, which is exactly
  // what a CSP source expression wants. It is percent-encoded and cannot contain a separator.
  return `${url.protocol}//${url.host}`;
}

export interface CspOptions {
  nonce: string;
  /** The dev server injects its own un-nonced inline scripts and styles. */
  dev: boolean;
  /**
   * Where listing photos live (SR-5.5). Object storage on another origin, which the browser
   * has to reach twice: a presigned PUT to upload, and a short-lived signed GET to display.
   * Undefined when the marketplace is not configured, and then neither source is added —
   * a deployment without photos keeps the tighter policy rather than inheriting a hole.
   */
  photoOrigin?: string | undefined;
}

export function buildCsp({ nonce, dev, photoOrigin }: CspOptions): string {
  // No 'unsafe-inline' for scripts: Next picks up the nonce from this header and stamps it on
  // its own inline bootstrap. 'strict-dynamic' lets those trusted scripts load their chunks
  // while still blocking injected ones.
  //
  // The dev server injects its own un-nonced inline scripts (fast refresh), and
  // 'strict-dynamic' makes browsers ignore 'unsafe-inline', so dev gets a looser policy.
  // Production keeps the strict nonce policy, which the e2e suite asserts.
  const scriptSrc = dev
    ? `script-src 'self' 'unsafe-inline' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
  // No inline styles either, in production (ADR-031). Components style with classes from the
  // build's stylesheet; a style *attribute* anywhere is refused, which closes CSS injection —
  // selector-based exfiltration and UI redress — as well as script injection. The dev server
  // injects its own unnonced <style> tags for hot reload, so dev keeps the looser policy, as
  // it does for scripts.
  const styleSrc = dev ? `style-src 'self' 'unsafe-inline'` : `style-src 'self' 'nonce-${nonce}'`;

  const storage = originOf(photoOrigin);
  const photos = storage === null ? '' : ` ${storage}`;

  return [
    `default-src 'self'`,
    scriptSrc,
    styleSrc,
    // No `https:` here. That is a wildcard: it permits an image from any HTTPS origin, which
    // is both an exfiltration channel (the path carries data) and a tracking one. Card art is
    // linked, not embedded (plan §23). The one remote origin named here is our own photo
    // bucket, by exact origin, because a seller's photograph of their own card is the only
    // remote image this site renders.
    `img-src 'self' data:${photos}`,
    `font-src 'self'`,
    // Same origin, for the other half of the same flow: the browser PUTs the file straight to
    // the bucket rather than through this site, so `fetch` has to be allowed to reach it.
    `connect-src 'self'${photos}`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');
}
