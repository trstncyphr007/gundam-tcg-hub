'use client';

import type { CollectionValuation } from '@/lib/api';
import { dollars, signedDollars } from '@/lib/money';

/**
 * The valuation, shown the way ADR-019 requires it to be shown.
 *
 * The headline number is deliberately not alone. A card the index cannot price is not worth
 * zero, so the count of unvalued cards sits next to the total rather than in a tooltip; and
 * gain/loss states what it was computed over, because it covers a smaller set of cards than
 * the total does. If this component ever shows one big number by itself, the honesty work in
 * the layer underneath has been wasted.
 */
export function ValuationSummary({
  valuation,
}: {
  valuation: CollectionValuation | null;
}): React.JSX.Element {
  if (!valuation) {
    return (
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        Could not work out a value right now.
      </p>
    );
  }

  const { currency } = valuation;
  const hasGain = valuation.costBasisCents > 0;

  return (
    <div
      className="space-y-4 rounded border p-4"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="flex flex-wrap gap-x-10 gap-y-4">
        <div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Index value
          </p>
          <p className="text-2xl font-semibold tracking-tight" data-testid="collection-value">
            {dollars(valuation.currentValueCents, currency)}
          </p>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            {valuation.valuedCards} of {valuation.cards} card
            {valuation.cards === 1 ? '' : 's'} priced
          </p>
        </div>

        <div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Gain / loss
          </p>
          {hasGain ? (
            <>
              <p
                className="text-2xl font-semibold tracking-tight"
                data-testid="collection-gain"
                style={{ color: valuation.gainLossCents >= 0 ? 'var(--accent)' : undefined }}
              >
                {signedDollars(valuation.gainLossCents, currency)}
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                {dollars(valuation.comparableValueCents, currency)} against{' '}
                {dollars(valuation.costBasisCents, currency)} paid
              </p>
            </>
          ) : (
            <>
              <p className="text-2xl font-semibold tracking-tight" data-testid="collection-gain">
                —
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                Record what you paid to see this
              </p>
            </>
          )}
        </div>

        <div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Lines
          </p>
          <p className="text-2xl font-semibold tracking-tight">{valuation.lines}</p>
        </div>
      </div>

      {(valuation.unpricedCards > 0 || valuation.otherCurrencyLines > 0) && (
        <ul
          className="space-y-1 text-xs"
          style={{ color: 'var(--muted)' }}
          data-testid="not-valued"
        >
          {valuation.unpricedCards > 0 && (
            <li>
              <strong>{valuation.unpricedCards}</strong> card
              {valuation.unpricedCards === 1 ? '' : 's'} across {valuation.unpricedLines} line
              {valuation.unpricedLines === 1 ? '' : 's'} have no recent index price, so they are not
              in the total. They are not worth nothing — we just have nothing to cite.
            </li>
          )}
          {valuation.otherCurrencyLines > 0 && (
            <li>
              <strong>{valuation.otherCurrencyLines}</strong> line
              {valuation.otherCurrencyLines === 1 ? '' : 's'} are recorded in another currency. We
              hold no exchange rates, so they are listed rather than converted.
            </li>
          )}
        </ul>
      )}

      {valuation.oldestPriceDay !== null && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Oldest price used: {valuation.oldestPriceDay}. Prices over 30 days old are ignored.
        </p>
      )}
    </div>
  );
}
