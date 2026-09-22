import Link from 'next/link';
import { api } from '@/lib/api';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').slice(0, 100);
  const results = await api.cards(query);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Gundam Card Game</h1>
        <p className="text-sm text-muted">
          Search the catalog, then watch a sealed product to get an alert when it is back in stock.
        </p>
      </section>

      <form action="/" method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          maxLength={100}
          placeholder="Search cards by name or number"
          aria-label="Search cards"
          className="w-full rounded border px-3 py-2 text-sm outline-none bg-surface border-line"
        />
        <button type="submit" className="rounded px-4 py-2 text-sm font-medium bg-accent">
          Search
        </button>
      </form>

      <section aria-live="polite">
        {results === null ? (
          <p className="text-sm text-muted">The catalog is unavailable right now.</p>
        ) : results.items.length === 0 ? (
          <p className="text-sm text-muted">
            No cards matched {query ? `“${query}”` : 'your search'}.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {results.items.map((card) => (
              <li key={card.id} className="rounded border p-4 bg-surface border-line">
                <Link href={`/cards/${card.id}`} className="font-medium hover:underline">
                  {card.name}
                </Link>
                <p className="mt-1 text-xs text-muted">
                  #{card.number}
                  {card.rarity ? ` · ${card.rarity}` : ''}
                  {card.cardType ? ` · ${card.cardType}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
