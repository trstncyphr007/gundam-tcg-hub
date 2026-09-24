import Link from 'next/link';
import { SignInRequired } from '@/components/sign-in-required';
import { api } from '@/lib/api';
import { NewCollectionForm } from './new-collection-form';

export const metadata = { title: 'My collections · Gundam TCG Hub' };

const VISIBILITY_LABEL = {
  private: 'Private',
  unlisted: 'Unlisted — anyone with the link',
  public: 'Public',
} as const;

export default async function CollectionsPage() {
  const me = await api.me();

  if (!me) {
    return (
      <SignInRequired
        title="My collections"
        reason="keep a collection"
        next="/account/collections"
      />
    );
  }

  const collections = await api.collections();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">My collections</h1>
        <p className="mt-1 text-sm text-muted">
          What you own, what it cost, and what the index says it is worth.
          {collections
            ? ` ${String(collections.items.length)} of ${String(collections.limit)}.`
            : ''}
        </p>
      </header>

      <NewCollectionForm />

      {!collections || collections.items.length === 0 ? (
        <p className="text-sm text-muted">
          No collections yet. Make one above — it stays private unless you decide otherwise.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="collection-list">
          {collections.items.map((collection) => (
            <li
              key={collection.id}
              className="flex items-center gap-4 rounded border p-4 bg-surface border-line"
            >
              <div className="min-w-0">
                <Link
                  href={`/account/collections/${collection.id}`}
                  className="font-medium underline"
                >
                  {collection.name}
                </Link>
                <p className="mt-1 text-xs text-muted">{VISIBILITY_LABEL[collection.visibility]}</p>
              </div>
              {collection.visibility !== 'private' && (
                <Link href={`/collections/${collection.id}`} className="ml-auto text-sm underline">
                  Shared page
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
