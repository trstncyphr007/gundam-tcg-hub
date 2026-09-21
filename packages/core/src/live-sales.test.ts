import { describe, expect, it } from 'vitest';
import {
  BUYER_HANDLE_RETENTION_DAYS,
  BuyerHandleError,
  buyerHandleExpired,
  buyerHandleExpiryFrom,
  normaliseBuyerHandle,
} from './live-sales.js';

describe('normaliseBuyerHandle', () => {
  it('drops a single leading @, because sellers type it half the time', () => {
    expect(normaliseBuyerHandle('@alice')).toBe('alice');
    expect(normaliseBuyerHandle('alice')).toBe('alice');
    // Two handles that are one person must not become two records.
    expect(normaliseBuyerHandle('@alice')).toBe(normaliseBuyerHandle('alice'));
  });

  it('keeps a second @, which is part of the name', () => {
    expect(normaliseBuyerHandle('@@odd')).toBe('@odd');
  });

  it('collapses whitespace', () => {
    expect(normaliseBuyerHandle('  alice   smith  ')).toBe('alice smith');
    expect(normaliseBuyerHandle('@  alice')).toBe('alice');
  });

  it('treats blank as "no handle", which is a supported answer', () => {
    // FR-4.1 makes the handle optional, and a seller who does not need it should not be
    // storing somebody's name.
    expect(normaliseBuyerHandle('')).toBeNull();
    expect(normaliseBuyerHandle('   ')).toBeNull();
    expect(normaliseBuyerHandle('@')).toBeNull();
    expect(normaliseBuyerHandle(null)).toBeNull();
    expect(normaliseBuyerHandle(undefined)).toBeNull();
  });

  it('preserves case, because a handle is not ours to fold', () => {
    expect(normaliseBuyerHandle('@AliceInWonderland')).toBe('AliceInWonderland');
  });

  it('rejects an over-long handle', () => {
    expect(normaliseBuyerHandle('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => normaliseBuyerHandle('a'.repeat(65))).toThrow(BuyerHandleError);
  });

  it('rejects control characters, which would survive into a CSV and a log line', () => {
    expect(() => normaliseBuyerHandle('ali\u0000ce')).toThrow(BuyerHandleError);
    expect(() => normaliseBuyerHandle('ali\u001bce')).toThrow(BuyerHandleError);
    expect(() => normaliseBuyerHandle('ali\u007fce')).toThrow(BuyerHandleError);
  });

  it('leaves ordinary punctuation and non-Latin names alone', () => {
    expect(normaliseBuyerHandle('@user.name_01-x')).toBe('user.name_01-x');
    expect(normaliseBuyerHandle('シャア')).toBe('シャア');
  });
});

describe('buyer handle retention (SR-4.5)', () => {
  const soldAt = new Date('2026-09-21T12:00:00Z');

  it('expires 90 days after the sale', () => {
    expect(BUYER_HANDLE_RETENTION_DAYS).toBe(90);
    expect(buyerHandleExpiryFrom(soldAt).toISOString()).toBe('2026-12-20T12:00:00.000Z');
  });

  it('is measured from the sale, not from when the row was written', () => {
    // A sale logged late is still 90 days old from when it happened.
    const late = new Date('2026-06-01T00:00:00Z');
    expect(buyerHandleExpired(late, soldAt)).toBe(true);
  });

  it('holds until the day it expires', () => {
    expect(buyerHandleExpired(soldAt, new Date('2026-12-19T12:00:00Z'))).toBe(false);
    expect(buyerHandleExpired(soldAt, new Date('2026-12-20T11:59:59Z'))).toBe(false);
    expect(buyerHandleExpired(soldAt, new Date('2026-12-20T12:00:00Z'))).toBe(true);
  });
});
