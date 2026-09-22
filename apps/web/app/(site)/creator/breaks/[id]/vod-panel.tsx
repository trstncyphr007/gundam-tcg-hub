'use client';

import { type SyntheticEvent, useState } from 'react';
import { formatVodOffset, parseDurationToSeconds, parseVodOffset } from '@gth/core/vod';

interface CreatorPull {
  id: string;
  seq: number;
  label: string;
  offsetSeconds: number | null;
}

/**
 * Timestamp each pull against the VOD (FR-4.4).
 *
 * Done after the stream, when the VOD exists, so this is a separate panel rather than part
 * of the logger. The link lives on the break and each pull carries only an offset: pasting
 * the same URL forty times is forty chances to paste the wrong one.
 *
 * Nothing here can change the pull log. The timestamps are written to their own table —
 * `break_pulls` has UPDATE revoked at the database — and the public page says which parts a
 * viewer can verify and which they are taking on trust.
 */
export function VodPanel({
  breakId,
  initialVodUrl,
  initialPulls,
}: {
  breakId: string;
  initialVodUrl: string | null;
  initialPulls: CreatorPull[];
}): React.JSX.Element {
  const [vodUrl, setVodUrl] = useState(initialVodUrl ?? '');
  const [savedVodUrl, setSavedVodUrl] = useState(initialVodUrl);
  const [pulls, setPulls] = useState<CreatorPull[]>(initialPulls);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialPulls.map((p) => [
        p.id,
        p.offsetSeconds === null ? '' : formatVodOffset(p.offsetSeconds),
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveVod(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = vodUrl.trim();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/v1/breaks/${breakId}/vod`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vodUrl: trimmed === '' ? null : trimmed }),
      });
      if (!response.ok) {
        setError('That link was not accepted. It has to be an https URL.');
        return;
      }
      setSavedVodUrl(trimmed === '' ? null : trimmed);

      // A link copied from the platform's own "copy at current time" button carries a
      // timestamp. Offering it beats asking for it again — retyping is where wrong numbers
      // come from — but it is only a suggestion, and only for pulls with nothing set.
      const carried = parseVodOffset(trimmed);
      if (carried !== null) {
        setDrafts((current) => {
          const next = { ...current };
          for (const pull of pulls) {
            if (pull.offsetSeconds === null && (next[pull.id] ?? '') === '') {
              next[pull.id] = formatVodOffset(carried);
            }
          }
          return next;
        });
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function saveOffset(pull: CreatorPull): Promise<void> {
    const draft = (drafts[pull.id] ?? '').trim();
    setError(null);

    if (draft === '') {
      // An empty box means "I have no right timestamp for this one", which is better than a
      // link pointing at the wrong moment.
      const response = await fetch(`/v1/pulls/${pull.id}/evidence`, { method: 'DELETE' });
      if (response.ok || response.status === 404) {
        setPulls((current) =>
          current.map((p) => (p.id === pull.id ? { ...p, offsetSeconds: null } : p)),
        );
      }
      return;
    }

    const seconds = parseDurationToSeconds(draft);
    if (seconds === null) {
      setError(`"${draft}" is not a timestamp. Try 1:02:03, or 3723.`);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/v1/pulls/${pull.id}/evidence`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offsetSeconds: seconds }),
      });
      if (!response.ok) {
        setError('That timestamp was not saved.');
        return;
      }
      setPulls((current) =>
        current.map((p) => (p.id === pull.id ? { ...p, offsetSeconds: seconds } : p)),
      );
      setDrafts((current) => ({ ...current, [pull.id]: formatVodOffset(seconds) }));
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const timestamped = pulls.filter((p) => p.offsetSeconds !== null).length;

  return (
    <section
      className="space-y-4 rounded border p-4 bg-surface border-line"
      data-testid="vod-panel"
    >
      <div>
        <h2 className="font-medium">VOD timestamps</h2>
        <p className="mt-1 max-w-prose text-xs text-muted">
          Paste the VOD once, then mark where each pull happens. Viewers get a link straight to the
          moment. These are not covered by the pull log&rsquo;s hashes — the log is proven, a
          timestamp is you telling people where to look.
        </p>
      </div>

      <form onSubmit={(e) => void saveVod(e)} className="flex flex-wrap items-end gap-3">
        <label className="flex-1 text-sm min-w-64">
          <span className="text-muted">VOD link</span>
          <input
            type="url"
            value={vodUrl}
            maxLength={500}
            onChange={(e) => {
              setVodUrl(e.target.value);
            }}
            placeholder="https://..."
            data-testid="vod-url"
            className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          data-testid="save-vod"
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
        >
          Save link
        </button>
      </form>

      {savedVodUrl === null ? (
        <p className="text-xs text-muted">
          Add a link and the timestamps below become clickable for viewers.
        </p>
      ) : (
        <p className="text-xs text-muted" data-testid="vod-progress">
          {timestamped} of {pulls.length} pull{pulls.length === 1 ? '' : 's'} timestamped.
        </p>
      )}

      {pulls.length > 0 && (
        <ol className="space-y-2" data-testid="vod-pulls">
          {pulls.map((pull) => (
            <li
              key={pull.id}
              className="flex flex-wrap items-center gap-3 text-sm"
              data-testid="vod-pull-row"
            >
              <span className="text-muted w-10">#{pull.seq}</span>
              <span className="min-w-0 flex-1">{pull.label}</span>
              <input
                value={drafts[pull.id] ?? ''}
                maxLength={20}
                onChange={(e) => {
                  setDrafts((current) => ({ ...current, [pull.id]: e.target.value }));
                }}
                onBlur={() => void saveOffset(pull)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                placeholder="1:02:03"
                aria-label={`Timestamp for pull ${String(pull.seq)}`}
                data-testid={`vod-offset-${String(pull.seq)}`}
                className="w-24 rounded border px-2 py-1 text-right bg-page border-line"
              />
            </li>
          ))}
        </ol>
      )}

      {error && (
        <p role="alert" data-testid="vod-error" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
