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

/**
 * Whether search engines may index this site at all.
 *
 * `false` until launch, which makes every public page `noindex` and `robots.txt` a refusal.
 * Flipping this one constant is the whole of "go public" — and the reason it is a constant is
 * that the obvious alternative is worse: the `noindex` used to live in the site layout, so
 * going public meant deleting a line, and the easiest way to do that wrong is to delete it
 * everywhere and hand Google the admin console, somebody's collection and a live overlay.
 *
 * Pages that must never be indexed — account, admin, the overlay — set their own `noindex` and
 * do not consult this. Going public cannot reach them.
 */
// Annotated `boolean` rather than inferred `false` for the same reason `CONTACT_EMAIL` is
// annotated: it is a switch with two real positions, and the compiler should not treat the
// other one as unreachable code.
export const SITE_IS_PUBLIC: boolean = false;

/** What the site layout tells crawlers, given the switch above. */
export const PUBLIC_ROBOTS = { index: SITE_IS_PUBLIC, follow: SITE_IS_PUBLIC };

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
