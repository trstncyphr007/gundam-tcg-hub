import type { NextConfig } from 'next';

/**
 * The API is proxied under the web origin, so the browser only ever talks to one origin:
 * session cookies stay same-origin (no SameSite=None, no CORS). Caddy does the same path
 * routing in production (plan §15.3).
 */
const apiUrl = process.env['API_INTERNAL_URL'] ?? 'http://127.0.0.1:4000';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,

  /**
   * Next gzips responses by default, including the ones it proxies. A gzip stream buffers
   * until it has enough to emit a block, which silently breaks server-sent events: the OBS
   * overlay's connection opens, the headers arrive, and then no event is delivered until
   * the connection closes. Caddy compresses at the edge in production, so Next doing it
   * again behind the proxy bought nothing anyway.
   */
  compress: false,

  /**
   * Dev only. The dev server refuses to serve its own HMR and chunk requests to an origin
   * it does not recognise, and the e2e suite drives the app on 127.0.0.1 rather than
   * localhost. Without this the pages render but never hydrate: a form then submits as a
   * plain GET, which looks like a broken app and is really a blocked script.
   * Has no effect on a production build.
   */
  allowedDevOrigins: ['127.0.0.1', 'localhost'],

  // No server-side image optimisation: we render no remote images yet, and it would pull
  // sharp/libvips (LGPL-3.0) into the shipped image for nothing. Revisit if we serve images.
  images: { unoptimized: true },

  rewrites: () =>
    Promise.resolve([
      { source: '/api/auth/:path*', destination: `${apiUrl}/api/auth/:path*` },
      { source: '/v1/:path*', destination: `${apiUrl}/v1/:path*` },
      // The API documents itself, and a developer arrives at the site rather than the API
      // host. Proxying keeps "read the docs" a link rather than an explanation of which
      // hostname to use.
      { source: '/docs', destination: `${apiUrl}/docs` },
      { source: '/docs/:path*', destination: `${apiUrl}/docs/:path*` },
    ]),

  // CSP is set per-request in middleware.ts (it carries a nonce); these are static.
  headers: () =>
    Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ]),
};

export default nextConfig;
