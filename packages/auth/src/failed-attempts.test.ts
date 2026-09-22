import { describe, expect, it } from 'vitest';
import { clientIp, describeFailure, isAuthAttemptPath } from './failed-attempts.js';

describe('which calls count as an attempt at a way in', () => {
  it.each([
    '/sign-in/magic-link',
    '/magic-link/verify',
    '/passkey/verify-authentication',
    '/callback/discord',
  ])('%s is watched', (path) => {
    expect(isAuthAttemptPath(path)).toBe(true);
  });

  it.each(['/get-session', '/passkey/delete-passkey', '/sign-out'])(
    '%s is not: a failure there is a mistake, not an attempt on an account',
    (path) => {
      expect(isAuthAttemptPath(path)).toBe(false);
    },
  );
});

describe('reading a refusal', () => {
  it('takes the code from a 4xx body', () => {
    expect(describeFailure({ statusCode: 401, body: { code: 'INVALID_PASSWORD' } })).toEqual({
      status: 401,
      code: 'INVALID_PASSWORD',
    });
  });

  it('records a 429 with its status, so it can be counted as a rate limit', () => {
    expect(describeFailure({ statusCode: 429, body: {} })).toEqual({ status: 429, code: null });
  });

  it('sees the refusal hiding in a redirect', () => {
    // How the magic-link flow actually says no. A recorder that only looked for 4xx wrote
    // nothing at all, and looked correct doing it.
    const redirect = {
      statusCode: 302,
      headers: { get: () => 'http://127.0.0.1:4000/?error=INVALID_TOKEN' },
    };
    expect(describeFailure(redirect)).toEqual({ status: 302, code: 'INVALID_TOKEN' });
  });

  it('treats a redirect without an error as the success it is', () => {
    const redirect = { statusCode: 302, headers: { get: () => 'http://127.0.0.1:3000/account' } };
    expect(describeFailure(redirect)).toBeNull();
  });

  it('is not fooled by a location that will not parse', () => {
    expect(describeFailure({ statusCode: 302, headers: { get: () => '%%%' } })).toBeNull();
    expect(describeFailure({ statusCode: 302, headers: { get: () => null } })).toBeNull();
  });

  it.each([[null], [undefined], ['no'], [{}], [{ statusCode: 200 }]])(
    'says nothing happened for %s',
    (returned) => {
      expect(describeFailure(returned)).toBeNull();
    },
  );
});

describe('where the caller came from', () => {
  const headers = (value: string | null): Headers =>
    new Headers(value === null ? {} : { 'x-forwarded-for': value });

  it('takes the first entry behind our own proxy', () => {
    expect(clientIp(headers('203.0.113.7, 10.0.0.1'), true)).toBe('203.0.113.7');
  });

  it('ignores the header entirely when we are not behind one', () => {
    // Off the proxy the header is whatever the caller typed; recording it as the source would
    // let anyone attribute their attempts to someone else.
    expect(clientIp(headers('203.0.113.7'), false)).toBeNull();
  });

  it('copes with the header being absent', () => {
    expect(clientIp(headers(null), true)).toBeNull();
    expect(clientIp(undefined, true)).toBeNull();
  });
});
