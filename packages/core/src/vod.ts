/**
 * VOD timestamps (FR-4.4).
 *
 * A pull log says what came out of a pack. A VOD timestamp says *go and watch it happen* —
 * which is the difference between a record people have to accept and one they can check.
 *
 * Everything here is string handling on a URL the creator pasted. We never fetch it: the
 * link is evidence for a reader, not an input to anything of ours, and treating it as one
 * would turn a convenience into an SSRF surface for nothing (SR-1.1).
 */

/** Longer than any stream, and a bound on a number that ends up in a URL. */
export const MAX_VOD_OFFSET_SECONDS = 24 * 60 * 60;

export class VodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VodError';
  }
}

/** Unit letters, largest first. A duration may use each at most once, in this order. */
const UNIT_SECONDS = new Map([
  ['h', 3600],
  ['m', 60],
  ['s', 1],
]);

/**
 * Read a duration the way a person or a platform writes one.
 *
 * Accepts `3723`, `3723s`, `1h2m3s`, `62m`, `1:02:03` and `2:03`. Returns null for anything
 * else rather than guessing — a misread timestamp points a viewer at the wrong moment and
 * looks, to them, like the log being wrong.
 *
 * Hand-scanned rather than pattern-matched. The regex for this is a chain of optional
 * unbounded groups, which is the shape static analysis objects to and the shape that is
 * genuinely awkward to reason about; a single left-to-right pass is linear by construction
 * and states the "h, then m, then s, each at most once" rule in a line you can read.
 */
export function parseDurationToSeconds(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/u.test(trimmed)) return bounded(Number(trimmed));
  return trimmed.includes(':') ? parseClock(trimmed) : parseUnits(trimmed);
}

/** `1:02:03` or `2:03`. */
function parseClock(text: string): number | null {
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    values.push(Number(part));
  }
  // Pad to h:m:s so the arithmetic below has one shape.
  const [hours, minutes, seconds] = values.length === 3 ? values : [0, ...values];
  if (hours === undefined || minutes === undefined || seconds === undefined) return null;
  // Only the leading field may exceed 59: `90:00` is ninety minutes, `1:90:00` is nothing.
  if (minutes > 59 || seconds > 59) return null;
  return bounded(hours * 3600 + minutes * 60 + seconds);
}

/** `1h2m3s`, `62m`, `90s`. */
function parseUnits(text: string): number | null {
  let total = 0;
  let digits = '';
  let previousWeight = Number.POSITIVE_INFINITY;
  let sawUnit = false;

  for (const character of text.toLowerCase()) {
    if (character >= '0' && character <= '9') {
      digits += character;
      continue;
    }
    const weight = UNIT_SECONDS.get(character);
    // An unknown letter, a unit with no number, or a unit out of order (`3s2m`, `1h1h`).
    if (weight === undefined || digits === '' || weight >= previousWeight) return null;
    previousWeight = weight;
    total += Number(digits) * weight;
    digits = '';
    sawUnit = true;
  }

  // Trailing digits mean a number with no unit, which the caller already handled if the
  // whole string was digits — so here it is `1h30` and we do not guess what 30 means.
  if (digits !== '' || !sawUnit) return null;
  return bounded(total);
}

function bounded(seconds: number): number | null {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_VOD_OFFSET_SECONDS) return null;
  return seconds;
}

/**
 * Pull the timestamp out of a link that already carries one.
 *
 * Creators copy links from the platform's own "copy at current time" button, so the offset
 * is usually already in the URL. Reading it beats asking them to type it again, and typing
 * it again is where a wrong number comes from.
 */
export function parseVodOffset(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  for (const key of ['t', 'start', 'time_continue']) {
    const value = parsed.searchParams.get(key);
    if (value !== null) {
      const seconds = parseDurationToSeconds(value);
      if (seconds !== null) return seconds;
    }
  }

  // `#t=90` — the media-fragment form, which Vimeo and plain HTML5 players use.
  const fragment = /^#t=(.+)$/u.exec(parsed.hash);
  return fragment?.[1] === undefined ? null : parseDurationToSeconds(fragment[1]);
}

/** `1:02:03`, or `2:03` under an hour. What a player's own scrubber shows. */
export function formatVodOffset(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new VodError(`an offset must be a whole number of seconds, got ${String(seconds)}`);
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

function isHost(url: URL, ...suffixes: string[]): boolean {
  const host = url.hostname.toLowerCase();
  // Suffix match on a dot boundary, so `evil-twitch.tv` is not `twitch.tv`.
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Point a link at a moment.
 *
 * Twitch wants `1h02m03s`; almost everything else takes plain seconds. Getting this wrong is
 * not harmless — Twitch silently ignores a numeric `t` and drops the viewer at the start of a
 * six-hour VOD, which reads as the link being broken.
 *
 * Only `https:` is accepted. The result is a link we hand to a reader, and an `http:` or
 * `javascript:` URL pasted into that slot is not a timestamp problem.
 */
export function withVodOffset(url: string, seconds: number): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VodError('that is not a URL');
  }
  if (parsed.protocol !== 'https:') throw new VodError('a VOD link must be https');
  if (bounded(seconds) === null) {
    throw new VodError(`an offset must be between 0 and ${String(MAX_VOD_OFFSET_SECONDS)} seconds`);
  }

  if (isHost(parsed, 'twitch.tv')) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    parsed.searchParams.set(
      't',
      `${String(h)}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`,
    );
  } else {
    parsed.searchParams.set('t', String(seconds));
  }
  // A `#t=` left over from a pasted link would override the query on some players, so the
  // fragment goes rather than fighting with the parameter we just set.
  if (/^#t=/u.test(parsed.hash)) parsed.hash = '';
  return parsed.toString();
}

/** An https URL we are willing to put in front of a reader. */
export function isUsableVodUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
