'use client';

import { useCallback, useState } from 'react';
import { ValuationSummary } from '@/components/valuation-summary';
import type {
  CollectionDetail,
  CollectionItem,
  CollectionValuation,
  CollectionVisibility,
} from '@/lib/api';
import { dollars } from '@/lib/money';
import { AddCardForm } from './add-card-form';
import { CsvPanel } from './csv-panel';

const VISIBILITY = [
  ['private', 'Private — only you'],
  ['unlisted', 'Unlisted — anyone with the link'],
  ['public', 'Public — listed for everyone'],
] as const;

const CONDITION_LABEL: Record<string, string> = {
  nm: 'NM',
  lp: 'LP',
  mp: 'MP',
  hp: 'HP',
  dmg: 'DMG',
};

export function CollectionManager({
  collectionId,
  initialVisibility,
  initialItems,
  initialValuation,
}: {
  collectionId: string;
  initialVisibility: CollectionVisibility;
  initialItems: CollectionItem[];
  initialValuation: CollectionValuation | null;
}): React.JSX.Element {
  const [visibility, setVisibility] = useState<CollectionVisibility>(initialVisibility);
  const [items, setItems] = useState<CollectionItem[]>(initialItems);
  const [valuation, setValuation] = useState<CollectionValuation | null>(initialValuation);
  const [error, setError] = useState<string | null>(null);

  /**
   * Re-read both after any change.
   *
   * The valuation is not recomputed in the browser from the rows on screen: it is the
   * server's answer, with its own rules about what counts (ADR-019). A client-side sum would
   * drift from it the first time a price fell outside the freshness window, and then the
   * page would be confidently wrong.
   */
  const refresh = useCallback(async () => {
    try {
      const [detail, value] = await Promise.all([
        fetch(`/v1/collections/${collectionId}`, { cache: 'no-store' }),
        fetch(`/v1/collections/${collectionId}/value`, { cache: 'no-store' }),
      ]);
      if (detail.ok) setItems(((await detail.json()) as CollectionDetail).items);
      if (value.ok) setValuation((await value.json()) as CollectionValuation);
    } catch {
      setError('Could not refresh the collection.');
    }
  }, [collectionId]);

  async function changeVisibility(next: CollectionVisibility): Promise<void> {
    setError(null);
    const previous = visibility;
    setVisibility(next);
    const response = await fetch(`/v1/collections/${collectionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: next }),
    });
    if (!response.ok) {
      // Put the control back where it was. A sharing setting that looks changed but is not
      // is the worst possible failure mode for this particular control.
      setVisibility(previous);
      setError('Could not change who can see this.');
    }
  }

  async function setQuantity(item: CollectionItem, next: number): Promise<void> {
    setError(null);
    if (next < 1) return;
    const response = await fetch(`/v1/collections/${collectionId}/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: next }),
    });
    if (!response.ok) {
      setError('Could not update that line.');
      return;
    }
    await refresh();
  }

  async function remove(item: CollectionItem): Promise<void> {
    setError(null);
    const response = await fetch(`/v1/collections/${collectionId}/items/${item.id}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      setError('Could not remove that line.');
      return;
    }
    await refresh();
  }

  return (
    <div className="space-y-6">
      <ValuationSummary valuation={valuation} />

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          <span className="text-muted">Who can see this</span>
          <select
            value={visibility}
            onChange={(e) => void changeVisibility(e.target.value as CollectionVisibility)}
            data-testid="visibility"
            className="ml-2 rounded border px-3 py-2 text-sm bg-page border-line"
          >
            {VISIBILITY.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {visibility !== 'private' && (
          <span className="text-xs text-muted">
            A shared page shows the cards and the name. It never shows who owns it.
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <AddCardForm collectionId={collectionId} onAdded={() => void refresh()} />

      {items.length === 0 ? (
        <p className="text-sm text-muted">Nothing in here yet.</p>
      ) : (
        <table className="w-full text-sm" data-testid="item-table">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-2">Card</th>
              <th className="py-2">Printing</th>
              <th className="py-2">Cond.</th>
              <th className="py-2 text-right">Qty</th>
              <th className="py-2 text-right">Paid each</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t border-line">
                <td className="py-2">
                  <span className="font-medium">{item.cardName}</span>
                  <span className="ml-2 text-xs text-muted">
                    {item.setCode} #{item.cardNumber}
                  </span>
                </td>
                <td className="py-2 text-xs text-muted">
                  {item.finish} · {item.language}
                </td>
                <td className="py-2">{CONDITION_LABEL[item.condition] ?? item.condition}</td>
                <td className="py-2 text-right">
                  <div className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      aria-label={`Remove one ${item.cardName}`}
                      onClick={() => void setQuantity(item, item.quantity - 1)}
                      disabled={item.quantity <= 1}
                      className="rounded border px-2 disabled:opacity-40 border-line"
                    >
                      −
                    </button>
                    <span data-testid="item-quantity">{item.quantity}</span>
                    <button
                      type="button"
                      aria-label={`Add one ${item.cardName}`}
                      onClick={() => void setQuantity(item, item.quantity + 1)}
                      className="rounded border px-2 border-line"
                    >
                      +
                    </button>
                  </div>
                </td>
                <td className="py-2 text-right">
                  {item.acquiredPriceCents === null ? (
                    // Not "$0.00": we do not know, and saying zero would report the card as
                    // pure profit.
                    <span className="text-muted">not recorded</span>
                  ) : (
                    dollars(item.acquiredPriceCents, item.currency)
                  )}
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    onClick={() => void remove(item)}
                    className="text-xs underline text-muted"
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CsvPanel collectionId={collectionId} onImported={() => void refresh()} />
    </div>
  );
}
