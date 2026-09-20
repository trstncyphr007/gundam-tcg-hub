'use client';

import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Same-origin by design: requests go to /api/auth/* on this host and are proxied to the API
 * (next.config.ts), so the session cookie is never sent cross-site.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [magicLinkClient()],
});

export const { useSession, signOut } = authClient;
