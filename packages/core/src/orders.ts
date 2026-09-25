/**
 * What may happen to an order, and who may make it happen (FR-5.4, SR-5.7).
 *
 * This is the first thing in Phase 5 because everything else defers to it. An order is the
 * only object in this system where being wrong costs somebody money, and the two ways to get
 * that wrong are letting a state follow one it cannot follow, and letting the wrong party
 * cause it.
 *
 * Pure, and deliberately so: no database, no Stripe, no clock. The rules are a table that can
 * be read in one sitting and tested exhaustively, rather than a set of `if` statements spread
 * across the routes that happen to need them.
 *
 * ## The rule that matters most
 *
 * **`paid` and `refunded` can only be reached by Stripe.**
 *
 * Not by a buyer, not by a seller, not by an admin, not by us. Those two states mean money
 * moved, and the only thing that knows whether money moved is the payment processor telling
 * us so over a signed webhook (SR-5.2). Every other design lets a request that reaches our API
 * assert a payment that never happened.
 *
 * An admin *can* start a refund — by asking Stripe to refund, which produces the webhook that
 * moves the order. What an admin cannot do is write `refunded` directly, and the difference
 * between those two sentences is the whole control.
 *
 * ## Why neither party can declare the sale finished
 *
 * `completed` releases the seller's payout (FR-5.6). So it is reachable only by `system` — the
 * clock, once the delivery and the hold window have both passed — or by an `admin` resolving a
 * dispute. A seller marking their own sale complete would be marking their own homework, and a
 * buyer doing it is AC-5.4's explicit "cannot". Neither party gets to move their own money.
 *
 * `delivered` is the same argument one step earlier: it starts the clock that leads to
 * `completed`, so it comes from carrier confirmation (`system`) or an admin, never from the
 * seller who benefits from it.
 */

/** Where an order can be. */
export type OrderStatus =
  | 'created'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'disputed';

/**
 * Who is asking.
 *
 * `stripe` is a verified webhook and nothing else — the caller constructs it only after the
 * signature has been checked against the raw body. `system` is our own scheduled work, which
 * no request can impersonate because no route accepts it.
 */
export type OrderActor = 'buyer' | 'seller' | 'admin' | 'stripe' | 'system';

/**
 * Longest reason a transition may carry, matching the `order_events` CHECK.
 *
 * Long enough to say what happened, short enough that nobody writes an essay into a field two
 * people will read during an argument.
 */
export const ORDER_REASON_MAX_LENGTH = 280;

/**
 * How long a delivered order waits before the clock completes it (FR-5.6).
 *
 * The window in which a buyer can say the card never arrived, or arrived wrong. Seven days is
 * the plan's payout hold, and completing earlier than the hold would release a payout while the
 * buyer still has a claim — which is the one thing the hold exists to prevent.
 */
export const AUTO_COMPLETE_AFTER_DAYS = 7;

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'created',
  'paid',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'refunded',
  'disputed',
];

/**
 * Every legal move, and who may make it. Anything not written here cannot happen.
 *
 * Read it as: from this state, this actor may put the order into that state.
 */
const TABLE: Readonly<
  Record<OrderStatus, Readonly<Partial<Record<OrderStatus, readonly OrderActor[]>>>>
> = {
  created: {
    // Money moved. Only the processor can say so.
    paid: ['stripe'],
    // Before any money moved, either side may walk away, and an abandoned checkout is
    // swept up by the clock.
    cancelled: ['buyer', 'seller', 'admin', 'system'],
  },
  paid: {
    // The one transition the seller owns outright: they are the one with the parcel.
    shipped: ['seller'],
    refunded: ['stripe'],
    disputed: ['buyer', 'admin'],
    // Paid but never shipped, cancelled by an admin: the refund that follows is a separate
    // transition from `cancelled`, because the money has to come back through Stripe.
    cancelled: ['admin'],
  },
  shipped: {
    // Carrier confirmation or an admin. Not the seller — see the header.
    delivered: ['system', 'admin'],
    refunded: ['stripe'],
    disputed: ['buyer', 'admin'],
  },
  delivered: {
    // The clock, once the hold has passed. Or an admin closing it early.
    completed: ['system', 'admin'],
    refunded: ['stripe'],
    disputed: ['buyer', 'admin'],
  },
  completed: {
    // A sale can still go wrong after it is finished: the dispute window outlives
    // completion, and a chargeback arrives whenever it arrives.
    disputed: ['buyer', 'admin', 'stripe'],
    refunded: ['stripe'],
  },
  disputed: {
    // Resolved for the buyer: the money goes back, through Stripe.
    refunded: ['stripe'],
    // Resolved for the seller: an admin decides, and says why (the reason is recorded by
    // the caller, not here).
    completed: ['admin'],
  },
  cancelled: {},
  refunded: {},
};

