import { api } from '@/lib/api';
import { WatchButton } from './watch-button';

export const metadata = { title: 'Products · Gundam TCG Hub' };

function formatPrice(cents: number | null): string {
  return cents === null ? '—' : `$${(cents / 100).toFixed(2)}`;
}

export default async function ProductsPage() {
  const [products, me, watches] = await Promise.all([api.products(), api.me(), api.watches()]);
  const watched = new Map(
    (watches?.items ?? [])
      .filter((w) => w.sealedProductId !== null)
      .map((w) => [w.sealedProductId as string, w.id]),
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sealed products</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {me
            ? 'Watch a product to get an alert the moment it is back in stock.'
            : 'Sign in to watch a product for restock alerts.'}
        </p>
      </header>

      {products === null ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          The catalog is unavailable right now.
        </p>
      ) : (
        <ul className="space-y-3">
          {products.items.map((product) => (
            <li
              key={product.id}
              className="flex items-center gap-4 rounded border p-4"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{product.name}</p>
                <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {product.kind.replace('_', ' ')} · MSRP {formatPrice(product.msrpCents)}
                </p>
              </div>
              <div className="ml-auto shrink-0">
                <WatchButton
                  productId={product.id}
                  signedIn={me !== null}
                  existingWatchId={watched.get(product.id) ?? null}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
