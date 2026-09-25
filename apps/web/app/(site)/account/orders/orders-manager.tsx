'use client';

// Type-only: `lib/api.ts` imports `next/headers`, and a value import of it from a client
// component pulls a server-only module into the browser bundle.
import type { Order, OrderEvent, OrderStatus } from '@/lib/api';
import { dollars } from '@/lib/money';
import { type SyntheticEvent, useCallback, useState } from 'react';

/**
 * Moving an order along, from whichever side you are on (FR-5.4, FR-5.5, FR-5.7).
 *
 * The buttons here are a subset of a subset. The state machine in `@gth/core` decides which
 * transitions exist; the database decides which of those this role may write at all — it has
 * no privilege on `delivered` or `completed`, because those release a seller's payout and must
 * never come from the person who benefits. What is left is: the seller ships, the buyer
 * disputes, either cancels before money moved, and the buyer rates a finished order.
 *
 * So this component shows fewer buttons than the API allows, and the API allows fewer moves
 * than the state machine describes. Each layer narrows the one below it, and none of them is
 * the only thing standing between an order and a status it should not have.
 */

const TERMINAL: ReadonlySet<OrderStatus> = new Set(['completed', 'cancelled', 'refunded']);

/** Plain words for the status, because `disputed` on its own tells a buyer nothing. */
const EXPLAIN: Record<OrderStatus, string> = {
  created: 'waiting for payment',
  paid: 'paid — waiting for the seller to post it',
  shipped: 'on its way',
  delivered: 'delivered',
  completed: 'finished',
  cancelled: 'cancelled',
  refunded: 'refunded',
  disputed: 'in dispute',
};

function messageFor(error: string | undefined, status: number): string {
  switch (error) {
    case 'illegal_transition':
      return 'That order has already moved on. Reload the page to see where it is now.';
    case 'wrong_party':
      return 'That is not yours to do on this order.';
    case 'not_found':
      return 'That order is no longer there.';
    case 'already_rated':
      return 'You have already rated this order.';
    case 'not_ratable':
      return 'An order can only be rated by its buyer, once it has finished.';
    case 'invalid_request':
      return 'Something in that form was not accepted.';
    case 'unauthenticated':
      return 'You have been signed out. Sign in again to carry on.';
    default:
      return status === 429
        ? 'That has been done several times already. Try again shortly.'
        : 'That did not work. Nothing was changed.';
  }
}

