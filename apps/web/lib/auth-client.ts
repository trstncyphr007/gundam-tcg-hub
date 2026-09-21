'use client';

import { passkeyClient } from '@better-auth/passkey/client';
import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Same-origin by design: requests go to /api/auth/* on this host and are proxied to the API
 * (next.config.ts), so the session cookie is never sent cross-site.
 *
 * That same-origin property is also what makes passkeys work at all: the WebAuthn ceremony
 * runs against *this* page's origin, which is the relying party's configured origin
 * (ADR-025) — never the API's.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [magicLinkClient(), passkeyClient()],
});

export const { useSession, signOut } = authClient;
