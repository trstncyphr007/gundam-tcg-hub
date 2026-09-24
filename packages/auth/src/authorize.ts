/**
 * Central authorization helper (SR-X.7). Deny by default: every caller states the action,
 * and nothing trusts client-supplied ids or roles.
 */
export const ROLES = ['user', 'creator', 'seller', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Subject {
  userId: string;
  role: Role;
  /**
   * When this session was created — i.e. when the person last actually signed in, as opposed
   * to when the session was last refreshed. Absent for callers with no sign-in at all, and
   * absent means "not fresh" to `requireFreshSession`, never "just now".
   */
  authenticatedAt?: Date | undefined;
  /**
   * How the session was opened — set server-side from the endpoint that created it, never
   * from the client (ADR-025). Only `passkey` passes the admin gate.
   */
  authMethod?: 'passkey' | 'magic_link' | 'discord' | null | undefined;
  /**
   * The id of the session making this request — never its token. Lets the sessions page say
   * "this device" and keep it when signing out everywhere else (ADR-026).
   */
  sessionId?: string | undefined;
}

export interface OwnedResource {
  ownerId: string;
}

export type Action =
  | 'catalog:read'
  | 'catalog:write'
  | 'account:read'
  | 'account:write'
  | 'watch:read'
  | 'watch:write'
  | 'collection:read'
  | 'collection:write'
  | 'break:read'
  | 'break:write'
  | 'profile:write'
  | 'live_sale:read'
  | 'live_sale:write'
  | 'listing:read'
  | 'listing:write'
  | 'admin:access';

const BASE_ACTIONS: readonly Action[] = [
  'catalog:read',
  'account:read',
  'account:write',
  'watch:read',
  'watch:write',
  // A collection is a user's own list. Reading someone else's is decided by the row's
  // visibility, not by a role, which is why both of these are ownership-checked at the call
  // site and again by row-level security.
  'collection:read',
  'collection:write',
  /**
   * Selling a card (FR-5.2) is not a role.
   *
   * The obvious design is to gate this on the `seller` role, and it is wrong: role changes are
   * admin-only and audited (SR-X.9), so every person who wanted to sell one card would wait
   * for somebody to promote them. A marketplace with a queue at the door is not one.
   *
   * The real gate is Stripe's. FR-5.1 says a listing may go on sale only once
   * `charges_enabled` and `payouts_enabled` are both true, which means the identity check has
   * been done by the people whose job that is — and the answer arrives on a webhook rather
   * than from anything a seller can assert. That is a stronger gate than a row in our own
   * table, and it is checked where publishing happens rather than here.
   *
   * So: anybody signed in may draft and manage a listing. Whether it can go live is a question
   * for the connected account, and whether it can be paid for is a question for Stripe.
   */
  'listing:read',
  'listing:write',
];

/**
 * Running a break is a creator privilege (FR-2.2). The public break page and the OBS
 * overlay are read by people with no account at all, so they don't go through here --
 * the overlay is gated by its token and the public page by the break being published.
 *
 * A breaker profile (FR-4.3) is the same shape: writing one is a creator privilege, and
 * reading one needs no permission at all because an unpublished profile is not a row anyone
 * else can select.
 */
const CREATOR_ACTIONS: readonly Action[] = ['break:read', 'break:write', 'profile:write'];

/**
 * Logging live sales (FR-4.1).
 *
 * Held by sellers **and** creators, because the two overlap in practice: somebody running a
 * break on stream sells singles between packs, and making them hold two roles to describe
 * one evening would mean either granting the wrong one or granting both to everybody.
 *
 * These entries become price observations at the highest weight the index gives anything, so
 * the role is the first of three gates: a session cannot write such an observation at all
 * (migration 0013), the entry passes through the worker first, and an odd price is held for
 * review before it counts (SR-4.4).
 */
const SELLER_ACTIONS: readonly Action[] = ['live_sale:read', 'live_sale:write'];

/** Role → actions granted to every holder of that role, regardless of ownership. */
const ROLE_GRANTS = new Map<Role, readonly Action[]>([
  ['user', BASE_ACTIONS],
  ['creator', [...BASE_ACTIONS, ...CREATOR_ACTIONS, ...SELLER_ACTIONS]],
  ['seller', [...BASE_ACTIONS, ...SELLER_ACTIONS]],
  [
    'admin',
    [...BASE_ACTIONS, ...CREATOR_ACTIONS, ...SELLER_ACTIONS, 'catalog:write', 'admin:access'],
  ],
]);

function grantsFor(role: Role): readonly Action[] {
  return ROLE_GRANTS.get(role) ?? [];
}

/**
 * Returns true only when the subject may perform the action. When a resource is supplied,
 * ownership is required as well (non-admins), which is the IDOR guard (SR-X.6, T4).
 */
export function can(subject: Subject | null, action: Action, resource?: OwnedResource): boolean {
  if (!subject) return false;
  if (!ROLES.includes(subject.role)) return false;
  if (!grantsFor(subject.role).includes(action)) return false;
  if (resource && subject.role !== 'admin' && resource.ownerId !== subject.userId) return false;
  return true;
}

export class ForbiddenError extends Error {
  readonly action: Action;
  constructor(action: Action) {
    super(`forbidden: ${action}`);
    this.name = 'ForbiddenError';
    this.action = action;
  }
}

/** Throwing variant for route handlers. */
export function authorize(
  subject: Subject | null,
  action: Action,
  resource?: OwnedResource,
): asserts subject is Subject {
  if (!can(subject, action, resource)) throw new ForbiddenError(action);
}
