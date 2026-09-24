import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { app, cardVariants } from './catalog.js';
import { cardCondition } from './pricing.js';

/**
 * The marketplace (Phase 5, §14).
 *
 * The first tables in this system that decide where money goes, which changes what the schema
 * is for. Everywhere else a constraint stops a mess; here a constraint stops a loss, so the
 * rules that matter are written as CHECKs and grants rather than trusted to the code above.
 */

/** The eight places an order can be. Kept in step with `@gth/core`'s union by a test. */
export const orderStatus = app.enum('order_status', [
  'created',
  'paid',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'refunded',
  'disputed',
]);

/** Who caused a transition. `stripe` means a webhook whose signature we verified. */
export const orderActor = app.enum('order_actor', ['buyer', 'seller', 'admin', 'stripe', 'system']);

/** Where a listing is in its life. */
export const listingStatus = app.enum('listing_status', ['draft', 'active', 'sold', 'withdrawn']);

/**
 * A seller's Stripe Connect account (FR-5.1, ADR-011).
 *
 * We hold an account *id* and two booleans, and nothing else. No bank details, no tax
 * identity, no date of birth: Stripe does the KYC and keeps the answers, which is the entire
 * reason Connect Express was chosen. The worst case for this table is an attacker learning
 * that somebody sells here.
 *
 * `charges_enabled` and `payouts_enabled` are Stripe's answers, mirrored here so a listing
 * page does not have to call Stripe to decide whether to show a buy button. They are only
 * ever written from a verified webhook — a seller cannot mark their own account ready.
 */
export const sellerAccounts = app.table(
  'seller_accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stripe's id for the connected account, e.g. `acct_…`. */
    stripeAccountId: text('stripe_account_id').notNull(),
    chargesEnabled: boolean('charges_enabled').notNull().default(false),
    payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
    /**
     * Payouts held until this moment (FR-5.6).
     *
     * A new seller's first orders are held for a week after delivery, which is the cheapest
     * defence there is against the empty-envelope trade: the money is still here when the
     * buyer notices. Null means no hold.
     */
    holdUntil: timestamp('hold_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One connected account per person, and one person per connected account. Two rows
    // pointing at the same Stripe account would make "who gets paid" ambiguous.
    uniqueIndex('seller_accounts_user_key').on(t.userId),
    uniqueIndex('seller_accounts_stripe_key').on(t.stripeAccountId),
    check('seller_accounts_stripe_id_format', sql`${t.stripeAccountId} ~ '^acct_[A-Za-z0-9]+$'`),
  ],
);

/**
 * A card offered for sale (FR-5.2).
 *
 * `card_variant_id` is required, unlike a live-sale entry or a break pull. Those record
 * something that happened and are still worth having when the catalog is thin; a listing that
 * names no card is one nobody can search for, and it would be the obvious way to sell
 * something this marketplace has not agreed to carry.
 *
 * The price is a snapshot on the order, not a reference to this row — see `orders`.
 */
