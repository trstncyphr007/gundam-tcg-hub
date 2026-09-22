/**
 * Facts the published pages state about this service (plan §23).
 *
 * The contact address is deliberately one value in one place. Until there is a domain there
 * is no role address to publish, and publishing a placeholder — or someone's personal inbox —
 * would be worse than publishing nothing: the policy pages say the contact is not live yet,
 * and `/.well-known/security.txt` is not served at all rather than pointing nowhere.
 *
 * To turn it on: set this to the address, e.g. `security@<domain>`, forwarded to a real inbox.
 * `docs/runbooks/vps-setup.md` lists it as a launch step.
 */
export const CONTACT_EMAIL: string | null = null;

/** Where `security.txt`'s `Expires` sits: RFC 9116 wants it under a year and kept current. */
export const SECURITY_TXT_EXPIRY_DAYS = 180;

export const LAST_UPDATED = '2026-09-23';

/** The published price index is open data (ADR-020). */
export const INDEX_LICENCE = {
  name: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
} as const;

/** The free API tier, as the quota plugin actually enforces it. */
export const API_LIMITS = { perMinute: 60, perDay: 1000 } as const;
