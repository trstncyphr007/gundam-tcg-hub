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
  | 'admin:access';

const BASE_ACTIONS: readonly Action[] = [
  'catalog:read',
  'account:read',
  'account:write',
  'watch:read',
  'watch:write',
];

/** Role → actions granted to every holder of that role, regardless of ownership. */
const ROLE_GRANTS = new Map<Role, readonly Action[]>([
  ['user', BASE_ACTIONS],
  ['creator', BASE_ACTIONS],
  ['seller', BASE_ACTIONS],
  ['admin', [...BASE_ACTIONS, 'catalog:write', 'admin:access']],
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
