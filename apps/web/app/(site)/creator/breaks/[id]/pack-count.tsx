'use client';

import { type SyntheticEvent, useState } from 'react';

/**
 * How many packs were opened (FR-4.3).
 *
 * The denominator for every hit-rate comparison on the creator's public page, which is why
 * this sits on its own with an explanation rather than being one more box on the break form.
 * Leaving it blank is a supported answer: it takes the break out of the comparison entirely,
 * which is the honest outcome when nobody counted.
 */
export function PackCount({
  breakId,
  initial,
}: {
  breakId: string;
  initial: number | null;
}): React.JSX.Element {
  const [packs, setPacks] = useState(initial === null ? '' : String(initial));
  const [saved, setSaved] = useState<number | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = packs.trim();
    const value = trimmed.length === 0 ? null : Number.parseInt(trimmed, 10);
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      setError('Enter a whole number of packs, or clear the box.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/v1/breaks/${breakId}/packs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packsOpened: value }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { reason?: string } | null;
        setError(detail?.reason ?? 'That did not save.');
        return;
      }
      const body = (await response.json()) as { packsOpened: number | null };
      setSaved(body.packsOpened);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="space-y-3 rounded border p-4 bg-surface border-line"
      data-testid="pack-count"
    >
      <div>
        <h2 className="font-medium">Packs opened</h2>
        <p className="mt-1 max-w-prose text-xs text-muted">
          Published odds are stated per pack, so this is what your hit rates are measured against.
          Leave it blank if nobody counted — the break is then left out of the comparison rather
          than counted wrongly.
        </p>
      </div>

      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3">
        <label className="text-sm w-36">
          <span className="text-muted">Packs</span>
          <input
            type="number"
            min="1"
            max="5000"
            value={packs}
            onChange={(e) => {
              setPacks(e.target.value);
            }}
            data-testid="packs-opened"
            className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          data-testid="save-packs"
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
        >
          Save
        </button>
        <span className="text-xs text-muted" data-testid="packs-saved">
          {saved === null ? 'Not recorded' : `Recorded: ${String(saved)}`}
        </span>
      </form>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