/**
 * The same table as a Map, which is what everything below reads.
 *
 * Built once at module load, from a literal that is easier to read than nested `new Map`
 * calls. A Map rather than the object itself because every lookup here takes a status that
 * arrived from somewhere — a database row, a request body, a webhook — and an object indexed
 * by an outside value can be reached through its prototype. `TABLE['constructor']` is not a
 * transition; `MOVES.get('constructor')` is `undefined`, which is the answer.
 *
 * The same reasoning the CSV reader uses for `__proto__` column names, applied to a table
 * whose wrong answer costs money.
 */
const MOVES: ReadonlyMap<OrderStatus, ReadonlyMap<OrderStatus, readonly OrderActor[]>> = new Map(
  Object.entries(TABLE).map(([from, tos]) => [
    from as OrderStatus,
    new Map(Object.entries(tos) as [OrderStatus, readonly OrderActor[]][]),
  ]),
);

/** States nothing can follow. */
export function isTerminal(status: OrderStatus): boolean {
  return (MOVES.get(status)?.size ?? 0) === 0;
}

/** Where this order could go next, for anybody. Useful for a UI, never for a decision. */
export function nextStates(status: OrderStatus): OrderStatus[] {
  return [...(MOVES.get(status)?.keys() ?? [])];
}

/** May this actor move this order from here to there? */
export function canTransition(from: OrderStatus, to: OrderStatus, actor: OrderActor): boolean {
  return MOVES.get(from)?.get(to)?.includes(actor) ?? false;
}

/** Who, if anyone, may make this move. Empty when the move itself is illegal. */
export function actorsFor(from: OrderStatus, to: OrderStatus): readonly OrderActor[] {
  return MOVES.get(from)?.get(to) ?? [];
}

/**
 * Refused, with enough to write an audit entry and nothing an attacker learns from.
 *
 * The two cases are distinguished on purpose — "that is not a move" and "that is not your
 * move" are different bugs, and an operator reading the audit log needs to know which one
 * somebody hit. The *caller* decides what the client is told; SR-5.7 requires the attempt to
 * be logged either way.
 */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    readonly actor: OrderActor,
    readonly reason: 'not_a_transition' | 'not_this_actor',
  ) {
    super(
      `an order cannot go from ${from} to ${to}${reason === 'not_this_actor' ? ` as ${actor}` : ''}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Make the move, or refuse it.
 *
 * Returns the new status rather than mutating anything, so the caller writes the row and the
 * `order_events` entry in one transaction and this function stays a decision.
 */
export function transition(from: OrderStatus, to: OrderStatus, actor: OrderActor): OrderStatus {
  const allowed = MOVES.get(from)?.get(to);
  if (allowed === undefined) {
    throw new IllegalTransitionError(from, to, actor, 'not_a_transition');
  }
  if (!allowed.includes(actor)) {
    throw new IllegalTransitionError(from, to, actor, 'not_this_actor');
  }
  return to;
}

/**
 * Has money left the buyer?
 *
 * The question the refund path asks, and the reason `cancelled` and `refunded` are separate
 * states rather than one "did not happen": cancelling an unpaid order is bookkeeping, and
 * cancelling a paid one owes somebody their money back.
 */
export function moneyHasMoved(status: OrderStatus): boolean {
  return status !== 'created' && status !== 'cancelled';
}
