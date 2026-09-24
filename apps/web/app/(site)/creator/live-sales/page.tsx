import { SignInRequired } from '@/components/sign-in-required';
import { api } from '@/lib/api';
import { SaleLogger } from './sale-logger';

export const metadata = { title: 'Live sales · Gundam TCG Hub' };

export default async function LiveSalesPage(): Promise<React.JSX.Element> {
  const me = await api.me();
  if (!me) {
    return (
      <SignInRequired title="Live sales" reason="log a live sale" next="/creator/live-sales" />
    );
  }

  const result = await api.liveSales();
  // `null` means the API refused: no session, or an account without the seller role.
  if (!result) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Live sales</h1>
        <p className="max-w-prose text-sm text-muted">
          Logging live sales is for seller accounts. It is a role an admin grants.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Live sales</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Log each single as it sells. These are the prices nobody else records — a card sold on a
          stream leaves no listing and no sold-price page — so they carry as much weight in the
          index as our own break pulls.
        </p>
      </header>

      <SaleLogger
        initial={result.items.map((sale) => ({
          ...sale,
          soldAt: sale.soldAt,
        }))}
      />

      <section className="max-w-prose space-y-2 text-sm text-muted">
        <h2 className="font-medium text-fg">What happens to an entry</h2>
        <p>
          It is recorded immediately and counts towards the published price a little later, once it
          has been checked against the current spread for that card. One that sits far outside is{' '}
          <strong>held for review</strong> rather than dropped — a $900 sale of a $12 card is either
          a typo or the most interesting thing that happened all week, and only a person can tell
          which.
        </p>
        <p>
          An entry can be removed until it reaches the index. After that it stays, because a
          published number has to keep something behind it.
        </p>
      </section>
    </div>
  );
}
