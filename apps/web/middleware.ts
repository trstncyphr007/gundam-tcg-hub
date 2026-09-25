import { type NextRequest, NextResponse } from 'next/server';
import { buildCsp } from './lib/csp';

/**
 * Per-request Content-Security-Policy with a nonce (SR-2.3/SR-X.14).
 *
 * The policy itself is built in `lib/csp.ts`, where it can be tested. This file supplies the
 * two things that only exist at request time: the nonce, and the configured photo origin.
 *
 * `PHOTO_STORAGE_ORIGIN` is the public origin of the listing-photo bucket — the one the
 * *browser* reaches, which is not necessarily the one the API uses (locally they differ by
 * nothing, in production the API may talk to R2 over an internal name). It is deliberately a
 * separate variable from `S3_ENDPOINT` for that reason, and the web app is given only it.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const csp = buildCsp({
    nonce,
    dev: process.env.NODE_ENV === 'development',
    photoOrigin: process.env['PHOTO_STORAGE_ORIGIN'],
  });

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  // Next reads the nonce out of the CSP on the *request* headers and stamps it onto its own
  // script tags. Without this it emits un-nonced scripts, which 'strict-dynamic' then blocks,
  // leaving a page that renders but never hydrates.
  headers.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  /**
   * Node, not edge, because the policy reads configuration.
   *
   * On the edge runtime Next inlines `process.env.X` at build time and leaves anything it
   * cannot see statically — which includes every bracket access — as undefined at run time.
   * The photo origin would then be baked into the image in CI, where it is not known, and the
   * symptom would be uploads that fail in the browser with a console message nobody sees.
   */
  runtime: 'nodejs',
  matcher: [
    // Everything except static assets and the proxied API paths.
    '/((?!_next/static|_next/image|favicon.ico|api/auth|v1).*)',
  ],
};
