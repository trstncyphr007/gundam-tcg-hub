import { describe, expect, it } from 'vitest';
import {
  MAX_VOD_OFFSET_SECONDS,
  VodError,
  formatVodOffset,
  isUsableVodUrl,
  parseDurationToSeconds,
  parseVodOffset,
  withVodOffset,
} from './vod.js';

describe('parseDurationToSeconds', () => {
  it.each([
    ['3723', 3723],
    ['0', 0],
    ['90s', 90],
    ['1h2m3s', 3723],
    ['1h', 3600],
    ['62m', 3720],
    ['1:02:03', 3723],
    ['2:03', 123],
    ['0:05', 5],
    ['  3723  ', 3723],
    ['1H2M3S', 3723],
  ])('reads %s as %d seconds', (text, expected) => {
    expect(parseDurationToSeconds(text)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'soon',
    '1h2x',
    '-30',
    '1.5',
    '99:99',
    'NaN',
    '1h30', // a number with no unit: we do not guess what 30 means
    '3s2m', // out of order
    '1h1h', // the same unit twice
    'h',
    '1:2:3:4',
  ])('returns null for %s rather than guessing', (text) => {
    // A misread timestamp drops a viewer at the wrong moment, and to them that looks like
    // the log being wrong rather than the link.
    expect(parseDurationToSeconds(text)).toBeNull();
  });

  it('refuses an offset longer than any stream', () => {
    expect(parseDurationToSeconds(String(MAX_VOD_OFFSET_SECONDS))).toBe(MAX_VOD_OFFSET_SECONDS);
    expect(parseDurationToSeconds(String(MAX_VOD_OFFSET_SECONDS + 1))).toBeNull();
  });
});

describe('parseVodOffset', () => {
  it('reads the timestamp a platform put in the link', () => {
    // Creators use the platform's own "copy at current time" button, so it is usually
    // already there — and asking them to retype it is where a wrong number comes from.
    expect(parseVodOffset('https://www.youtube.com/watch?v=abc&t=3723')).toBe(3723);
    expect(parseVodOffset('https://youtu.be/abc?t=3723s')).toBe(3723);
    expect(parseVodOffset('https://www.twitch.tv/videos/1?t=01h02m03s')).toBe(3723);
    expect(parseVodOffset('https://vimeo.com/1#t=123')).toBe(123);
    expect(parseVodOffset('https://example.invalid/v?start=90')).toBe(90);
  });

  it('returns null when there is no timestamp to read', () => {
    expect(parseVodOffset('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(parseVodOffset('https://www.youtube.com/watch?v=abc&t=later')).toBeNull();
    expect(parseVodOffset('not a url')).toBeNull();
  });
});

describe('formatVodOffset', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [123, '2:03'],
    [3600, '1:00:00'],
    [3723, '1:02:03'],
    [36_000, '10:00:00'],
  ])('shows %d as %s', (seconds, expected) => {
    expect(formatVodOffset(seconds)).toBe(expected);
  });

  it('refuses a nonsense offset', () => {
    expect(() => formatVodOffset(-1)).toThrow(VodError);
    expect(() => formatVodOffset(1.5)).toThrow(VodError);
  });

  it('round-trips with the parser', () => {
    for (const seconds of [0, 59, 60, 3599, 3600, 3723, 86_399]) {
      expect(parseDurationToSeconds(formatVodOffset(seconds))).toBe(seconds);
    }
  });
});

describe('withVodOffset', () => {
  it('uses plain seconds for YouTube and everything else', () => {
    expect(withVodOffset('https://www.youtube.com/watch?v=abc', 3723)).toBe(
      'https://www.youtube.com/watch?v=abc&t=3723',
    );
    expect(withVodOffset('https://example.invalid/v', 90)).toBe('https://example.invalid/v?t=90');
  });

  it('uses Twitch’s own format for Twitch', () => {
    // Twitch silently ignores a numeric `t` and drops the viewer at the start of a six-hour
    // VOD, which reads as the link being broken.
    expect(withVodOffset('https://www.twitch.tv/videos/1', 3723)).toBe(
      'https://www.twitch.tv/videos/1?t=1h02m03s',
    );
    expect(withVodOffset('https://twitch.tv/videos/1', 5)).toBe(
      'https://twitch.tv/videos/1?t=0h00m05s',
    );
  });

  it('does not mistake a lookalike host for Twitch', () => {
    expect(withVodOffset('https://evil-twitch.tv/videos/1', 3723)).toContain('t=3723');
  });

  it('replaces a timestamp the link already carried', () => {
    expect(withVodOffset('https://www.youtube.com/watch?v=abc&t=10', 20)).toBe(
      'https://www.youtube.com/watch?v=abc&t=20',
    );
  });

  it('drops a leftover #t fragment, which would override the parameter', () => {
    expect(withVodOffset('https://vimeo.com/1#t=10', 20)).toBe('https://vimeo.com/1?t=20');
  });

  it('keeps the rest of the query intact', () => {
    expect(withVodOffset('https://example.invalid/v?a=1&b=2', 7)).toBe(
      'https://example.invalid/v?a=1&b=2&t=7',
    );
  });

  it('accepts https only', () => {
    // The result is a link handed to a reader; an http: or javascript: URL in that slot is
    // not a timestamp problem.
    expect(() => withVodOffset('http://www.youtube.com/watch?v=abc', 10)).toThrow(VodError);
    expect(() => withVodOffset('javascript:alert(1)', 10)).toThrow(VodError);
    expect(() => withVodOffset('not a url', 10)).toThrow(VodError);
  });

  it('refuses an offset outside the bounds', () => {
    expect(() => withVodOffset('https://example.invalid/v', -1)).toThrow(VodError);
    expect(() => withVodOffset('https://example.invalid/v', MAX_VOD_OFFSET_SECONDS + 1)).toThrow(
      VodError,
    );
    expect(() => withVodOffset('https://example.invalid/v', 1.5)).toThrow(VodError);
  });
});

describe('isUsableVodUrl', () => {
  it.each(['https://www.youtube.com/watch?v=abc', 'https://twitch.tv/videos/1'])(
    'accepts %s',
    (url) => {
      expect(isUsableVodUrl(url)).toBe(true);
    },
  );

  it.each(['http://example.invalid/v', 'javascript:alert(1)', 'data:text/html,x', 'nope'])(
    'rejects %s',
    (url) => {
      expect(isUsableVodUrl(url)).toBe(false);
    },
  );
});
