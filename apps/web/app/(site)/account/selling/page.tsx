import { SignInRequired } from '@/components/sign-in-required';
import { api } from '@/lib/api';
import { SellingManager } from './selling-manager';

export const metadata = {
  title: 'Selling · Gundam TCG Hub',
  robots: { index: false, follow: false },
};

/**
 * A seller's own page (FR-5.1, FR-5.2).
 *
 * Two things live here and they are deliberately separate: whether Stripe will let this person
 * take money, and what they have listed. The first is asked of Stripe rather than read from our
 * own row — they are the ones who know, and a cached "yes" that has since become "no" is how
 * somebody takes a payment they cannot be paid for.
 *
 * `sellerStatus` returns null when the marketplace is not configured at all, which is a
 * different thing from "not onboarded" and is said differently below.
 */
export default async function SellingPage(): Promise<React.JSX.Element> {
  const me = await api.me();
  if (!me) {
    return <SignInRequired title="Selling" reason="list cards for sale" next="/account/selling" />;
  }

  const [status, listings] = await Promise.all([api.sellerStatus(), api.myListings()]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Selling</h1>
        <p className="mt-1 text-sm text-muted">
          List cards, add photos, and see what has sold. Payments and payouts are handled by Stripe
          — we never see a card number.
        </p>
      </header>

      {status === null ? (
        <p className="rounded border p-4 text-sm text-muted border-line" data-testid="market-off">
          The marketplace is not switched on for this site yet.
        </p>
      ) : (
        <SellingManager status={status} initialListings={listings?.items ?? []} />
      )}
    </div>
  );
}
