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
 * Where an uploaded photo is in the pipeline (SR-5.5).
 *
 * `pending` means bytes were promised and nothing has looked at them. Nothing is served in that
 * state and nothing counts towards the photo requirement, because a file nobody has inspected
 * is indistinguishable from a file somebody chose carefully.
 */
export const photoStatus = app.enum('photo_status', ['pending', 'approved', 'rejected']);

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
    /**
     * What buyers call this seller (FR-5.7, SR-3.8), or null.
     *
     * Typed by the seller, never copied from the account: no `users.name`, no email, no Discord
     * handle. Null until they choose one, and nulling it again removes the name rather than
     * blanking it — the same rule `creator_profiles` follows.
     *
     * It lives on *this* row, which exists only once Stripe has been asked to onboard the
     * person, and that is the useful part rather than an accident of storage: a public seller
     * identity costs a completed identity check, so an unverified account cannot call itself
     * "Bandai Official Store" on a listing. Worth more than a denylist of reserved words,
     * which is always one spelling behind.
     */
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One connected account per person, and one person per connected account. Two rows
    // pointing at the same Stripe account would make "who gets paid" ambiguous.
    uniqueIndex('seller_accounts_user_key').on(t.userId),
    uniqueIndex('seller_accounts_stripe_key').on(t.stripeAccountId),
    check('seller_accounts_stripe_id_format', sql`${t.stripeAccountId} ~ '^acct_[A-Za-z0-9]+$'`),
    /**
     * Trimmed, 2 to 40, starting and ending alphanumeric. The inner set allows spaces, full
     * stops, underscores, hyphens and apostrophes — enough for "J. Random Cards", not enough
     * for a name made of punctuation or one padded with spaces to sort first. The character
     * class also excludes control characters, which keeps the bidirectional-override trick out.
     */
    check(
      'seller_accounts_display_name_shape',
      sql`${t.displayName} is null
          or (${t.displayName} = btrim(${t.displayName})
              and length(${t.displayName}) between 2 and 40
              and ${t.displayName} ~ '^[[:alnum:]][[:alnum:] ._''-]*[[:alnum:]]$')`,
    ),
    // Case-insensitively unique: two sellers called "TRSTN" is not a naming collision, it is a
    // buyer who cannot tell which one they are paying.
    uniqueIndex('seller_accounts_display_name_key')
      .on(sql`lower(${t.displayName})`)
      .where(sql`${t.displayName} is not null`),
  ],
);

/**
 * A card offered for sale by a person (FR-5.2).
 *
 * **Not to be confused with the other thing this codebase calls a listing.**
 * `packages/db/src/queries/listings.ts` is about `retailer_products` — a shop's page for a
 * sealed product, registered by the scanner. That one is a URL we watch; this one is somebody
 * selling a card. The tables are unambiguous (`listings` and `retailer_products`); only the
 * prose overlaps, and it overlaps enough to be worth saying once here.
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
 * A photograph of the actual card (FR-5.2, SR-5.5, T10).
 *
 * Two keys, because the bytes a stranger uploaded and the bytes a browser receives are never
 * the same bytes:
 *
 *  - `upload_key` is where the original lands. It is written by a presigned PUT, read once by
 *    the pipeline, and **deleted**. It is a staging area, not storage.
 *  - `object_key` is the re-encoded copy, rebuilt from decoded pixels. Null until the pipeline
 *    has finished, because a photo with no approved copy has nothing to serve.
 *
 * Everything the pipeline establishes — the dimensions, the digest, whether a scanner objected
 * — is outside what a session may write. A seller uploads a file and says nothing else about
 * it; the facts are ours to determine, the same way an order's `paid` is Stripe's.
 */
