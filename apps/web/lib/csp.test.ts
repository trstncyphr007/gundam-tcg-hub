import { describe, expect, it } from 'vitest';
import { buildCsp, originOf } from './csp';

/** The directives, split back out, so a test can assert about one without matching a string. */
function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split('; ').map((part) => {
      const space = part.indexOf(' ');
      return space === -1 ? [part, ''] : [part.slice(0, space), part.slice(space + 1)];
    }),
  );
}

describe('originOf', () => {
  it('keeps the scheme, host and port', () => {
    expect(originOf('https://photos.example.test')).toBe('https://photos.example.test');
    expect(originOf('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000');
  });

  it('drops everything after the authority', () => {
    expect(originOf('https://photos.example.test/bucket/key?x=1#f')).toBe(
      'https://photos.example.test',
    );
  });

  it('drops the default port, because a CSP source with one would not match without it', () => {
    expect(originOf('https://photos.example.test:443')).toBe('https://photos.example.test');
  });

  /**
   * The reason this function exists.
   *
   * A CSP is semicolon-separated. A configured value carrying a semicolon would not be a
   * source expression, it would be a second directive — and the obvious second directive to
   * append is the one that undoes the first.
   */
  it('cannot be used to append a directive', () => {
    const smuggled = "https://evil.test; script-src * 'unsafe-inline'";
    // Either it fails to parse, or the authority survives and nothing else does. Both are
    // safe; assert the property rather than which one this input happens to hit.
    const origin = originOf(smuggled);
    expect(origin === null || !origin.includes(';')).toBe(true);
    expect(origin === null || !origin.includes(' ')).toBe(true);
  });

  it.each([
    ['a newline', 'https://evil.test\nscript-src *'],
    ['credentials in the authority', 'https://user:pass@photos.example.test'],
    ['a scheme that is not http(s)', 'file:///etc/passwd'],
    ['a bare host', 'photos.example.test'],
    ['a wildcard', '*'],
    ['nothing', ''],
    ['undefined', undefined],
  ])('refuses or neutralises %s', (_label, value) => {
    const origin = originOf(value);
    if (origin === null) return;
    expect(origin).toMatch(/^https?:\/\/[^\s;'"*]+$/u);
  });
});

describe('buildCsp', () => {
  const nonce = 'dGVzdC1ub25jZQ';

  it('nonces scripts and styles in production, and allows neither inline', () => {
    const csp = directives(buildCsp({ nonce, dev: false }));
    expect(csp.get('script-src')).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp.get('style-src')).toBe(`'self' 'nonce-${nonce}'`);
    expect(csp.get('script-src')).not.toContain('unsafe-inline');
  });

  it('loosens only scripts and styles for the dev server', () => {
    const dev = directives(buildCsp({ nonce, dev: true }));
    const prod = directives(buildCsp({ nonce, dev: false }));
    for (const [name, value] of prod) {
      if (name === 'script-src' || name === 'style-src') continue;
      expect(dev.get(name)).toBe(value);
    }
  });

  it('adds no remote source when photos are not configured', () => {
    const csp = directives(buildCsp({ nonce, dev: false }));
    expect(csp.get('img-src')).toBe(`'self' data:`);
    expect(csp.get('connect-src')).toBe(`'self'`);
  });

  /**
   * Both halves of the upload flow, in one assertion, because getting one without the other is
   * the failure that looks like a working feature: the photo uploads and then does not appear,
   * or appears for the seller who uploaded it before the policy tightened.
   */
  it('names the photo origin for both the upload and the display', () => {
    const csp = directives(buildCsp({ nonce, dev: false, photoOrigin: 'http://127.0.0.1:8000' }));
    expect(csp.get('img-src')).toBe(`'self' data: http://127.0.0.1:8000`);
    expect(csp.get('connect-src')).toBe(`'self' http://127.0.0.1:8000`);
  });

  it('never widens a directive to a scheme wildcard', () => {
    const csp = buildCsp({ nonce, dev: false, photoOrigin: 'https://photos.example.test' });
    expect(csp).not.toMatch(/(img|connect|script|style)-src[^;]*\s(https:|http:|\*)(\s|;|$)/u);
  });

  it('keeps a malformed photo origin out of the header entirely', () => {
    const csp = buildCsp({ nonce, dev: false, photoOrigin: 'not a url' });
    expect(csp).toBe(buildCsp({ nonce, dev: false }));
  });
});
