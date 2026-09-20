import Link from 'next/link';
import { api } from '@/lib/api';

export const metadata = { title: 'Public collections · Gundam TCG Hub' };

/**
 * Only `public` collections appear here. An unlisted one is readable by anyone holding its
 * id and deliberately absent from this list — that difference is the whole point of having
 * two words for it, and it is enforced in the query rather than assumed.
 */
export default async function PublicCollectionsPage() {
  const collections = await api.publicCollections();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Public collections</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          Collections people have chosen to list. Names and cards only — never who owns them.
        </p>
      </header>

      {!collections || collections.items.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Nobody has made one public yet.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="public-collections">
          {collections.items.map((collection) => (
            <li
              key={collection.id}
              className="rounded border p-4"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <Link href={`/collections/${collection.id}`} className="font-medium underline">
                {collection.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
