import { describe, expect, it } from 'vitest';
import { signLink, verifyLink } from './signed-link.js';

/**
 * A link that acts on somebody's account without a session (SR-1.12, SR-X.17).
 *
 * The only thing standing between a stranger and somebody else's watch is the signature, so
 * these are about the ways a signature can be got round rather than the happy path.
 */
const PEPPER = 'a-pepper-of-at-least-thirty-two-characters';
const OTHER = 'a-different-pepper-also-at-least-32-chars!';
const PURPOSE = 'unsubscribe:watch';
const ID = '3f2b7c84-11aa-4e2b-9a0b-6d51f0a7c9e1';

describe('signLink', () => {
  it('round-trips the id it was given', () => {
    expect(verifyLink(PURPOSE, signLink(PURPOSE, ID, PEPPER), PEPPER)).toBe(ID);
  });

  it('is stable, so a link in an old email still works', () => {
    expect(signLink(PURPOSE, ID, PEPPER)).toBe(signLink(PURPOSE, ID, PEPPER));
  });

  it('is safe in a URL and a mail header', () => {
    expect(signLink(PURPOSE, ID, PEPPER)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('refuses an id it could not unambiguously read back', () => {
    expect(() => signLink(PURPOSE, 'has.a.separator', PEPPER)).toThrow(RangeError);
  });

  it('refuses a pepper too short to be one', () => {
    expect(() => signLink(PURPOSE, ID, 'short')).toThrow(RangeError);
  });
});

describe('verifyLink', () => {
  it('rejects a tampered id, even with the signature left intact', () => {
    // The obvious attack: take your own link and change the id to somebody else's watch.
    const link = signLink(PURPOSE, ID, PEPPER);
    const signature = link.slice(link.lastIndexOf('.'));
    const theirs = '00000000-0000-4000-8000-000000000000';
    expect(verifyLink(PURPOSE, `${theirs}${signature}`, PEPPER)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const link = signLink(PURPOSE, ID, PEPPER);
    expect(
      verifyLink(PURPOSE, `${link.slice(0, -1)}${link.endsWith('A') ? 'B' : 'A'}`, PEPPER),
    ).toBeNull();
  });

  it('rejects a link signed for a different purpose', () => {
    // Why the purpose is signed rather than just the id: a link minted to unsubscribe must
    // not be presentable to whatever the next signed link turns out to do.
    const link = signLink('unsubscribe:watch', ID, PEPPER);
    expect(verifyLink('delete:account', link, PEPPER)).toBeNull();
  });

  it('rejects a link signed with a different pepper', () => {
    // Which is what makes rotating TOKEN_PEPPER a way to invalidate every outstanding link.
    expect(verifyLink(PURPOSE, signLink(PURPOSE, ID, OTHER), PEPPER)).toBeNull();
  });

  it('rejects the shapes that are not links at all', () => {
    for (const value of ['', '.', 'nosignature', `${ID}.`, `.${ID}`, 'a.b.c']) {
      expect(verifyLink(PURPOSE, value, PEPPER), value).toBeNull();
    }
  });

  it('gives the same answer for every kind of failure', () => {
    // Null throughout, on purpose: a caller has nothing useful to do with the difference, and
    // an endpoint that reported it would tell a stranger which guess was closest.
    expect(verifyLink(PURPOSE, 'rubbish', PEPPER)).toBeNull();
    expect(verifyLink(PURPOSE, `${ID}.wrong`, PEPPER)).toBeNull();
    expect(verifyLink('other', signLink(PURPOSE, ID, PEPPER), PEPPER)).toBeNull();
  });
});
