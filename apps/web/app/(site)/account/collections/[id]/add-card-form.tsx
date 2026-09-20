'use client';

import { type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { centsFromInput } from '@/lib/money';

interface CardHit {
  id: string;
  name: string;
  number: string;
  rarity: string | null;
}

interface Variant {
  id: string;
  finish: string;
  language: string;
}

const CONDITIONS = [
  ['nm', 'Near mint'],
  ['lp', 'Lightly played'],
  ['mp', 'Moderately played'],
  ['hp', 'Heavily played'],
  ['dmg', 'Damaged'],
] as const;

/**
 * Add a card by searching for it (FR-3.4).
 *
 * A card is chosen in two steps — find the card, then say which printing — because a variant
 * id is not something anyone can type, and the finish genuinely changes what a card is worth.
 * The second request only happens once a card is picked, so browsing costs one query.
 */
export function AddCardForm({
  collectionId,
  onAdded,
}: {
  collectionId: string;
  onAdded: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CardHit[]>([]);
  const [card, setCard] = useState<CardHit | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [variantId, setVariantId] = useState('');
  const [condition, setCondition] = useState<string>('nm');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Debounced: a keystroke should not be a query, and the catalog endpoint is rate limited
  // like everything else.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2 || card) {
      setHits([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/v1/cards?limit=8&q=${encodeURIComponent(term)}`);
          if (!response.ok) return;
          const page = (await response.json()) as { items: CardHit[] };
          setHits(page.items);
        } catch {
          // A failed search is not worth an error banner; the list simply stays empty.
        }
      })();
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [query, card]);

  async function pick(hit: CardHit): Promise<void> {
    setCard(hit);
    setHits([]);
    setError(null);
    try {
      const response = await fetch(`/v1/cards/${hit.id}`);
      if (!response.ok) {
        setError('Could not load that card’s printings.');
        return;
      }
      const detail = (await response.json()) as { variants: Variant[] };
      setVariants(detail.variants);
      setVariantId(detail.variants.at(0)?.id ?? '');
    } catch {
      setError('Could not reach the server.');
    }
  }

  function reset(): void {
    setCard(null);
    setVariants([]);
    setVariantId('');
    setQuery('');
    setQuantity('1');
    setPrice('');
    searchRef.current?.focus();
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!variantId) return;
    setError(null);

    const qty = Number.parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      setError('Quantity must be a whole number, one or more.');
      return;
    }

    // An empty price means "I do not know what this cost", which is different from zero —
    // so it is left out of the request rather than sent as 0.
    let acquiredPriceCents: number | undefined;
    if (price.trim() !== '') {
      const cents = centsFromInput(price);
      if (cents === null) {
        setError('That price is not an amount.');
        return;
      }
      acquiredPriceCents = cents;
    }

    setBusy(true);
    try {
      const response = await fetch(`/v1/collections/${collectionId}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cardVariantId: variantId,
          condition,
          quantity: qty,
          ...(acquiredPriceCents === undefined ? {} : { acquiredPriceCents }),
        }),
      });
      if (!response.ok) {
        setError('Could not add that card.');
        return;
      }
      reset();
      onAdded();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded border p-4"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <h2 className="font-medium">Add a card</h2>

      {card ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium" data-testid="chosen-card">
            {card.name}
          </span>
          <span style={{ color: 'var(--muted)' }}>#{card.number}</span>
          <button
            type="button"
            onClick={reset}
            className="text-xs underline"
            style={{ color: 'var(--muted)' }}
          >
            change
          </button>
        </div>
      ) : (
        <div className="relative">
          <label className="block text-sm">
            <span style={{ color: 'var(--muted)' }}>Search cards</span>
            <input
              ref={searchRef}
              value={query}
              maxLength={100}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Name or number"
              data-testid="card-search"
              className="mt-1 w-full rounded border px-3 py-2"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            />
          </label>
          {hits.length > 0 && (
            <ul
              className="mt-2 divide-y rounded border"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
              data-testid="card-hits"
            >
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => void pick(hit)}
                    className="flex w-full gap-3 px-3 py-2 text-left text-sm"
                  >
                    <span className="min-w-0 flex-1">{hit.name}</span>
                    <span style={{ color: 'var(--muted)' }}>#{hit.number}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {card && (
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block text-sm">
            <span style={{ color: 'var(--muted)' }}>Printing</span>
            <select
              value={variantId}
              onChange={(e) => {
                setVariantId(e.target.value);
              }}
              data-testid="variant"
              className="mt-1 w-full rounded border px-3 py-2"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            >
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.finish} · {variant.language}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span style={{ color: 'var(--muted)' }}>Condition</span>
            <select
              value={condition}
              onChange={(e) => {
                setCondition(e.target.value);
              }}
              data-testid="condition"
              className="mt-1 w-full rounded border px-3 py-2"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            >
              {CONDITIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span style={{ color: 'var(--muted)' }}>Quantity</span>
            <input
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
              }}
              data-testid="quantity"
              className="mt-1 w-full rounded border px-3 py-2"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            />
          </label>
          <label className="block text-sm">
            <span style={{ color: 'var(--muted)' }}>Paid each (optional)</span>
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
              }}
              placeholder="12.50"
              data-testid="paid"
              className="mt-1 w-full rounded border px-3 py-2"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            />
          </label>
        </div>
      )}

      {card && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Leave the price blank if you don’t know it. A blank is honest; a zero would report the
          card as pure profit.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--danger, #f87171)' }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !variantId}
        data-testid="add-card"
        className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--accent)' }}
      >
        {busy ? 'Adding…' : 'Add to collection'}
      </button>
    </form>
  );
}
