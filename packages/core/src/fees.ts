/**
 * What the platform keeps (FR-5.3).
 *
 * Integer cents in, integer cents out, and basis points in between — never a percentage as a
 * float. `amount * 0.05` is a number that has been through binary fractions on its way to
 * somebody's bank account, and the first time it disagrees with a seller's own arithmetic by
 * one cent is the first time somebody stops trusting the figures.
 */

/** One percent, in basis points. Here so the unit is impossible to misread at a call site. */
export const BPS_PER_PERCENT = 100;

export class FeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeError';
  }
}

/**
 * Our `application_fee_amount` for a sale.
 *
 * Rounded to the nearest cent, **ties away from zero** — which rounds a half-cent in our
 * favour. That is a choice rather than an accident, and it is the smallest one available: the
 * alternative, rounding toward the seller, costs a cent on half of all ties and would need its
 * own justification too. Stated here so nobody has to reverse-engineer it from a total.
 *
 * The fee can never exceed the amount, and a zero fee is legitimate — a waiver for early
 * sellers is on the roadmap (FR-5.3) and is expressed by passing zero, not by special cases.
 */
export function applicationFeeCents(amountCents: number, feeBps: number): number {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new FeeError('an amount must be a whole number of cents, and not negative');
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new FeeError('a fee must be 0 to 10000 basis points');
  }
  // Multiply before dividing: doing it the other way rounds the rate first and loses the
  // pennies the rate was supposed to describe.
  const fee = Math.round((amountCents * feeBps) / 10_000);
  // Belt and braces with the database CHECK. A fee larger than the sale is not a rounding
  // question, it is a sign error, and it takes money from a seller.
  return Math.min(fee, amountCents);
}

/** What reaches the seller, once we have taken ours. Tax is Stripe's and is not in here. */
export function sellerProceedsCents(amountCents: number, feeBps: number): number {
  return amountCents - applicationFeeCents(amountCents, feeBps);
}
