'use client';

import { useRouter } from 'next/navigation';
import {
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { centsFromInput } from '@/lib/money';

interface Pull {
  seq: number;
  label: string;
  valueCentsAtPull: number;
  valueSource?: 'manual' | 'index';
}

interface CardHit {
  id: string;
  name: string;
  number: string;
}

interface Candidate {
  cardName: string;
  variantId: string;
  finish: string;
  /** Null when the index has nothing recent to say — which is not a price of zero. */
  indexCents: number | null;
}

type Status = 'draft' | 'live' | 'ended';

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Keyboard-first pull logging with index-filled values (FR-2.1, FR-2.2).
 *
 * A break moves fast, so the fastest path has to stay fast: type a few letters, press Enter,
 * and the top match is logged at the price the index currently publishes. Arrow keys move
 * through the matches; the value field is an override, not a requirement; and typing a card
 * the catalog has never heard of still works, as free text, because a creator must never be
 * blocked mid-break by a gap in our data.
 *
 * A typed value is recorded as `manual` and an index-filled one as `index`. That difference
 * is not cosmetic — pulls feed the price index, and ingesting a value the index itself
 * produced would make it quote itself (see `pullValueSource` in the schema).
 */
export function PullLogger({
  breakId,
  initialStatus,
  costCents,
  tokenVersion,
}: {
  breakId: string;
  initialStatus: Status;
  costCents: number | null;
  tokenVersion: number;
}): React.JSX.Element {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [pulls, setPulls] = useState<Pull[]>([]);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [version, setVersion] = useState(tokenVersion);
  const [hits, setHits] = useState<CardHit[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const total = pulls.reduce((sum, p) => sum + p.valueCentsAtPull, 0);

  /**
   * Search as the creator types, but not on every keystroke.
   *
   * Skipped once a card is chosen: the list would otherwise reopen over the confirmed
   * selection and the next Enter would pick something else.
   */
  useEffect(() => {
    const term = label.trim();
    if (term.length < 2 || candidate) {
      setHits([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/v1/cards?limit=5&q=${encodeURIComponent(term)}`);
          if (!response.ok) return;
          setHits(((await response.json()) as { items: CardHit[] }).items);
          setHighlighted(0);
        } catch {
          // A failed search just means no suggestions; free text still works.
        }
      })();
    }, 200);
    return () => {
      clearTimeout(timer);
    };
  }, [label, candidate]);

  /** Resolve a card to a printing and the price the index currently publishes for it. */
  const choose = useCallback(async (hit: CardHit) => {
    setHits([]);
    try {
      const [detail, prices] = await Promise.all([
        fetch(`/v1/cards/${hit.id}`),
        fetch(`/v1/cards/${hit.id}/prices?condition=nm&days=30`),
      ]);
      if (!detail.ok) return;
      const variants = ((await detail.json()) as { variants: { id: string; finish: string }[] })
        .variants;
      const first = variants.at(0);
      if (!first) return;

      // Latest published point for this printing, if there is one inside the window.
      let indexCents: number | null = null;
      if (prices.ok) {
        const points = (
          (await prices.json()) as {
            points: { cardVariantId: string; medianCents: number }[];
          }
        ).points.filter((p) => p.cardVariantId === first.id);
        indexCents = points.at(-1)?.medianCents ?? null;
      }
      setCandidate({
        cardName: hit.name,
        variantId: first.id,
        finish: first.finish,
        indexCents,
      });
      setLabel(hit.name);
    } catch {
      // Leave it as free text rather than blocking the break on a failed lookup.
    }
  }, []);

  function clearCandidate(): void {
    setCandidate(null);
    setLabel('');
    setValue('');
    labelRef.current?.focus();
  }

  const load = useCallback(async () => {
    const response = await fetch(`/v1/breaks/${breakId}/public`, { cache: 'no-store' });
    if (!response.ok) return;
    const view = (await response.json()) as { pulls: Pull[] };
    setPulls(view.pulls);
  }, [breakId]);

  useEffect(() => {
    if (status !== 'draft') void load();
  }, [status, load]);

  async function changeStatus(next: 'live' | 'ended'): Promise<void> {
    setError(null);
    const response = await fetch(`/v1/breaks/${breakId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    if (!response.ok) {
      setError('Could not change the break status.');
      return;
    }
    setStatus(next);
    if (next === 'live') labelRef.current?.focus();
    // The heading and the "Public page" link live in the server component, which does not
    // know the status just changed. Without this the break is live but the page still
    // says draft, and the public link never appears until a manual reload.
    router.refresh();
  }

  async function submitPull(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed.length === 0) return;
    setError(null);

    // A typed value always wins over the index. Blank is not zero: it is "you tell me",
    // which the server answers from the index when the pull names a card.
    let override: number | undefined;
    if (value.trim() !== '') {
      const cents = centsFromInput(value);
      if (cents === null) {
        setError('That value is not an amount.');
        return;
      }
      override = cents;
    }

    const chosen = candidate;
    // Clear first so the next pull can be typed while this one is in flight; a break does
    // not pause for the network.
    setLabel('');
    setValue('');
    setCandidate(null);
    setHits([]);
    labelRef.current?.focus();

    const body = chosen
      ? {
          cardVariantId: chosen.variantId,
          ...(override === undefined ? {} : { valueCentsAtPull: override }),
        }
      : { label: trimmed, valueCentsAtPull: override ?? 0 };

    const response = await fetch(`/v1/breaks/${breakId}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      setError(`Could not log "${trimmed}". It was not saved.`);
      return;
    }
    const pull = (await response.json()) as Pull;
    setPulls((current) => [...current, { ...pull, label: trimmed }]);
  }

  /**
   * Enter picks the highlighted suggestion instead of submitting, when the list is open.
   *
   * That is what makes the fast path fast: three letters, Enter to pick, Enter to log — and
   * the value comes from the index without anyone typing a number.
   */
  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (hits.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((i) => (i + 1) % hits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((i) => (i - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      const hit = hits.at(highlighted);
      if (hit) {
        event.preventDefault();
        void choose(hit);
      }
    } else if (event.key === 'Escape') {
      setHits([]);
    }
  }

  async function rotateToken(): Promise<void> {
    setError(null);
    const response = await fetch(`/v1/breaks/${breakId}/overlay-token`, { method: 'POST' });
    if (!response.ok) {
      setError('Could not regenerate the overlay URL.');
      return;
    }
    const next = (await response.json()) as { overlayToken: string; overlayTokenVersion: number };
    setRotated(`${window.location.origin}/overlay/${next.overlayToken}`);
    setVersion(next.overlayTokenVersion);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        {status === 'draft' && (
          <button
            type="button"
            onClick={() => void changeStatus('live')}
            className="rounded px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--accent)' }}
          >
            Start break
          </button>
        )}
        {status === 'live' && (
          <button
            type="button"
            onClick={() => void changeStatus('ended')}
            className="rounded border px-4 py-2 text-sm font-medium"
            style={{ borderColor: 'var(--border)' }}
          >
            End break
          </button>
        )}
        <button
          type="button"
          onClick={() => void rotateToken()}
          className="rounded border px-4 py-2 text-sm"
          style={{ borderColor: 'var(--border)' }}
        >
          Regenerate overlay URL
        </button>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          overlay v{version}
        </span>
      </div>

      {rotated && (
        <div
          className="space-y-2 rounded border p-4"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <p className="text-sm font-medium">New overlay URL — the previous one is now dead</p>
          <input
            readOnly
            value={rotated}
            aria-label="Overlay URL"
            data-testid="overlay-url"
            onFocus={(e) => {
              e.currentTarget.select();
            }}
            className="w-full rounded border px-3 py-2 font-mono text-xs"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
          />
        </div>
      )}

      {status === 'live' && (
        <form
          onSubmit={(e) => void submitPull(e)}
          className="space-y-3 rounded border p-4"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1" style={{ minWidth: '16rem' }}>
              <label className="block text-sm">
                <span style={{ color: 'var(--muted)' }}>Card</span>
                <input
                  ref={labelRef}
                  autoFocus
                  value={label}
                  maxLength={120}
                  autoComplete="off"
                  role="combobox"
                  aria-expanded={hits.length > 0}
                  aria-controls="pull-suggestions"
                  onKeyDown={onSearchKeyDown}
                  onChange={(e) => {
                    setLabel(e.target.value);
                    // Typing again abandons the chosen card: the text no longer describes it.
                    if (candidate) setCandidate(null);
                  }}
                  placeholder="Start typing — Enter picks the top match"
                  data-testid="pull-label"
                  className="mt-1 w-full rounded border px-3 py-2"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                />
              </label>

              {hits.length > 0 && (
                <ul
                  id="pull-suggestions"
                  data-testid="pull-suggestions"
                  className="absolute z-10 mt-1 w-full divide-y rounded border"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                >
                  {hits.map((hit, index) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => void choose(hit)}
                        className="flex w-full gap-3 px-3 py-2 text-left text-sm"
                        style={{
                          background: index === highlighted ? 'var(--surface)' : 'transparent',
                        }}
                      >
                        <span className="min-w-0 flex-1">{hit.name}</span>
                        <span style={{ color: 'var(--muted)' }}>#{hit.number}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <label className="text-sm" style={{ width: '10rem' }}>
              <span style={{ color: 'var(--muted)' }}>Value (USD)</span>
              <input
                inputMode="decimal"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                }}
                placeholder={candidate?.indexCents != null ? dollars(candidate.indexCents) : '0.00'}
                data-testid="pull-value"
                className="mt-1 w-full rounded border px-3 py-2"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
              />
            </label>

            <button
              type="submit"
              data-testid="log-pull"
              className="self-end rounded px-4 py-2 text-sm font-medium"
              style={{ background: 'var(--accent)' }}
            >
              Log pull
            </button>
          </div>

          {candidate && (
            <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="pull-candidate">
              <span
                className="rounded px-2 py-0.5"
                style={{ background: 'var(--bg)', color: 'var(--accent)' }}
              >
                {candidate.cardName}
                {candidate.finish === 'normal' ? '' : ` (${candidate.finish.replace('_', ' ')})`}
              </span>
              {candidate.indexCents === null ? (
                <span style={{ color: 'var(--muted)' }}>
                  No recent index price — type a value or it logs at $0.00.
                </span>
              ) : (
                <span style={{ color: 'var(--muted)' }} data-testid="index-value">
                  Index says {dollars(candidate.indexCents)}. Leave the value blank to use it.
                </span>
              )}
              <button
                type="button"
                onClick={clearCandidate}
                className="underline"
                style={{ color: 'var(--muted)' }}
              >
                clear
              </button>
            </p>
          )}
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--danger, #f87171)' }}>
          {error}
        </p>
      )}

      <div className="flex gap-6 text-sm">
        <p>
          <span style={{ color: 'var(--muted)' }}>Pulled</span>{' '}
          <strong data-testid="pull-count">{pulls.length}</strong>
        </p>
        <p>
          <span style={{ color: 'var(--muted)' }}>Value</span>{' '}
          <strong data-testid="running-total">{dollars(total)}</strong>
        </p>
        {costCents !== null && (
          <p>
            <span style={{ color: 'var(--muted)' }}>vs cost</span>{' '}
            <strong style={{ color: total >= costCents ? 'var(--accent)' : undefined }}>
              {total >= costCents ? '+' : ''}
              {dollars(total - costCents)}
            </strong>
          </p>
        )}
      </div>

      {pulls.length > 0 && (
        <ol className="space-y-2" data-testid="pull-list">
          {[...pulls].reverse().map((pull) => (
            <li
              key={pull.seq}
              className="flex gap-3 rounded border px-3 py-2 text-sm"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <span style={{ color: 'var(--muted)' }}>#{pull.seq}</span>
              <span className="min-w-0 flex-1">{pull.label}</span>
              {/* Marked, because a figure from the index is a different claim from one the
                  creator typed — and only the typed ones feed the index back. */}
              {pull.valueSource === 'index' && (
                <span
                  className="text-xs"
                  style={{ color: 'var(--muted)' }}
                  title="From the price index"
                >
                  index
                </span>
              )}
              <span>{dollars(pull.valueCentsAtPull)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
