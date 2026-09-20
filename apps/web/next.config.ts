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

  // No server-side image optimisation: we render no remote images yet, and it would pull
  // sharp/libvips (LGPL-3.0) into the shipped image for nothing. Revisit if we serve images.
  images: { unoptimized: true },

  rewrites: () =>
    Promise.resolve([
      { source: '/api/auth/:path*', destination: `${apiUrl}/api/auth/:path*` },
      { source: '/v1/:path*', destination: `${apiUrl}/v1/:path*` },
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
