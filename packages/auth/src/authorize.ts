/**
 * Central authorization helper (SR-X.7). Deny by default: every caller states the action,
 * and nothing trusts client-supplied ids or roles.
 */
export const ROLES = ['user', 'creator', 'seller', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Subject {
  userId: string;
  role: Role;
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
