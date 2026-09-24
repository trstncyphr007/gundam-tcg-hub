/**
 * Money lives as integer cents everywhere behind this, and only becomes a string here.
 *
 * One function, shared, because two places formatting money slightly differently is how a
 * total stops matching the rows it is a total of.
 */
export function dollars(cents: number, currency = 'USD'): string {
  // Integer cents is the contract, and rounding here is the cheap insurance rather than the
  // real defence: without it a fractional value formats as "$0.12.5", because the remainder
  // is pasted on as text. A wrong-by-half-a-cent figure beats an unreadable one.
  const whole = Math.round(cents);
  const sign = whole < 0 ? '-' : '';
  const abs = Math.abs(whole);
  const amount = `${String(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
  return currency === 'USD' ? `${sign}$${amount}` : `${sign}${amount} ${currency}`;
}

/**
 * Subtotals, one per currency, in the order the currencies first appear.
 *
 * Because adding money in different currencies produces a number that is not money. The
 * live-sale logger summed `priceCents` across every row and printed the result with a dollar
 * sign, so a seller who logged one sale in CAD and one in USD was shown a total that was
 * neither — on the page whose only job is recording what things sold for.
 *
 * `live_sales.currency` is a real column with a CHECK that it is an ISO code (migration 0023),
 * so this is a supported case rather than a hypothetical one.
 */
export function totalsByCurrency(
  items: readonly { priceCents: number; currency: string }[],
): { currency: string; cents: number }[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.priceCents);
  }
  return [...totals].map(([currency, cents]) => ({ currency, cents }));
}

/** Signed, for a gain or loss where the sign is the point. */
export function signedDollars(cents: number, currency = 'USD'): string {
  return cents > 0 ? `+${dollars(cents, currency)}` : dollars(cents, currency);
}

/**
 * Read a typed amount into cents without a float ever holding it.
 *
 * Returns null on anything it cannot read, so the caller can say which field was wrong
 * rather than quietly storing a zero. `Math.round(Number('12.50') * 100)` is the usual
 * shortcut and it is wrong: `12.50 * 100` is `1250.0000000000002`.
 */
export function centsFromInput(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/u, '').replaceAll(',', '');
  if (cleaned === '') return null;
  const parts = cleaned.split('.');
  if (parts.length > 2) return null;
  const [whole = '', fraction] = parts;
  if (!/^\d{1,9}$/u.test(whole)) return null;
  if (fraction !== undefined && !/^\d{1,2}$/u.test(fraction)) return null;
  return Number.parseInt(whole, 10) * 100 + Number.parseInt((fraction ?? '').padEnd(2, '0'), 10);
}
