'use client';

// Type-only, and it has to stay that way: `lib/api.ts` imports `next/headers`, so a value
// import of it from a client component pulls a server-only module into the browser bundle and
// the build fails. `import type` is erased before the bundler ever sees it.
import type { Listing, ListingPhoto, SellerStatus } from '@/lib/api';
import { dollars } from '@/lib/money';
import { type SyntheticEvent, useCallback, useState } from 'react';

/**
 * Selling, from the browser (FR-5.1, FR-5.2, SR-5.5).
 *
 * The part worth reading is `uploadPhoto`. The file does **not** pass through this site or the
 * API: we ask for a signed URL, the browser PUTs straight to the bucket, and then we ask the
 * API to process what landed. Ten megabytes per photo through our own servers would be a
 * buffer to size and a denial-of-service surface to defend, and it would buy nothing — the
 * bytes are not trusted on arrival either way.
 *
 * That second step is a request to another origin, which the CSP refuses by default. The
 * bucket is named in `connect-src` and `img-src` from configuration (see `lib/csp.ts`); if it
 * is ever missing, uploads fail in the browser rather than anywhere a log would notice.
 */

const CONDITIONS = [
  { value: 'nm', label: 'Near mint' },
  { value: 'lp', label: 'Lightly played' },
  { value: 'mp', label: 'Moderately played' },
  { value: 'hp', label: 'Heavily played' },
  { value: 'dmg', label: 'Damaged' },
] as const;

/**
 * What a refusal means, in a sentence.
 *
 * The API already writes a human message for the refusals it treats as expected — the photo
 * requirement, the velocity limit — and that message is better than anything repeated here,
 * because it is written next to the rule. This is the fallback for the codes that arrive bare,
 * and the last resort for the ones nobody anticipated. A seller told "that did not work"
 * sends an email; a seller told "photos are required above $25" adds a photo.
 */
function messageFor(error: string | undefined, status: number): string {
  switch (error) {
    case 'photo_limit':
      return 'That listing already has as many photos as it can hold.';
    case 'already_processed':
      return 'That photo has already been checked.';
    case 'not_found':
      return 'That listing is no longer there.';
    case 'processing_unavailable':
      return 'Photos cannot be checked right now. The upload is saved and will be picked up shortly.';
    case 'trailing_data':
      return 'That file has something appended after the image. Re-save it and try again.';
    case 'not_an_image':
    case 'unsupported_type':
      return 'That file is not a JPEG or a PNG.';
    case 'too_large':
      return 'That file is larger than the upload limit.';
    case 'too_small':
      return 'That image is too small to show the card.';
    case 'dimensions_too_large':
    case 'too_many_pixels':
      return 'That image is too large. An ordinary camera photo is the right size.';
    case 'unauthenticated':
      return 'You have been signed out. Sign in again to carry on.';
    case 'invalid_request':
      return 'Something in that form was not accepted. Check the card variant id and the price.';
    default:
      if (error?.startsWith('malware') === true) {
        return 'That file was refused by the virus scanner.';
      }
      return status === 429
        ? 'That has been done several times already. Try again shortly.'
        : 'That did not work. Nothing was changed.';
  }
}

/**
 * The API's own sentence when it wrote one, ours otherwise.
 *
 * `reason` is the photo pipeline's verdict code, which arrives on a 422 with no message.
 */
/**
 * One form field, as a string.
 *
 * `FormData.get` returns a `File` as readily as a string — an `<input type="file">` in the
 * same form would hand one over, and `String(file)` is `[object File]`, which would be sent to
 * the API as a card variant id. Anything that is not text is nothing.
 */
function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

async function problemOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
    reason?: unknown;
  } | null;
  if (typeof body?.message === 'string' && body.message !== '') return body.message;
  let code: string | undefined;
  if (typeof body?.error === 'string') code = body.error;
  else if (typeof body?.reason === 'string') code = body.reason;
  return messageFor(code, response.status);
}

