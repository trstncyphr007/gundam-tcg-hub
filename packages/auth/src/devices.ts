/**
 * A coarse, human name for the device behind a session: "Chrome on Windows" (ADR-026).
 *
 * Deliberately coarse. It is shown to the account's owner and compared to decide whether a
 * sign-in came from somewhere new — and for both, "which browser on which kind of machine" is
 * the useful level. Anything finer (versions, build numbers, device models) would change on
 * every update and make every sign-in look new, and would turn a label into a fingerprint we
 * have no reason to keep (SR-X.24).
 *
 * The user agent is untrusted input and trivially forged. That is fine for what this is: a
 * label the owner reads, and a trigger for an email that errs towards sending. It is never an
 * input to any decision that grants anything.
 */

/** Order matters: Edge and Opera both claim to be Chrome, and Chrome claims to be Safari. */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\/|\bChromium\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

/** iPhone and iPad before macOS, because iPadOS can say "Mac OS X"; Android before Linux. */
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b|\biPod\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/** Longer than any real user agent needs; bounds the work done on a hostile header. */
const MAX_USER_AGENT_LENGTH = 512;

function first(table: readonly (readonly [RegExp, string])[], ua: string): string | null {
  for (const [pattern, name] of table) {
    if (pattern.test(ua)) return name;
  }
  return null;
}

export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent.slice(0, MAX_USER_AGENT_LENGTH);
  const browser = first(BROWSERS, ua);
  const system = first(SYSTEMS, ua);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? 'Unknown device';
}
