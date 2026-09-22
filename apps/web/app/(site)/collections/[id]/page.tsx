import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ValuationSummary } from '@/components/valuation-summary';
import { api } from '@/lib/api';

export const metadata = { title: 'Collection · Gundam TCG Hub' };

const CONDITION_LABEL: Record<string, string> = {
  nm: 'NM',
  lp: 'LP',
  mp: 'MP',
  hp: 'HP',
  dmg: 'DMG',
};

/**
 * The shared view of a collection (FR-3.4, SR-3.8).
 *
 * Whether this renders at all is decided by row-level security: a private collection simply
 * is not returned, to anyone but its owner. What is deliberately absent is the owner — the
 * API only includes `ownerId` for the owner themselves, so there is nothing here to leak.
 */
export default async function SharedCollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const [collection, valuation] = await Promise.all([api.collection(id), api.collectionValue(id)]);
  if (!collection) notFound();

  const isOwner = collection.ownerId !== undefined;

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{collection.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {collection.items.length} line{collection.items.length === 1 ? '' : 's'}
            {collection.visibility === 'unlisted' ? ' · unlisted' : ''}
          </p>
        </div>
        {isOwner && (
          <Link
            href={`/account/collections/${collection.id}`}
            className="ml-auto text-sm underline"
          >
            Edit
          </Link>
        )}
      </header>

      <ValuationSummary valuation={valuation} />

      {collection.items.length === 0 ? (
        <p className="text-sm text-muted">Nothing in here yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-2">Card</th>
              <th className="py-2">Printing</th>
              <th className="py-2">Cond.</th>
              <th className="py-2 text-right">Qty</th>
            </tr>
          </thead>
          <tbody>
            {collection.items.map((item) => (
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
                <td className="py-2 text-right">{item.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isOwner && (
        <p className="text-xs text-muted">
          This is close to what a visitor sees — except that what you paid, when you bought it and
          your notes are stripped out for anyone but you, so no gain or loss is shown to them
          either.
        </p>
      )}
    </div>
  );
}
