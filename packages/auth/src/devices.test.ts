import { describe, expect, it } from 'vitest';
import { describeDevice } from './devices.js';

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  operaMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 OPR/124.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
};

describe('describeDevice (ADR-026)', () => {
  it.each([
    [UA.chromeWindows, 'Chrome on Windows'],
    [UA.edgeWindows, 'Edge on Windows'],
    [UA.operaMac, 'Opera on macOS'],
    [UA.safariMac, 'Safari on macOS'],
    [UA.safariIphone, 'Safari on iPhone'],
    [UA.chromeIphone, 'Chrome on iPhone'],
    [UA.firefoxLinux, 'Firefox on Linux'],
    [UA.chromeAndroid, 'Chrome on Android'],
    [UA.samsungAndroid, 'Samsung Internet on Android'],
    [UA.chromeOs, 'Chrome on ChromeOS'],
    [UA.ipad, 'Safari on iPad'],
  ])('names %s', (ua, expected) => {
    expect(describeDevice(ua)).toBe(expected);
  });

  it('ignores versions, so an update is not a new device', () => {
    expect(describeDevice(UA.chromeWindows)).toBe(
      describeDevice(UA.chromeWindows.replace('140.0.0.0', '141.0.7390.54')),
    );
  });

  it('says so when it cannot tell, rather than guessing', () => {
    expect(describeDevice(null)).toBe('Unknown device');
    expect(describeDevice('')).toBe('Unknown device');
    expect(describeDevice('curl/8.9.1')).toBe('Unknown device');
  });

  it('names what it can when only half is recognisable', () => {
    expect(describeDevice('SomeBot (Windows NT 10.0)')).toBe('Windows');
  });

  it('never echoes the header back, so a hostile one cannot reach an email', () => {
    const hostile = '<script>alert(1)</script> Firefox/1.0 '.repeat(200);
    const name = describeDevice(hostile);
    expect(name).toBe('Firefox');
    expect(name).not.toContain('<');
  });
});
