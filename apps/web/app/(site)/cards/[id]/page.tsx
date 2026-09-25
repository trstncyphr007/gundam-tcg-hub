import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PriceChart } from '@/components/price-chart';
import { api } from '@/lib/api';
import { dollars } from '@/lib/money';
import { BuyButton } from './buy-button';

/**
 * Ranges the chart offers (FR-3.3).
 *
 * **A deliberate shortfall from the plan**, which asks for 7d / 30d / 90d / all-time. The
 * public API caps `days` at 365, so the longest option is a year and is labelled as one.
 * Today that *is* all-time — the index is months old — and calling it "all-time" would be a
 * label that quietly becomes a lie. Revisit when there is more than a year of history, at
 * which point the range wants a real date picker rather than another button.
 */
const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
] as const;

const CONDITIONS = [
  { value: 'nm', label: 'Near mint' },
  { value: 'lp', label: 'Lightly played' },
  { value: 'mp', label: 'Moderately played' },
  { value: 'hp', label: 'Heavily played' },
  { value: 'dmg', label: 'Damaged' },
] as const;

const SOURCE_LABEL = new Map([
  ['break_pull', 'break pulls'],
  ['live_sale', 'live sales'],
  ['ebay_api', 'eBay'],
  ['walmart_api', 'Walmart'],
  ['user_report', 'user reports'],
]);

function pickRange(value: string | undefined): number {
  const requested = Number(value);
  return RANGES.some((r) => r.days === requested) ? requested : 30;
}

function pickCondition(value: string | undefined): string {
  return CONDITIONS.some((c) => c.value === value) ? String(value) : 'nm';
}

export default async function CardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const card = await api.card(id);
  if (!card) notFound();

  // Range and condition live in the URL, so the chart needs no client JavaScript, the state
  // survives a reload, and a particular view is a link someone can send.
  const days = pickRange(typeof query['days'] === 'string' ? query['days'] : undefined);
  const condition = pickCondition(
    typeof query['condition'] === 'string' ? query['condition'] : undefined,
  );
  // Both public, both independent of each other, so one round trip's worth of latency.
  // `me` decides whether the buy button asks for a sign-in first, and nothing more.
  const [prices, forSale, me] = await Promise.all([
    api.cardPrices(id, { days, condition }),
    api.cardListings(id),
    api.me(),
  ]);
  const signedIn = me !== null;

  const points = prices?.points ?? [];
  const latest = points.at(-1);
  const totalObservations = (prices?.sources ?? []).reduce((sum, s) => sum + s.observations, 0);
  const href = (next: { days?: number; condition?: string }): string =>
    `/cards/${id}?days=${String(next.days ?? days)}&condition=${next.condition ?? condition}`;

  return (
    <article className="space-y-6">
      <Link href="/" className="text-sm hover:underline text-muted">
        ← Back to search
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{card.name}</h1>
        <p className="mt-1 text-sm text-muted">
          #{card.number}
          {card.rarity ? ` · ${card.rarity}` : ''}
          {card.cardType ? ` · ${card.cardType}` : ''}
        </p>
      </header>

      <section className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Price history</h2>

          <nav className="flex gap-1" aria-label="Range">
            {RANGES.map((range) => (
              <Link
                key={range.days}
                href={href({ days: range.days })}
                data-testid={`range-${range.label}`}
                aria-current={range.days === days ? 'page' : undefined}
                className={`rounded border border-line px-2 py-1 text-xs ${
                  range.days === days ? 'bg-accent text-[#0b0d10]' : 'bg-transparent text-muted'
                }`}
              >
                {range.label}
              </Link>
            ))}
          </nav>

          <nav className="flex gap-1" aria-label="Condition">
            {CONDITIONS.map((entry) => (
              <Link
                key={entry.value}
                href={href({ condition: entry.value })}
                data-testid={`condition-${entry.value}`}
                aria-current={entry.value === condition ? 'page' : undefined}
                title={entry.label}
                className={`rounded border border-line px-2 py-1 text-xs uppercase ${
                  entry.value === condition
                    ? 'bg-accent text-[#0b0d10]'
                    : 'bg-transparent text-muted'
                }`}
              >
                {entry.value}
              </Link>
            ))}
          </nav>
        </div>

        {latest && (
          <div className="flex flex-wrap gap-x-10 gap-y-3" data-testid="price-summary">
            <div>
              <p className="text-xs text-muted">Latest ({latest.day})</p>
              <p className="text-2xl font-semibold tracking-tight" data-testid="latest-median">
                {dollars(latest.medianCents, latest.currency)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">Typical range</p>
              <p className="text-2xl font-semibold tracking-tight">
                {dollars(latest.p25Cents, latest.currency)} –{' '}
                {dollars(latest.p75Cents, latest.currency)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted">Backed by</p>
              <p className="text-2xl font-semibold tracking-tight">
                {latest.observationCount} sale{latest.observationCount === 1 ? '' : 's'}
              </p>
            </div>
          </div>
        )}

        <PriceChart points={points} currency={latest?.currency ?? 'USD'} />

        {totalObservations > 0 && (
          <p className="text-xs text-muted" data-testid="source-mix">
            Computed from {totalObservations} observation
            {totalObservations === 1 ? '' : 's'} over this window:{' '}
            {(prices?.sources ?? [])
              .map(
                (entry) =>
                  `${String(entry.observations)} ${SOURCE_LABEL.get(entry.source) ?? entry.source}`,
              )
              .join(', ')}
            .{' '}
            <Link href="/methodology" className="underline">
              How this is computed
            </Link>
            .
          </p>
        )}
      </section>

      {/*
        What is actually for sale (FR-5.2). Above the printings, because somebody who came here
        to buy a card should not have to scroll past a taxonomy to find out they can.

        `forSale` is null when the marketplace is not configured, which is a different thing
        from an empty list and is not said at all — a site without a marketplace should look
        like a site without a marketplace, not like one where nothing is for sale.
      */}
      {forSale !== null && (
        <section data-testid="for-sale">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">For sale</h2>
          {forSale.items.length === 0 ? (
            <p className="text-sm text-muted">Nobody is selling this one at the moment.</p>
          ) : (
            <ul className="space-y-2">
              {forSale.items.map((listing) => (
                <li
                  key={listing.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded border px-3 py-2 bg-surface border-line"
                  data-testid={`listing-${listing.id}`}
                >
                  <span className="text-sm">
                    <span className="font-medium">
                      {dollars(listing.priceCents, listing.currency)}
                    </span>{' '}
                    <span className="text-muted">
                      · {listing.condition.toUpperCase()} · {listing.finish.replace('_', ' ')} ·{' '}
                      {listing.language.toUpperCase()}
                      {listing.quantity > 1 ? ` · ${String(listing.quantity)} available` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-muted" data-testid={`seller-${listing.id}`}>
                      {/*
                        "No ratings yet" rather than a zero. Zero is a score, and it is the
                        worst one — printing it under a new seller's first listing would be a
                        lie that costs them the sale.
                      */}
                      {listing.seller.average === null
                        ? 'No ratings yet'
                        : `${listing.seller.average.toFixed(1)} from ${String(listing.seller.count)}`}
                    </span>
                    <BuyButton listingId={listing.id} signedIn={signedIn} next={`/cards/${id}`} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">Printings</h2>
        <ul className="flex flex-wrap gap-2">
          {card.variants.map((variant) => (
            <li
              key={`${variant.finish}-${variant.language}`}
              className="rounded border px-3 py-1 text-xs bg-surface border-line"
            >
              {variant.finish.replace('_', ' ')} · {variant.language.toUpperCase()}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