export function SellingManager({
  status,
  initialListings,
}: {
  /** Null when this deployment has no payment provider configured at all. */
  status: SellerStatus | null;
  initialListings: Listing[];
}): React.JSX.Element {
  const [listings, setListings] = useState(initialListings);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<Record<string, ListingPhoto[]>>({});

  const refresh = useCallback(async () => {
    const response = await fetch('/v1/listings', { cache: 'no-store' });
    if (!response.ok) return;
    const body = (await response.json()) as { items: Listing[] };
    setListings(body.items);
  }, []);

  const loadPhotos = useCallback(async (listingId: string) => {
    const response = await fetch(`/v1/listings/${listingId}/photos`, { cache: 'no-store' });
    if (!response.ok) return;
    const body = (await response.json()) as { items: ListingPhoto[] };
    setPhotos((current) => ({ ...current, [listingId]: body.items }));
  }, []);

  async function onboard(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch('/v1/seller/onboard', { method: 'POST' });
      if (!response.ok) {
        setProblem(await problemOf(response));
        return;
      }
      const body = (await response.json()) as { url: string };
      // Stripe's own hosted onboarding. The URL comes from them, through our API, and is
      // short-lived — following it is the whole point of the button.
      window.location.href = body.url;
    } finally {
      setBusy(false);
    }
  }

  async function createListing(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    // Captured before the first await: React clears `currentTarget` once the handler yields,
    // so reading it afterwards to reset the form throws on a successful save.
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch('/v1/listings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cardVariantId: field(form, 'cardVariantId'),
          condition: field(form, 'condition'),
          // Cents, rounded here, so the API is never handed a float to interpret.
          priceCents: Math.round(Number(field(form, 'price')) * 100),
          quantity: Number(field(form, 'quantity')),
        }),
      });
      if (!response.ok) {
        /*
         * On this form specifically, a 404 is about the card rather than the listing: a
         * variant id that names nothing reaches the app's handler as a missing reference. The
         * shared message ("that listing is no longer there") would be nonsense here — there is
         * no listing yet, that is what the button was for.
         */
        setProblem(
          response.status === 404
            ? 'No card printing has that id. Copy it from the card page and try again.'
            : await problemOf(response),
        );
        return;
      }
      element.reset();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, next: 'active' | 'withdrawn' | 'draft'): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(`/v1/listings/${id}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!response.ok) {
        setProblem(await problemOf(response));
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Three steps, and the middle one does not involve this site at all.
   *
   * 1. Ask for a signed URL. The API records a row first, so the upload has somewhere to
   *    belong and the sweeper can find it if this tab closes half way.
   * 2. PUT the file **straight to the bucket**, with exactly the headers the signature covers —
   *    a different content type is refused by the storage server, not by us.
   * 3. Ask the API to process what landed. That is where it is inspected, scanned, re-encoded
   *    and either approved or refused with a reason.
   */
  async function uploadPhoto(listingId: string, file: File): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const started = await fetch(`/v1/listings/${listingId}/photos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentType: file.type, contentLength: file.size }),
      });
      if (!started.ok) {
        /**
         * A 404 here cannot be read as "your listing is gone", and not for want of trying.
         *
         * The API answers an unmatched route with exactly the body it uses for a missing row —
         * `{error: 'not_found'}` — on purpose, so that "no such thing" and "not yours" stay
         * indistinguishable (SR-3.3). The photo routes are registered only where object
         * storage is configured, so both readings are live and the client cannot tell them
         * apart. It should not try: what it can say is the thing that is true either way.
         *
         * The seller is looking at the listing, so "that listing is no longer there" is the
         * one answer that is certainly wrong.
         */
        setProblem(
          started.status === 404
            ? 'Photographs cannot be added to this listing right now.'
            : await problemOf(started),
        );
        return;
      }
      const { photoId, uploadUrl, requiredHeaders } = (await started.json()) as {
        photoId: string;
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
      };

      /**
       * Send only the headers the page is allowed to set, which is `content-type`.
       *
       * `content-length` is in `requiredHeaders` because the signature covers it, and the
       * obvious thing is to pass the lot straight to `fetch`. That does not work, and it fails
       * in a way no server-side test can see: Chromium does not quietly drop a forbidden
       * header, it **lists it in the preflight's `Access-Control-Request-Headers`** — and the
       * bucket's CORS policy allows `content-type` only, so the preflight is refused, the PUT
       * is never sent, and `fetch` rejects with an opaque network error.
       *
       * Widening the policy to admit `content-length` would work and would be the wrong fix:
       * the browser sets it itself, from the body, to the same number the API signed
       * (`file.size`). There is nothing for the page to declare.
       */
      const browserHeaders = Object.fromEntries(
        Object.entries(requiredHeaders).filter(([name]) => name.toLowerCase() === 'content-type'),
      );
      /**
       * Wrapped, because this is the one request that can fail without a response.
       *
       * It is cross-origin, so the browser sends a preflight first and refuses to send the PUT
       * at all if the bucket has no CORS policy naming this site — and `fetch` then *rejects*
       * rather than resolving with a status. Unwrapped, that exception escaped the handler and
       * the page simply stopped: no message, no spinner, nothing to report. The upload had
       * never worked and looked like it was still going.
       */
      let put: Response;
      try {
        put = await fetch(uploadUrl, { method: 'PUT', headers: browserHeaders, body: file });
      } catch {
        setProblem(
          'The browser could not reach the photo storage. This site is not set up to accept uploads yet.',
        );
        return;
      }
      if (!put.ok) {
        setProblem('The upload was refused by the storage service. Try again.');
        return;
      }

      const completed = await fetch(`/v1/listings/${listingId}/photos/${photoId}/complete`, {
        method: 'POST',
      });
      if (!completed.ok) {
        setProblem(await problemOf(completed));
      }
      // Either way: a refused photo is still a row, and seeing why it was refused is most of
      // the reason for showing the gallery at all.
      await loadPhotos(listingId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3" data-testid="seller-status">
        <h2 className="text-lg font-medium">Taking payments</h2>
        {status === null ? (
          /*
           * No payment provider on this deployment. Said here rather than by hiding the page,
           * because everything below still works: a draft, a photograph and a price are all
           * ours to store, and none of them involves Stripe.
           */
          <p className="text-sm text-muted" data-testid="payments-unavailable">
            Taking payments is not set up on this site yet, so nothing can actually be sold. You can
            still prepare listings and add photographs — they will be waiting when it is.
          </p>
        ) : status.chargesEnabled && status.payoutsEnabled ? (
          <p className="text-sm text-muted" data-testid="seller-ready">
            Stripe has cleared this account to take payments and receive payouts. A new
            seller&rsquo;s payouts are held for a few days after delivery on their first orders.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {status.onboarded
                ? 'Stripe is still reviewing this account. Listings can be prepared in the meantime, but nobody can buy from you yet.'
                : 'Before anybody can buy from you, Stripe needs to verify who you are. They collect those details, not us.'}
            </p>
            <button
              type="button"
              onClick={() => void onboard()}
              disabled={busy}
              className="rounded px-3 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
              data-testid="onboard"
            >
              {status.onboarded ? 'Continue with Stripe' : 'Set up payments'}
            </button>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">List a card</h2>
        <form onSubmit={(event) => void createListing(event)} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="block text-muted">Card variant id</span>
            <input
              name="cardVariantId"
              required
              className="mt-1 w-full rounded border px-2 py-1 border-line bg-transparent"
              data-testid="listing-variant"
            />
          </label>
          <label className="text-sm">
            <span className="block text-muted">Condition</span>
            <select
              name="condition"
              defaultValue="nm"
              className="mt-1 w-full rounded border px-2 py-1 border-line bg-transparent"
              data-testid="listing-condition"
            >
              {CONDITIONS.map((condition) => (
                <option key={condition.value} value={condition.value}>
                  {condition.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-muted">Price (USD)</span>
            <input
              name="price"
              type="number"
              min="0.01"
              step="0.01"
              required
              className="mt-1 w-full rounded border px-2 py-1 border-line bg-transparent"
              data-testid="listing-price"
            />
          </label>
          <label className="text-sm">
            <span className="block text-muted">Quantity</span>
            <input
              name="quantity"
              type="number"
              min="1"
              defaultValue="1"
              className="mt-1 w-full rounded border px-2 py-1 border-line bg-transparent"
              data-testid="listing-quantity"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded px-3 py-2 text-sm font-medium disabled:opacity-50 bg-accent sm:col-span-2"
            data-testid="listing-create"
          >
            Save as a draft
          </button>
        </form>
        <p className="text-xs text-muted">
          Saving is not publishing. A draft goes on sale when you say so — and above $25 it needs an
          approved photograph of the actual card first.
        </p>
      </section>

      {problem !== null && (
        <p role="alert" className="text-sm text-danger" data-testid="selling-problem">
          {problem}
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Your listings</h2>
        {listings.length === 0 ? (
          <p className="text-sm text-muted">Nothing listed yet.</p>
        ) : (
          <ul className="space-y-3" data-testid="listing-list">
            {listings.map((listing) => {
              const gallery = photos[listing.id];
              return (
                <li key={listing.id} className="rounded border p-3 border-line">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {dollars(listing.priceCents, listing.currency)}{' '}
                      <span className="text-sm text-muted">
                        · {listing.condition.toUpperCase()} · ×{listing.quantity}
                      </span>
                    </span>
                    <span className="text-sm text-muted" data-testid={`status-${listing.id}`}>
                      {listing.status}
                    </span>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {listing.status === 'draft' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void setStatus(listing.id, 'active')}
                        className="rounded border px-2 py-1 text-xs disabled:opacity-50 border-line"
                        data-testid={`publish-${listing.id}`}
                      >
                        Put on sale
                      </button>
                    )}
                    {listing.status === 'active' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void setStatus(listing.id, 'withdrawn')}
                        className="rounded border px-2 py-1 text-xs disabled:opacity-50 border-line"
                        data-testid={`withdraw-${listing.id}`}
                      >
                        Take off sale
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void loadPhotos(listing.id)}
                      className="rounded border px-2 py-1 text-xs disabled:opacity-50 border-line"
                      data-testid={`photos-${listing.id}`}
                    >
                      Photos
                    </button>
                    <label className="cursor-pointer rounded border px-2 py-1 text-xs border-line">
                      Add a photo
                      <input
                        type="file"
                        accept="image/jpeg,image/png"
                        className="hidden"
                        data-testid={`upload-${listing.id}`}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadPhoto(listing.id, file);
                          // So the same file can be chosen again after a refusal.
                          event.target.value = '';
                        }}
                      />
                    </label>
                  </div>

                  {gallery !== undefined && (
                    <ul
                      className="mt-3 flex flex-wrap gap-3"
                      data-testid={`photo-list-${listing.id}`}
                    >
                      {gallery.length === 0 && (
                        <li className="text-xs text-muted">No photos yet.</li>
                      )}
                      {gallery.map((photo) => (
                        <li key={photo.id} className="text-xs">
                          {photo.url === null ? (
                            <span className="text-muted" data-testid={`photo-${photo.id}`}>
                              {photo.status === 'rejected'
                                ? `refused: ${photo.rejectionReason ?? 'unknown'}`
                                : 'being checked…'}
                            </span>
                          ) : (
                            /*
                             * A plain <img>, and a short-lived signed URL on the bucket's own
                             * origin. Next's optimiser would have to fetch and cache a link
                             * designed to expire, on a server with no business reading private
                             * photographs; `images.unoptimized` is on for the same reason.
                             */
                            <img
                              src={photo.url}
                              alt="Photograph of the card being sold"
                              className="h-24 w-auto rounded border border-line"
                              data-testid={`photo-${photo.id}`}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