async function problemOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return messageFor(typeof body?.error === 'string' ? body.error : undefined, response.status);
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export function OrdersManager({
  meId,
  initialOrders,
}: {
  meId: string;
  initialOrders: Order[];
}): React.JSX.Element {
  const [orders, setOrders] = useState(initialOrders);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<Record<string, OrderEvent[]>>({});
  /** Which order has a form open, and which one — at most one at a time, deliberately. */
  const [open, setOpen] = useState<{ id: string; form: 'ship' | 'dispute' | 'rate' } | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch('/v1/orders', { cache: 'no-store' });
    if (!response.ok) return;
    const body = (await response.json()) as { items: Order[] };
    setOrders(body.items);
  }, []);

  const loadEvents = useCallback(async (orderId: string) => {
    const response = await fetch(`/v1/orders/${orderId}/events`, { cache: 'no-store' });
    if (!response.ok) return;
    const body = (await response.json()) as { items: OrderEvent[] };
    setEvents((current) => ({ ...current, [orderId]: body.items }));
  }, []);

  /** Every action on this page is the same shape: post, translate a refusal, reload. */
  async function act(path: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) {
        setProblem(await problemOf(response));
        return false;
      }
      await refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function ship(event: SyntheticEvent<HTMLFormElement>, id: string): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ok = await act(`/v1/orders/${id}/ship`, {
      carrier: field(form, 'carrier'),
      trackingNumber: field(form, 'trackingNumber'),
    });
    if (ok) setOpen(null);
  }

  async function dispute(event: SyntheticEvent<HTMLFormElement>, id: string): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ok = await act(`/v1/orders/${id}/dispute`, { reason: field(form, 'reason') });
    if (ok) setOpen(null);
  }

  async function rate(event: SyntheticEvent<HTMLFormElement>, id: string): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const comment = field(form, 'comment').trim();
    const ok = await act(`/v1/orders/${id}/rating`, {
      stars: Number(field(form, 'stars')),
      // An empty box is no comment, not an empty one.
      comment: comment === '' ? null : comment,
    });
    if (ok) setOpen(null);
  }

  const buying = orders.filter((order) => order.buyerId === meId);
  const selling = orders.filter((order) => order.sellerId === meId);

  function card(order: Order, side: 'buying' | 'selling'): React.JSX.Element {
    const timeline = events[order.id];
    const form = open?.id === order.id ? open.form : null;
    return (
      <li
        key={order.id}
        className="rounded border p-3 border-line"
        data-testid={`order-${order.id}`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium">
            {dollars(order.amountCents, order.currency)}{' '}
            <span className="text-sm text-muted">
              · {order.condition.toUpperCase()} · ×{order.quantity}
            </span>
          </span>
          <span className="text-sm text-muted" data-testid={`order-status-${order.id}`}>
            {EXPLAIN[order.status]}
          </span>
        </div>

        {order.trackingNumber !== null && (
          <p className="mt-1 text-xs text-muted">
            {order.trackingCarrier ?? 'Carrier'} · {order.trackingNumber}
          </p>
        )}

        <div className="mt-2 flex flex-wrap gap-2">
          {/* The seller has the parcel, so shipping is theirs and nobody else's. */}
          {side === 'selling' && order.status === 'paid' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen({ id: order.id, form: 'ship' });
              }}
              className="rounded border px-2 py-1 text-xs disabled:opacity-50 border-line"
              data-testid={`ship-${order.id}`}
            >
              Mark as posted
            </button>
          )}

          {/* Before any money moved, either side may walk away. After `paid` the state
              machine refuses it: a paid order is unwound through Stripe, by an admin. */}
          {order.status === 'created' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(`/v1/orders/${order.id}/cancel`, {})}
              className="rounded border px-2 py-1 text-xs disabled:opacity-50 border-line"
              data-testid={`cancel-${order.id}`}
            >
              Cancel
            </button>
          )}

          {side === 'buying' && !TERMINAL.has(order.status) && order.status !== 'created' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen({ id: order.id, form: 'dispute' });
              }}
              className="rounded border px-2 py-1 text-xs disabled:opacity-50 border-line"
              data-testid={`dispute-${order.id}`}
            >
              Something is wrong
            </button>
          )}

          {side === 'buying' && order.status === 'completed' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen({ id: order.id, form: 'rate' });
              }}
              className="rounded border px-2 py-1 text-xs disabled:opacity-50 border-line"
              data-testid={`rate-${order.id}`}
            >
              Rate the seller
            </button>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => void loadEvents(order.id)}
            className="rounded border px-2 py-1 text-xs disabled:opacity-50 border-line"
            data-testid={`history-${order.id}`}
          >
            History
          </button>
        </div>

        {form === 'ship' && (
          <form
            onSubmit={(event) => void ship(event, order.id)}
            className="mt-3 grid gap-2 sm:grid-cols-3"
            data-testid={`ship-form-${order.id}`}
          >
            <input
              name="carrier"
              required
              minLength={2}
              placeholder="Carrier"
              className="rounded border px-2 py-1 text-sm border-line bg-transparent"
            />
            <input
              name="trackingNumber"
              required
              minLength={4}
              placeholder="Tracking number"
              className="rounded border px-2 py-1 text-sm border-line bg-transparent"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded px-2 py-1 text-sm font-medium disabled:opacity-50 bg-accent"
            >
              Posted
            </button>
            <p className="text-xs text-muted sm:col-span-3">
              Tracking is required, not optional. An untracked parcel is a dispute with no evidence
              in it, and the person who loses that argument is you.
            </p>
          </form>
        )}

        {form === 'dispute' && (
          <form
            onSubmit={(event) => void dispute(event, order.id)}
            className="mt-3 space-y-2"
            data-testid={`dispute-form-${order.id}`}
          >
            <textarea
              name="reason"
              required
              maxLength={500}
              rows={3}
              placeholder="What is wrong with this order?"
              className="w-full rounded border px-2 py-1 text-sm border-line bg-transparent"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded px-2 py-1 text-sm font-medium disabled:opacity-50 bg-accent"
            >
              Open a dispute
            </button>
            <p className="text-xs text-muted">
              The seller can read this, and so can whoever resolves it. Try messaging them first —
              most of these are a delay rather than a problem.
            </p>
          </form>
        )}

        {form === 'rate' && (
          <form
            onSubmit={(event) => void rate(event, order.id)}
            className="mt-3 space-y-2"
            data-testid={`rate-form-${order.id}`}
          >
            <label className="block text-sm">
              <span className="text-muted">Stars</span>
              <select
                name="stars"
                defaultValue="5"
                className="ml-2 rounded border px-2 py-1 border-line bg-transparent"
              >
                {[5, 4, 3, 2, 1].map((stars) => (
                  <option key={stars} value={stars}>
                    {stars}
                  </option>
                ))}
              </select>
            </label>
            <textarea
              name="comment"
              maxLength={500}
              rows={2}
              placeholder="Anything worth saying (optional)"
              className="w-full rounded border px-2 py-1 text-sm border-line bg-transparent"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded px-2 py-1 text-sm font-medium disabled:opacity-50 bg-accent"
            >
              Leave the rating
            </button>
          </form>
        )}

        {timeline !== undefined && (
          <ol
            className="mt-3 space-y-1 text-xs text-muted"
            data-testid={`history-list-${order.id}`}
          >
            {timeline.length === 0 && <li>Nothing recorded yet.</li>}
            {timeline.map((event) => (
              <li key={event.id}>
                {new Date(event.at).toLocaleString()} · {event.fromStatus} → {event.toStatus} (
                {event.actor}){event.reason === null ? '' : ` · ${event.reason}`}
              </li>
            ))}
          </ol>
        )}
      </li>
    );
  }

  return (
    <div className="space-y-8">
      {problem !== null && (
        <p role="alert" className="text-sm text-danger" data-testid="orders-problem">
          {problem}
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Buying</h2>
        {buying.length === 0 ? (
          <p className="text-sm text-muted">You have not bought anything yet.</p>
        ) : (
          <ul className="space-y-3" data-testid="buying-list">
            {buying.map((order) => card(order, 'buying'))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Selling</h2>
        {selling.length === 0 ? (
          <p className="text-sm text-muted">Nobody has bought from you yet.</p>
        ) : (
          <ul className="space-y-3" data-testid="selling-list">
            {selling.map((order) => card(order, 'selling'))}
          </ul>
        )}
      </section>
    </div>
  );
}
