import { SignInRequired } from '@/components/sign-in-required';
import { api } from '@/lib/api';
import { OrdersManager } from './orders-manager';

export const metadata = {
  title: 'Orders · Gundam TCG Hub',
  robots: { index: false, follow: false },
};

/**
 * Both sides of every order, on one page (FR-5.4, FR-5.5).
 *
 * `GET /v1/orders` returns what this person bought *and* what they sold, because row-level
 * security matches on either party. That is not a shortcut — it is the correct shape. The same
 * person is a buyer on Monday and a seller on Tuesday, and two pages would mean two places to
 * look for the order somebody is asking about.
 *
 * Which side they are on is decided here, from their own id, and it decides which actions
 * exist. The API decides it again, from the session, and the database decides it a third time
 * from the policy — so this one is about showing the right buttons, not about permission.
 */
export default async function OrdersPage(): Promise<React.JSX.Element> {
  const me = await api.me();
  if (!me) {
    return (
      <SignInRequired
        title="Orders"
        reason="see what you have bought and sold"
        next="/account/orders"
      />
    );
  }

  const orders = await api.myOrders();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="mt-1 text-sm text-muted">
          What you have bought and what you have sold. Every change to an order is recorded, and
          both of you can read the record.
        </p>
      </header>

      {orders === null ? (
        <p className="rounded border p-4 text-sm text-muted border-line" data-testid="market-off">
          The marketplace is not switched on for this site yet.
        </p>
      ) : (
        <OrdersManager meId={me.id} initialOrders={orders.items} />
      )}
    </div>
  );
}
