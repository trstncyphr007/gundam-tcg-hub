import { type NextRequest, NextResponse } from 'next/server';

/**
 * Per-request Content-Security-Policy with a nonce (SR-2.3/SR-X.14).
 *
 * No 'unsafe-inline' for scripts: Next picks up the nonce from this header and stamps it on
 * its own inline bootstrap. 'strict-dynamic' lets those trusted scripts load their chunks
 * while still blocking injected ones.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  // The dev server injects its own un-nonced inline scripts (fast refresh), and
  // 'strict-dynamic' makes browsers ignore 'unsafe-inline', so dev gets a looser policy.
  // Production keeps the strict nonce policy, which the e2e suite asserts.
  const scriptSrc = isDev
    ? `script-src 'self' 'unsafe-inline' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  const csp = [
    `default-src 'self'`,
    scriptSrc,
    // Tailwind injects styles at build time; inline styles stay allowed, scripts do not.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');

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
  matcher: [
    // Everything except static assets and the proxied API paths.
    '/((?!_next/static|_next/image|favicon.ico|api/auth|v1).*)',
  ],
};
