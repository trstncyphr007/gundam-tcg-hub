'use client';

import {
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { centsFromInput } from '@/lib/money';

interface Sale {
  id: string;
  label: string;
  condition: string;
  priceCents: number;
  currency: string;
  soldAt: string;
  buyerHandle: string | null;
  published: boolean;
  flagged: boolean;
}

interface CardHit {
  id: string;
  name: string;
  number: string;
}

const CONDITIONS = ['nm', 'lp', 'mp', 'hp', 'dmg'] as const;

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Keyboard-first live-sale logging (FR-4.1, under three seconds an entry).
 *
 * A live stream does not pause. So the fast path is: type a few letters, Enter to pick the
 * card, type a price, Enter. Condition and buyer handle keep their last values between
 * entries, because in practice a seller runs a whole stream in near mint and only sometimes
 * needs the buyer's name — retyping both every time is where three seconds would go.
 *
 * Nothing here writes to the price index. The entry is recorded; a worker turns it into an
 * observation later, and an odd price is held for review before it counts. That is why the
 * list shows "in the index" and "held for review" as separate states rather than pretending
 * a logged sale is a published one.
 */
export function SaleLogger({ initial }: { initial: Sale[] }): React.JSX.Element {
  const [sales, setSales] = useState<Sale[]>(initial);
  const [label, setLabel] = useState('');
  const [price, setPrice] = useState('');
  const [condition, setCondition] = useState<string>('nm');
  const [buyer, setBuyer] = useState('');
  const [streamRef, setStreamRef] = useState('');
  const [hits, setHits] = useState<CardHit[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [candidate, setCandidate] = useState<{ name: string; variantId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);

  const total = sales.reduce((sum, s) => sum + s.priceCents, 0);

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
          // A failed search just means no suggestions; free text still logs.
        }
      })();
    }, 200);
    return () => {
      clearTimeout(timer);
    };
  }, [label, candidate]);

  const choose = useCallback(async (hit: CardHit) => {
    setHits([]);
    try {
      const detail = await fetch(`/v1/cards/${hit.id}`);
      if (!detail.ok) return;
      const { variants } = (await detail.json()) as { variants: { id: string }[] };
      const first = variants.at(0);
      if (!first) return;
      setCandidate({ name: hit.name, variantId: first.id });
      setLabel(hit.name);
    } catch {
      // Leave it as free text rather than blocking the stream on a failed lookup.
    }
  }, []);

  async function refresh(): Promise<void> {
    const response = await fetch('/v1/live-sales', { cache: 'no-store' });
    if (!response.ok) return;
    setSales(((await response.json()) as { items: Sale[] }).items);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed.length === 0) return;

    const cents = centsFromInput(price);
    if (cents === null) {
      setError('That price is not an amount.');
      return;
    }

    setError(null);
    setBusy(true);
    const chosen = candidate;
    // Clear the card and price first so the next sale can be typed while this one is in
    // flight. Condition, buyer and the VOD link stay: they usually do not change.
    setLabel('');
    setPrice('');
    setCandidate(null);
    setHits([]);
    labelRef.current?.focus();

    try {
      const response = await fetch('/v1/live-sales', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(chosen ? { cardVariantId: chosen.variantId } : { label: trimmed }),
          condition,
          priceCents: cents,
          ...(buyer.trim() === '' ? {} : { buyerHandle: buyer.trim() }),
          ...(streamRef.trim() === '' ? {} : { streamRef: streamRef.trim() }),
        }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { reason?: string } | null;
        setError(detail?.reason ?? `Could not log "${trimmed}". It was not saved.`);
        return;
      }
      await refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setError(null);
    const response = await fetch(`/v1/live-sales/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError('That entry is already in the index, so it cannot be removed.');
      return;
    }
    await refresh();
  }

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

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => void submit(e)}
        className="space-y-3 rounded border p-4 bg-surface border-line"
        data-testid="sale-logger"
      >
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-64">
            <label className="block text-sm">
              <span className="text-muted">Card</span>
              <input
                ref={labelRef}
                autoFocus
                value={label}
                maxLength={120}
                autoComplete="off"
                role="combobox"
                aria-expanded={hits.length > 0}
                aria-controls="sale-suggestions"
                onKeyDown={onSearchKeyDown}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (candidate) setCandidate(null);
                }}
                placeholder="Start typing — Enter picks the top match"
                data-testid="sale-label"
                className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
              />
            </label>

            {hits.length > 0 && (
              <ul
                id="sale-suggestions"
                data-testid="sale-suggestions"
                className="absolute z-10 mt-1 w-full divide-y rounded border bg-page border-line"
              >
                {hits.map((hit, index) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      onClick={() => void choose(hit)}
                      className={`flex w-full gap-3 px-3 py-2 text-left text-sm ${
                        index === highlighted ? 'bg-surface' : 'bg-transparent'
                      }`}
                    >
                      <span className="min-w-0 flex-1">{hit.name}</span>
                      <span className="text-muted">#{hit.number}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="text-sm w-28">
            <span className="text-muted">Condition</span>
            <select
              value={condition}
              onChange={(e) => {
                setCondition(e.target.value);
              }}
              data-testid="sale-condition"
              className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
            >
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c.toUpperCase()}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm w-36">
            <span className="text-muted">Price (USD)</span>
            <input
              required
              inputMode="decimal"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
              }}
              placeholder="0.00"
              data-testid="sale-price"
              className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            data-testid="log-sale"
            className="self-end rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
          >
            Log sale
          </button>
        </div>

        <div className="flex flex-wrap gap-3">
          <label className="text-sm w-56">
            <span className="text-muted">Buyer (optional)</span>
            <input
              value={buyer}
              maxLength={80}
              onChange={(e) => {
                setBuyer(e.target.value);
              }}
              placeholder="@handle"
              data-testid="sale-buyer"
              className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
            />
          </label>

          <label className="flex-1 text-sm min-w-56">
            <span className="text-muted">VOD link (optional)</span>
            <input
              value={streamRef}
              maxLength={500}
              onChange={(e) => {
                setStreamRef(e.target.value);
              }}
              placeholder="https://..."
              data-testid="sale-stream"
              className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
            />
          </label>
        </div>

        <p className="text-xs text-muted">
          The buyer&rsquo;s handle is encrypted, never shown publicly, and erased 90 days after the
          sale. Leave it blank if you do not need it.
        </p>
      </form>

      {error && (
        <p role="alert" data-testid="sale-error" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-6 text-sm">
        <p>
          <span className="text-muted">Logged</span>{' '}
          <strong data-testid="sale-count">{sales.length}</strong>
        </p>
        <p>
          <span className="text-muted">Total</span>{' '}
          <strong data-testid="sale-total">{dollars(total)}</strong>
        </p>
      </div>

      {sales.length > 0 && (
        <ul className="space-y-2" data-testid="sale-list">
          {sales.map((sale) => (
            <li
              key={sale.id}
              className="flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-sm bg-surface border-line"
              data-testid="sale-row"
            >
              <span className="min-w-0 flex-1">{sale.label}</span>
              <span className="text-muted">{sale.condition.toUpperCase()}</span>
              {sale.buyerHandle !== null && (
                <span className="text-muted" data-testid="sale-buyer-shown">
                  {sale.buyerHandle}
                </span>
              )}
              {/* Three states, not two. A logged sale is not a published one, and a held one
                  is not a rejected one. */}
              {sale.flagged ? (
                <span
                  data-testid="sale-flagged"
                  title="Far from the published price, so a person looks before it counts"
                  className="text-warning"
                >
                  held for review
                </span>
              ) : sale.published ? (
                <span className="text-accent" data-testid="sale-published">
                  in the index
                </span>
              ) : (
                <span className="text-muted">not yet counted</span>
              )}
              <span>{dollars(sale.priceCents)}</span>
              {!sale.published && !sale.flagged && (
                <button
                  type="button"
                  onClick={() => void remove(sale.id)}
                  data-testid="delete-sale"
                  className="underline text-muted"
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