export const listings = app.table(
  'listings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardVariantId: uuid('card_variant_id')
      .notNull()
      .references(() => cardVariants.id, { onDelete: 'restrict' }),
    condition: cardCondition('condition').notNull(),
    priceCents: integer('price_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    quantity: integer('quantity').notNull().default(1),
    status: listingStatus('status').notNull().default('draft'),
    /**
     * Whether this listing must carry photos before it can go live (FR-5.2).
     *
     * Recorded rather than recomputed, because the threshold is a policy that will change and
     * a listing created under the old one should keep the promise it was made under. A row
     * that says "photos were required for this" is auditable; a rule applied at read time is
     * whatever the rule happens to be today.
     */
    photoRequired: boolean('photo_required').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The marketplace browse: what is for sale, cheapest first, by card.
    index('listings_variant_active_idx')
      .on(t.cardVariantId, t.priceCents)
      .where(sql`${t.status} = 'active'`),
    // A seller's own page.
    index('listings_seller_idx').on(t.sellerId, t.createdAt.desc()),
    check('listings_price_positive', sql`${t.priceCents} > 0`),
    // The same ceiling live sales use. A typo that adds three zeroes should fail here rather
    // than become a checkout session.
    check('listings_price_sane', sql`${t.priceCents} <= 100000000`),
    check('listings_quantity_positive', sql`${t.quantity} >= 1`),
    check('listings_quantity_sane', sql`${t.quantity} <= 999`),
    check('listings_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('listings_notes_length', sql`${t.notes} is null or length(${t.notes}) <= 500`),
  ],
);

/**
 * A purchase (FR-5.4).
 *
 * **Everything about what was bought is copied onto this row.** The card, the condition, the
 * price, the currency. A listing can be edited or withdrawn, and an order has to keep saying
 * what was actually agreed six months later when somebody disputes it — a foreign key to a
 * mutable row would let the seller rewrite history by editing the listing.
 *
 * `listing_id` is kept, nullable, for "where did this come from". It is a breadcrumb, not the
 * source of truth.
 *
 * Money is never taken from client input. `amount_cents` is what we told Stripe to charge;
 * `fee_cents` and `tax_cents` are what Stripe reported back. The status moves only through
 * `@gth/core`'s state machine, and `paid` only from a verified webhook (SR-5.7).
 */
export const orders = app.table(
  'orders',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'set null' }),

    /** What was bought, as agreed, frozen. */
    cardVariantId: uuid('card_variant_id')
      .notNull()
      .references(() => cardVariants.id, { onDelete: 'restrict' }),
    condition: cardCondition('condition').notNull(),
    quantity: integer('quantity').notNull().default(1),

    status: orderStatus('status').notNull().default('created'),

    /** What the buyer pays, in total. */
    amountCents: integer('amount_cents').notNull(),
    /** Our cut (`application_fee_amount`). Reported by Stripe, not computed here. */
    feeCents: integer('fee_cents').notNull().default(0),
    /** Collected by Stripe Tax as marketplace facilitator. */
    taxCents: integer('tax_cents').notNull().default(0),
    currency: text('currency').notNull().default('USD'),

    /**
     * Stripe's identifiers. Unique because each belongs to exactly one order, and a duplicate
     * would mean two orders believing they were paid by the same payment.
     */
    stripeCheckoutId: text('stripe_checkout_id'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),

    /** Required above a configurable value before an order may be marked shipped (FR-5.4). */
    trackingCarrier: text('tracking_carrier'),
    trackingNumber: text('tracking_number'),

    paidAt: timestamp('paid_at', { withTimezone: true }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_buyer_idx').on(t.buyerId, t.createdAt.desc()),
    index('orders_seller_idx').on(t.sellerId, t.createdAt.desc()),
    uniqueIndex('orders_checkout_key')
      .on(t.stripeCheckoutId)
      .where(sql`${t.stripeCheckoutId} is not null`),
    uniqueIndex('orders_payment_intent_key')
      .on(t.stripePaymentIntentId)
      .where(sql`${t.stripePaymentIntentId} is not null`),

    // Nobody buys their own card. Wash trading is how a marketplace's numbers stop meaning
    // anything, and it is one line to forbid.
    check('orders_not_self_dealing', sql`${t.buyerId} <> ${t.sellerId}`),

    check('orders_amount_positive', sql`${t.amountCents} > 0`),
    check('orders_amount_sane', sql`${t.amountCents} <= 100000000`),
    check('orders_fee_non_negative', sql`${t.feeCents} >= 0`),
    check('orders_tax_non_negative', sql`${t.taxCents} >= 0`),
    // Our fee cannot exceed what was charged. A sign error here takes money from a seller.
    check('orders_fee_within_amount', sql`${t.feeCents} <= ${t.amountCents}`),
    check('orders_quantity_positive', sql`${t.quantity} >= 1`),
    check('orders_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),

    /**
     * An order past `created` has a payment behind it.
     *
     * The database's own version of "money moved" — a row claiming to be paid with no payment
     * intent is either a bug or somebody writing statuses directly, and both should fail here
     * rather than be discovered during a dispute.
     */
    check(
      'orders_paid_has_payment',
      sql`${t.status} in ('created', 'cancelled') or ${t.stripePaymentIntentId} is not null`,
    ),
    // Shipped means posted, and posted means there is a tracking number to look up.
    check(
      'orders_shipped_has_tracking',
      sql`${t.status} not in ('shipped', 'delivered', 'completed')
          or (${t.trackingCarrier} is not null and ${t.trackingNumber} is not null)`,
    ),
  ],
);

/**
 * Every transition an order made, and who caused it (FR-5.4, SR-5.7).
 *
 * Append-only, like `audit_log` and `break_pulls`, and for the same reason: this is the record
 * somebody reaches for when the two parties disagree about what happened. A history that can
 * be edited by the application that wrote it is not evidence. No role gets UPDATE or DELETE.
 */
export const orderEvents = app.table(
  'order_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: orderStatus('from_status').notNull(),
    toStatus: orderStatus('to_status').notNull(),
    actor: orderActor('actor').notNull(),
    /** Which person, when it was one. Null for `stripe` and `system`, which are not people. */
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Why, for the transitions where a reason is the point: refunds, cancellations, rulings. */
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('order_events_order_idx').on(t.orderId, t.at),
    check('order_events_reason_length', sql`${t.reason} is null or length(${t.reason}) <= 280`),
    // A person's transition names the person; a machine's does not pretend to.
    check(
      'order_events_actor_identified',
      sql`(${t.actor} in ('stripe', 'system') and ${t.actorId} is null)
          or (${t.actor} in ('buyer', 'seller', 'admin'))`,
    ),
  ],
);

/**
 * Every webhook we have already handled (SR-5.2).
 *
 * The idempotency table. Stripe retries, and a retry that is processed twice is an order
 * shipped twice or a refund issued twice. The unique constraint is the whole mechanism: insert
 * first, and if the insert conflicts the event has been seen and there is nothing to do.
 *
 * Deliberately not on `app_web`. A webhook is not a session, and the route that handles one
 * runs on the worker role.
 */
export const webhookEvents = app.table(
  'webhook_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(),
    /** The provider's own id for the event, e.g. `evt_…`. */
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null until it has been acted on, so a crash mid-handling is visible afterwards. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('webhook_events_provider_event_key').on(t.provider, t.eventId),
    index('webhook_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);
