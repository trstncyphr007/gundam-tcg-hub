import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SignInRequired } from '@/components/sign-in-required';
import { api } from '@/lib/api';
import { CollectionManager } from './collection-manager';

export const metadata = { title: 'Collection · Gundam TCG Hub' };

export default async function ManageCollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const me = await api.me();
  if (!me) {
    return (
      <SignInRequired
        title="Collection"
        reason="see this collection"
        next={`/account/collections/${id}`}
      />
    );
  }

  const [collection, valuation] = await Promise.all([api.collection(id), api.collectionValue(id)]);
  // Someone else's collection is indistinguishable from one that does not exist. A shared
  // collection is readable, but it is not *yours* to manage, so this page refuses it too.
  if (!collection || collection.ownerId !== me.id) notFound();

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{collection.name}</h1>
          <p className="mt-1 text-sm text-muted">
            <Link href="/account/collections" className="underline">
              All collections
            </Link>
          </p>
        </div>
        {collection.visibility !== 'private' && (
          <Link href={`/collections/${collection.id}`} className="ml-auto text-sm underline">
            Shared page
          </Link>
        )}
      </header>

      <CollectionManager
        collectionId={collection.id}
        initialVisibility={collection.visibility}
        initialItems={collection.items}
        initialValuation={valuation}
      />
    </div>
  );
}
