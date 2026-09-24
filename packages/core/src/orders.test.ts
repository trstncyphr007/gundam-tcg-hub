import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  ORDER_STATUSES,
  type OrderActor,
  type OrderStatus,
  actorsFor,
  canTransition,
  isTerminal,
  moneyHasMoved,
  nextStates,
  transition,
} from './orders.js';

/**
 * The order state machine (FR-5.4, SR-5.7, AC-5.4).
 *
 * These are mostly *properties* rather than cases, because a test that walks the same table
 * the code walks proves only that I can copy. What is worth pinning is the handful of things
 * that must hold however the table is edited — and every one of them is a rule about who is
 * allowed to move somebody else's money.
 */
const ACTORS: readonly OrderActor[] = ['buyer', 'seller', 'admin', 'stripe', 'system'];

/** Every (from, to, actor) there is. Small enough to be exhaustive: 8 × 8 × 5. */
function everyMove(): { from: OrderStatus; to: OrderStatus; actor: OrderActor }[] {
  return ORDER_STATUSES.flatMap((from) =>
    ORDER_STATUSES.flatMap((to) => ACTORS.map((actor) => ({ from, to, actor }))),
  );
}

describe('who may move money', () => {
  it('lets nobody but Stripe mark an order paid', () => {
    // The whole reason this file exists. `paid` means money left the buyer, and the only
    // thing that knows whether that happened is the processor, over a signature we checked.
    // An admin, a seller or a compromised session asserting it is exactly the attack.
    for (const { from, actor } of everyMove().filter((m) => m.to === 'paid')) {
      if (canTransition(from, 'paid', actor)) {
        expect(actor, `${from} → paid as ${actor}`).toBe('stripe');
      }
    }
    expect(actorsFor('created', 'paid')).toEqual(['stripe']);
  });

  it('lets nobody but Stripe mark an order refunded', () => {
    // An admin starts a refund by asking Stripe for one; the webhook that follows moves the
    // order. What an admin cannot do is write the state directly.
    for (const { from, actor } of everyMove().filter((m) => m.to === 'refunded')) {
      if (canTransition(from, 'refunded', actor)) {
        expect(actor, `${from} → refunded as ${actor}`).toBe('stripe');
      }
    }
  });

  it('lets neither party declare the sale finished', () => {
    // `completed` releases the payout hold (FR-5.6). A seller doing it is marking their own
    // homework; a buyer doing it is AC-5.4's explicit "cannot". It is the clock or an admin.
    for (const { from, actor } of everyMove().filter((m) => m.to === 'completed')) {
      if (canTransition(from, 'completed', actor)) {
        expect(['system', 'admin'], `${from} → completed as ${actor}`).toContain(actor);
      }
    }
  });

  it('does not let the seller confirm their own delivery', () => {
    // One step earlier and the same argument: delivery starts the clock that ends in the
    // payout, so it comes from the carrier or an admin.
    for (const { from } of everyMove().filter((m) => m.to === 'delivered')) {
      expect(canTransition(from, 'delivered', 'seller'), `${from} → delivered as seller`).toBe(
        false,
      );
    }
  });

  it('lets the seller say they posted it, because they are the one who did', () => {
    expect(canTransition('paid', 'shipped', 'seller')).toBe(true);
    expect(canTransition('paid', 'shipped', 'buyer')).toBe(false);
  });
});

