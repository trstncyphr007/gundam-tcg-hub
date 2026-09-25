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
 * `sellerStatus` returns null when payments are not configured on this deployment at all — the
 * seller routes are registered only when there is a Stripe client to answer them with.
 *
 * **That is not the same as having no marketplace, and the first version of this page treated
 * it as though it were.** Listings do not go through Stripe: `registerMarketRoutes` is
 * unconditional, so creating drafts, adding photographs and arranging inventory all work with
 * no payment provider anywhere. Hiding the whole page behind a Stripe check meant that on a
 * stock local install — and in CI, which configures no Stripe — selling showed one sentence
 * saying it did not exist, and nothing else. Preparing to sell is most of selling, and it is
 * the part somebody does before they hand their identity documents to a payment processor.
 *
 * So the page always renders. What payments are is a question the payments section answers.
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

      <SellingManager status={status} initialListings={listings?.items ?? []} />
    </div>
  );
}
