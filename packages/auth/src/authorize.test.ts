import { describe, expect, it } from 'vitest';
import { ForbiddenError, type Role, type Subject, authorize, can } from './authorize.js';

const subject = (role: Role, userId = 'u1'): Subject => ({ userId, role });

describe('can', () => {
  it('denies anonymous callers everything', () => {
    expect(can(null, 'catalog:read')).toBe(false);
    expect(can(null, 'watch:read')).toBe(false);
    expect(can(null, 'admin:access')).toBe(false);
  });

  it('denies an unknown role, even if it looks admin-ish', () => {
    const forged = { userId: 'u1', role: 'superadmin' } as unknown as Subject;
    expect(can(forged, 'admin:access')).toBe(false);
    expect(can(forged, 'catalog:read')).toBe(false);
  });

  it('grants ordinary users their own account and watches, but not admin or catalog writes', () => {
    const user = subject('user');
    expect(can(user, 'catalog:read')).toBe(true);
    expect(can(user, 'watch:write')).toBe(true);
    expect(can(user, 'catalog:write')).toBe(false);
    expect(can(user, 'admin:access')).toBe(false);
  });

  it('blocks access to another user’s resource (IDOR guard)', () => {
    const user = subject('user', 'u1');
    expect(can(user, 'watch:read', { ownerId: 'u1' })).toBe(true);
    expect(can(user, 'watch:read', { ownerId: 'u2' })).toBe(false);
    expect(can(user, 'watch:write', { ownerId: 'u2' })).toBe(false);
  });

  it('lets admins act on resources they do not own', () => {
    const admin = subject('admin', 'a1');
    expect(can(admin, 'watch:read', { ownerId: 'someone-else' })).toBe(true);
    expect(can(admin, 'catalog:write')).toBe(true);
    expect(can(admin, 'admin:access')).toBe(true);
  });

  it('gives creator and seller the same base rights as a user, not more', () => {
    for (const role of ['creator', 'seller'] as const) {
      expect(can(subject(role), 'watch:write')).toBe(true);
      expect(can(subject(role), 'admin:access')).toBe(false);
      expect(can(subject(role), 'catalog:write')).toBe(false);
    }
  });
});

describe('authorize', () => {
  it('passes for an allowed action', () => {
    expect(() => {
      authorize(subject('user'), 'watch:read', { ownerId: 'u1' });
    }).not.toThrow();
  });

  it('throws ForbiddenError naming the action', () => {
    try {
      authorize(subject('user'), 'admin:access');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).action).toBe('admin:access');
    }
  });

  it('throws for anonymous callers', () => {
    expect(() => {
      authorize(null, 'catalog:read');
    }).toThrow(ForbiddenError);
  });
});