describe('the shape of the machine', () => {
  it('never allows a state to follow itself', () => {
    for (const status of ORDER_STATUSES) {
      expect(nextStates(status), `${status} → ${status}`).not.toContain(status);
    }
  });

  it('has exactly two terminal states, and they are the two that are over', () => {
    const terminal = ORDER_STATUSES.filter((s) => isTerminal(s));
    expect(terminal.toSorted()).toEqual(['cancelled', 'refunded']);
  });

  it('can reach every state from a new order', () => {
    // A state nothing can reach is a state that will never be tested, never be seen, and
    // eventually be reasoned about as though it happens.
    const seen = new Set<OrderStatus>(['created']);
    const queue: OrderStatus[] = ['created'];
    while (queue.length > 0) {
      const at = queue.shift();
      if (at === undefined) break;
      for (const next of nextStates(at)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect(seen.size, `unreachable: ${ORDER_STATUSES.filter((s) => !seen.has(s)).join(', ')}`).toBe(
      ORDER_STATUSES.length,
    );
  });

  it('lets a dispute be raised from every state where money is at stake', () => {
    // A buyer who has paid can always escalate, right through completion — chargebacks do
    // not respect our state diagram.
    for (const from of ['paid', 'shipped', 'delivered', 'completed'] as const) {
      expect(canTransition(from, 'disputed', 'buyer'), from).toBe(true);
    }
    // But not before they have paid: there is nothing to dispute.
    expect(canTransition('created', 'disputed', 'buyer')).toBe(false);
  });

  it('resolves a dispute in exactly two directions', () => {
    expect(nextStates('disputed').toSorted()).toEqual(['completed', 'refunded']);
  });

  it('cannot be reached through the prototype chain', () => {
    // Every status here arrives from outside — a database row, a request body, a webhook. A
    // plain object indexed by an outside value answers for `constructor` and `toString`, and
    // the answer is a function rather than `undefined`, which is how a lookup becomes a
    // vulnerability. A Map has no such keys.
    for (const evil of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const status = evil as OrderStatus;
      expect(canTransition(status, 'paid', 'stripe'), evil).toBe(false);
      expect(canTransition('created', status, 'stripe'), evil).toBe(false);
      expect(actorsFor(status, 'paid'), evil).toEqual([]);
      expect(nextStates(status), evil).toEqual([]);
      // No moves out of it, so it reads as terminal rather than as a usable state.
      expect(isTerminal(status), evil).toBe(true);
      expect(() => transition(status, 'paid', 'stripe'), evil).toThrow(IllegalTransitionError);
    }
  });
});

describe('refusing a move', () => {
  it('walks the happy path', () => {
    let status: OrderStatus = 'created';
    status = transition(status, 'paid', 'stripe');
    status = transition(status, 'shipped', 'seller');
    status = transition(status, 'delivered', 'system');
    status = transition(status, 'completed', 'system');
    expect(status).toBe('completed');
  });

  it('says a move is not a move, separately from not being yours', () => {
    // Different bugs, and an operator reading the audit log needs to know which one somebody
    // hit. A seller trying to skip straight to delivered is a broken client; a seller trying
    // to mark their own order paid is something else.
    expect(() => transition('created', 'delivered', 'admin')).toThrow(IllegalTransitionError);
    try {
      transition('created', 'delivered', 'admin');
    } catch (error) {
      expect((error as IllegalTransitionError).reason).toBe('not_a_transition');
    }

    try {
      transition('created', 'paid', 'seller');
    } catch (error) {
      expect((error as IllegalTransitionError).reason).toBe('not_this_actor');
      expect((error as IllegalTransitionError).actor).toBe('seller');
    }
  });

  it('refuses to move anything out of a terminal state', () => {
    for (const from of ['cancelled', 'refunded'] as const) {
      for (const { to, actor } of everyMove().filter((m) => m.from === from)) {
        expect(canTransition(from, to, actor), `${from} → ${to} as ${actor}`).toBe(false);
      }
    }
  });

  it('never puts the reason in the message when it would name the actor unnecessarily', () => {
    // "an order cannot go from created to delivered" is the truth for everyone; naming who
    // asked would make the same illegal move read as five different errors in a log.
    expect(() => transition('created', 'delivered', 'admin')).toThrow(
      'an order cannot go from created to delivered',
    );
  });
});

describe('whether the buyer is owed anything', () => {
  it('knows that cancelling an unpaid order owes nobody', () => {
    expect(moneyHasMoved('created')).toBe(false);
    expect(moneyHasMoved('cancelled')).toBe(false);
  });

  it('knows that everything after payment does', () => {
    // Including `refunded`: the money moved, and then moved back. A refund that thinks no
    // money ever moved is a refund that does not happen.
    for (const status of [
      'paid',
      'shipped',
      'delivered',
      'completed',
      'disputed',
      'refunded',
    ] as const) {
      expect(moneyHasMoved(status), status).toBe(true);
    }
  });
});
