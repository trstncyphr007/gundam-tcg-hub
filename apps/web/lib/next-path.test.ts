import { describe, expect, it } from 'vitest';
import { DEFAULT_AFTER_SIGN_IN, safeNextPath } from './next-path';

describe('safeNextPath (SR-X.13)', () => {
  it.each([
    ['/admin/moderation', '/admin/moderation'],
    ['/breaks/abc?tab=pulls', '/breaks/abc?tab=pulls'],
    ['/account/watches#top', '/account/watches#top'],
  ])('keeps a path on this origin: %s', (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    'https://evil.test/admin',
    'http://evil.test',
    '//evil.test/admin',
    '/\\evil.test',
    '\\\\evil.test',
    'javascript:alert(1)',
    'data:text/html,hi',
    'admin/moderation',
    '/admin\u0000/x',
    '/admin\n/x',
    '/a/\\b',
    ' /admin',
    '',
    `/${'x'.repeat(300)}`,
  ])('falls back rather than trying to rescue %s', (raw) => {
    expect(safeNextPath(raw)).toBe(DEFAULT_AFTER_SIGN_IN);
  });

  it('falls back for a missing value', () => {
    expect(safeNextPath(null)).toBe(DEFAULT_AFTER_SIGN_IN);
    expect(safeNextPath(undefined)).toBe(DEFAULT_AFTER_SIGN_IN);
  });
});
