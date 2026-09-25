'use client';

import { useState } from 'react';

/**
 * The one button that spends money (FR-5.3).
 *
 * It does not take a price, an amount or a seller — only a listing id. Everything about what
 * is being paid and to whom is read from the listing server-side, and `POST /v1/listings/:id/buy`
 * rejects a body claiming otherwise rather than ignoring it. So there is nothing here for a
 * tampered page to lie about: the worst a modified button can do is buy a different listing,
 * at that listing's real price.
 *
 * What comes back is a Stripe Checkout URL. The card is entered on Stripe's own page, which is
 * what keeps this project at PCI SAQ-A — no card number has ever been in this process.
 */
function messageFor(error: string | undefined, status: number): string {
  switch (error) {
    case 'listing_unavailable':
      return 'That one has just gone. Reload to see what is still for sale.';
    case 'listing_taken':
      return 'Somebody is already part-way through buying that one.';
    case 'own_listing':
      return 'That is your own listing.';
    case 'seller_unavailable':
      return 'That seller cannot take payments at the moment.';
    case 'checkout_unavailable':
      return 'Buying is paused for a moment. Try again shortly.';
    case 'not_found':
      return 'That listing is no longer there.';
    case 'purchase_velocity':
    case 'new_account_cap':
      return 'That is more buying than a new account can do in one go. Try again later.';
    case 'unauthenticated':
      return 'Sign in to buy.';
    default:
      return status === 429
        ? 'That has been tried several times already. Try again shortly.'
        : 'That did not work. You have not been charged.';
  }
}

export function BuyButton({
  listingId,
  signedIn,
  next,
}: {
  listingId: string;
  signedIn: boolean;
  /** Where to come back to after signing in. Built by the page, never from a query string. */
  next: string;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <a
        href={`/sign-in?next=${encodeURIComponent(next)}`}
        className="rounded px-3 py-1 text-xs font-medium bg-accent"
        data-testid={`buy-${listingId}`}
      >
        Sign in to buy
      </a>
    );
  }

  async function buy(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(`/v1/listings/${listingId}/buy`, { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setProblem(
          messageFor(typeof body?.error === 'string' ? body.error : undefined, response.status),
        );
        return;
      }
      const { checkoutUrl } = (await response.json()) as { checkoutUrl: string };
      // Stripe's hosted page. The URL is theirs, handed to us by our own API.
      window.location.href = checkoutUrl;
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void buy()}
        className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50 bg-accent"
        data-testid={`buy-${listingId}`}
      >
        {busy ? 'Just a moment…' : 'Buy'}
      </button>
      {problem !== null && (
        <span role="alert" className="text-xs text-danger" data-testid={`buy-problem-${listingId}`}>
          {problem}
        </span>
      )}
    </span>
  );
}
