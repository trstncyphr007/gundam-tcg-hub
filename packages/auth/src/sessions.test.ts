import { describe, expect, it } from 'vitest';
import { mayRevoke } from './sessions.js';

describe('mayRevoke (ADR-026)', () => {
  const METHODS = ['passkey', 'magic_link', 'discord', null, undefined] as const;

  it('lets any session end any session that was not opened with a passkey', () => {
    for (const current of METHODS) {
      for (const target of ['magic_link', 'discord', null] as const) {
        expect(mayRevoke(current, target), `${String(current)} → ${String(target)}`).toBe(true);
      }
    }
  });

  it('lets only a passkey session end a passkey session', () => {
    expect(mayRevoke('passkey', 'passkey')).toBe(true);
    // Whoever holds the inbox must not be able to keep signing the owner out of the console.
    for (const current of ['magic_link', 'discord', null, undefined] as const) {
      expect(mayRevoke(current, 'passkey'), String(current)).toBe(false);
    }
  });
});
