import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';

export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await api.card(id);
  if (!card) notFound();

  return (
    <article className="space-y-6">
      <Link href="/" className="text-sm hover:underline" style={{ color: 'var(--muted)' }}>
        ← Back to search
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{card.name}</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          #{card.number}
          {card.rarity ? ` · ${card.rarity}` : ''}
          {card.cardType ? ` · ${card.cardType}` : ''}
        </p>
      </header>

      <section>
        <h2
          className="mb-2 text-sm font-medium uppercase tracking-wide"
          style={{ color: 'var(--muted)' }}
        >
          Printings
        </h2>
        <ul className="flex flex-wrap gap-2">
          {card.variants.map((variant) => (
            <li
              key={`${variant.finish}-${variant.language}`}
              className="rounded border px-3 py-1 text-xs"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              {variant.finish.replace('_', ' ')} · {variant.language.toUpperCase()}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