export const listingPhotos = app.table(
  'listing_photos',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** Where the original was PUT. Emptied once the pipeline is done with it. */
    uploadKey: text('upload_key').notNull(),
    /** The re-encoded copy, which is the only one anybody is ever served. */
    objectKey: text('object_key'),
    status: photoStatus('status').notNull().default('pending'),
    /**
     * Why it was refused, as a code from `@gth/security`'s inspection or the virus scanner.
     *
     * Kept rather than deleted: a seller whose upload vanished with no explanation assumes the
     * site is broken, and a rejection nobody recorded is one nobody can count either.
     */
    rejectionReason: text('rejection_reason'),
    contentType: text('content_type'),
    byteSize: integer('byte_size'),
    width: integer('width'),
    height: integer('height'),
    /**
     * Of the **re-encoded** copy, not the upload.
     *
     * Two sellers photographing the same card get different bytes; two listings with the same
     * digest are the same file, which is the cheap half of the stolen-photo check (SR-5.6).
     * Deliberately not unique — an identical photo is a signal to look at, not a thing to
     * refuse, and refusing it would let anybody lock a photo out by uploading it first.
     */
    sha256: text('sha256'),
    /** When a scanner last had an opinion. Null means nothing has looked. */
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    /** Display order, lowest first. Front, then back, then the detail shots. */
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('listing_photos_listing_idx').on(t.listingId, t.position),
    // One row per stored object, both ways. A second row pointing at the same key would make
    // deleting one of them delete the other's picture.
    uniqueIndex('listing_photos_upload_key').on(t.uploadKey),
    uniqueIndex('listing_photos_object_key')
      .on(t.objectKey)
      .where(sql`${t.objectKey} is not null`),
    // For the duplicate-photo question, which asks "who else has this digest".
    index('listing_photos_sha256_idx')
      .on(t.sha256)
      .where(sql`${t.sha256} is not null`),

    // An approved photo has something to serve and something to serve it about. Without this,
    // `approved` with a null `object_key` is a row the gallery would render as a broken image.
    check(
      'listing_photos_approved_is_complete',
      sql`${t.status} <> 'approved'
          or (${t.objectKey} is not null and ${t.width} is not null and ${t.height} is not null
              and ${t.sha256} is not null and ${t.scannedAt} is not null)`,
    ),
    // And a rejected one says why, because "rejected" on its own helps nobody.
    check(
      'listing_photos_rejected_has_reason',
      sql`${t.status} <> 'rejected' or ${t.rejectionReason} is not null`,
    ),
    check(
      'listing_photos_dimensions_sane',
      sql`(${t.width} is null or (${t.width} > 0 and ${t.width} <= 8000))
          and (${t.height} is null or (${t.height} > 0 and ${t.height} <= 8000))`,
    ),
    check(
      'listing_photos_size_sane',
      sql`${t.byteSize} is null or (${t.byteSize} > 0 and ${t.byteSize} <= 10485760)`,
    ),
    check('listing_photos_position_sane', sql`${t.position} >= 0 and ${t.position} < 8`),
    check('listing_photos_sha256_hex', sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`),
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
    /**
     * Our cut, as `application_fee_amount`.
     *
     * Computed server-side from the frozen `amount_cents` and the fee rate in force when the
     * order was opened, and written once — this is the number we *instructed* Stripe to take,
     * which is what the seller's proceeds are, and it is reproducible from the row rather than
     * dependent on a rate that will change later. No session can change it afterwards
     * (migration 0043 keeps it out of the web role's UPDATE grant).
     */
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

    /**
     * One open order per listing (migration 0043).
     *
     * The marketplace's most obvious race: two buyers open the same listing, both get a
     * Checkout session, both pay, and one card owes two people. A `NOT EXISTS` in the insert
     * cannot catch it, because on the web role the subquery only sees the buyer's own orders.
     * A unique index is enforced below row-level security and sees all of them.
     */
    uniqueIndex('orders_one_open_per_listing')
      .on(t.listingId)
      .where(
        sql`${t.listingId} is not null
            and ${t.status} in ('created', 'paid', 'shipped', 'delivered', 'completed', 'disputed')`,
      ),

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
 * What a buyer thought of a sale (FR-5.7).
 *
 * **Only from a completed order, and only from the buyer** — a rule the database keeps rather
 * than one the routes remember: migration 0045's INSERT policy joins to `orders` and requires
 * `status = 'completed'` and `buyer_id = current_setting('app.user_id')`.
 *
 * That matters more than it looks. A reputation system where anybody can leave a review is one
 * where competitors leave reviews, and one where a review can be left before the sale finishes
 * is one where a rating is a threat to be withdrawn. Tying it to a completed order means every
 * star had money behind it.
 *
 * One rating per order rather than per seller: a buyer who buys ten times may rate ten times,
 * and each one is anchored to a transaction somebody can look up.
 */
export const orderRatings = app.table(
  'order_ratings',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** Denormalised from the order so a seller's ratings can be counted without a join. */
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    raterId: text('rater_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** One to five. No half stars and no zero — a zero is a dispute, not a rating. */
    stars: integer('stars').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One per order. Nobody rates the same sale twice, so nobody pads a score by re-rating.
    uniqueIndex('order_ratings_order_key').on(t.orderId),
    index('order_ratings_seller_idx').on(t.sellerId, t.createdAt.desc()),
    check('order_ratings_stars_range', sql`${t.stars} between 1 and 5`),
    check('order_ratings_comment_length', sql`${t.comment} is null or length(${t.comment}) <= 500`),
    // Nobody rates their own sale. `orders_not_self_dealing` already forbids buying from
    // yourself, so this is the second lock on the same door.
    check('order_ratings_not_self', sql`${t.raterId} <> ${t.sellerId}`),
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
