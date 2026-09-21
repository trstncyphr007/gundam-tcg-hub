import { headers } from 'next/headers';

/**
 * Server-side calls go straight to the API container; browser calls go through the
 * same-origin proxy (see next.config.ts), so cookies are never sent cross-site.
 */
const INTERNAL_API = process.env['API_INTERNAL_URL'] ?? 'http://127.0.0.1:4000';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SealedProduct {
  id: string;
  name: string;
  kind: string;
  msrpCents: number | null;
}

export interface Card {
  id: string;
  name: string;
  number: string;
  rarity: string | null;
  cardType: string | null;
}

/**
 * Say who the request is really for.
 *
 * A server-rendered page calls the API from the web container, so without this every visitor
 * shares one address and one rate-limit bucket: a single busy user exhausts 120 requests a
 * minute for everybody, and the API starts refusing pages for people who did nothing wrong.
 * Worse, a 429 is indistinguishable from "not signed in" by the time it reaches a page, so
 * the site would tell signed-in users to sign in.
 *
 * The header is the one Caddy set from the real peer (plan §15.3), and the API only honours
 * it when `API_TRUST_PROXY` is on, which is only true behind that proxy. Browser calls
 * through the `/v1` rewrite already carry it, so this makes the two paths agree rather than
 * trusting anything new.
 */
async function forwardedFor(): Promise<Record<string, string>> {
  const value = (await headers()).get('x-forwarded-for');
  return value === null ? {} : { 'x-forwarded-for': value };
}

/** Fetch public catalog data during server rendering. Never forwards the user's cookies. */
async function getPublic<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${INTERNAL_API}${path}`, {
      headers: { accept: 'application/json', ...(await forwardedFor()) },
      next: { revalidate: 60 },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Authenticated server-side call: forwards only the session cookie, nothing else. */
async function getAuthed<T>(path: string): Promise<T | null> {
  const cookie = (await headers()).get('cookie');
  if (!cookie) return null;
  try {
    const response = await fetch(`${INTERNAL_API}${path}`, {
      headers: { accept: 'application/json', cookie, ...(await forwardedFor()) },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export interface BreakSummary {
  id: string;
  title: string;
  status: 'draft' | 'live' | 'ended';
  costCents: number | null;
  /** The denominator for every hit-rate comparison on the creator's profile (FR-4.3). */
  packsOpened: number | null;
  /** Where the break can be watched. Pulls carry offsets into it (FR-4.4). */
  vodUrl: string | null;
  overlayTokenVersion: number;
  createdAt: string;
}

export interface LiveSale {
  id: string;
  cardVariantId: string | null;
  label: string;
  condition: string;
  priceCents: number;
  currency: string;
  soldAt: string;
  streamRef: string | null;
  /** Only ever present for the seller who typed it, and only for 90 days (SR-4.5). */
  buyerHandle: string | null;
  published: boolean;
  flagged: boolean;
}

export interface PendingReport {
  id: string;
  cardVariantId: string;
  cardName: string | null;
  condition: string;
  priceCents: number;
  currency: string;
  saleType: string;
  observedAt: string;
  reportedAt: string;
  evidenceRef: string | null;
  medianCents: number | null;
  /** How many this reporter has waiting. Who they are is deliberately not here. */
  reporterPending: number;
}

export interface HeldObservation {
  id: string;
  cardVariantId: string;
  cardName: string | null;
  source: string;
  condition: string;
  priceCents: number;
  currency: string;
  observedAt: string;
  flaggedAt: string;
  medianCents: number | null;
  evidenceRef: string | null;
}

/**
 * The answers the console can get, kept distinct because each needs a different page: a
 * sign-in link, a flat refusal, a "sign in again" prompt, or the queue itself.
 */
export type AdminQueueResult =
  | { kind: 'ok'; reports: PendingReport[]; flagged: HeldObservation[] }
  | { kind: 'signed_out' }
  | { kind: 'forbidden' }
  | { kind: 'step_up' }
  | { kind: 'unavailable' };

export interface CreatorProfile {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  published: boolean;
}

export interface BreakerSummary {
  handle: string;
  displayName: string;
  bio: string | null;
}

export type OddsVerdict =
  'unpublished' | 'insufficient' | 'not_comparable' | 'consistent' | 'above' | 'below';

export interface RarityComparison {
  rarity: string;
  hits: number;
  packs: number;
  observedRate: number | null;
  published: { numerator: number; denominator: number } | null;
  publishedRate: number | null;
  lowRate: number | null;
  highRate: number | null;
  verdict: OddsVerdict;
}

export interface BreakerProfile extends BreakerSummary {
  totals: {
    breaks: number;
    endedBreaks: number;
    pulls: number;
    totalValueCents: number;
    packsOpened: number;
    breaksWithoutPackCount: number;
  };
  fairness: {
    committed: number;
    revealed: number;
    endedBreaks: number;
    chainsChecked: number;
    chainsValid: number;
    chainsBroken: number;
    chainsUnverifiable: number;
    badge: 'verified' | 'none' | 'broken';
  };
  rarityCounts: { rarity: string; pulls: number }[];
  oddsReports: {
    sealedProductId: string;
    productName: string;
    breaks: number;
    packs: number;
    unidentifiedPulls: number;
    rarities: RarityComparison[];
    sources: { rarity: string; sourceUrl: string; publishedAt: string | null }[];
  }[];
  recentBreaks: {
    id: string;
    title: string;
    productName: string | null;
    status: 'draft' | 'live' | 'ended';
    packsOpened: number | null;
    pulls: number;
    totalCents: number;
    endedAt: string | null;
  }[];
}

export interface PublicPull {
  seq: number;
  label: string;
  valueCentsAtPull: number;
  pulledAt: string;
  /**
   * A deep link to the moment (FR-4.4), already carrying the offset. Outside the hash
   * chain — the pull is proven, the timestamp is the creator saying where to look.
   */
  vodUrl: string | null;
  vodOffsetSeconds: number | null;
}

export interface CreatorPull {
  id: string;
  seq: number;
  label: string;
  valueCentsAtPull: number;
  pulledAt: string;
  offsetSeconds: number | null;
  vodUrl: string | null;
}

export interface PublicBreak {
  id: string;
  title: string;
  status: 'draft' | 'live' | 'ended';
  costCents: number | null;
  productName: string | null;
  pulls: PublicPull[];
  totalCents: number;
  /**
   * The evidence, not the verdict. `chain` is the server's own reading; `rows` is what it
   * read, so a browser can reach its own conclusion and disagree out loud.
   */
  verification: {
    rows: {
      seq: number;
      cardVariantId: string | null;
      label: string | null;
      valueCentsAtPull: number;
      valueSource: string;
      pulledAt: string;
      prevHash: string | null;
      rowHash: string | null;
    }[];
    commitment: {
      commitment: string;
      clientSeed: string | null;
      revealedSeed: string | null;
      slotCount: number;
      algorithmVersion: string;
      committedAt: string;
      revealedAt: string | null;
    } | null;
    chain: {
      state: 'valid' | 'invalid' | 'unverifiable' | 'empty';
      brokenAtSeq: number | null;
      head: string | null;
    };
  };
}

export type CollectionVisibility = 'private' | 'unlisted' | 'public';

export interface CollectionSummary {
  id: string;
  name: string;
  visibility: CollectionVisibility;
  updatedAt: string;
}

export interface CollectionItem {
  id: string;
  cardVariantId: string;
  setCode: string;
  cardNumber: string;
  cardName: string;
  finish: string;
  language: string;
  condition: string;
  quantity: number;
  acquiredPriceCents: number | null;
  currency: string;
  acquiredAt: string | null;
  notes: string | null;
}

export interface CollectionDetail extends CollectionSummary {
  /** Present only when the viewer is the owner — a shared collection names nobody. */
  ownerId?: string;
  items: CollectionItem[];
}

/**
 * Mirrors the API's valuation exactly, including the fields that exist to stop the headline
 * number lying: what could not be valued, and what the gain was actually computed over
 * (ADR-019).
 */
export interface CollectionValuation {
  currency: string;
  lines: number;
  cards: number;
  valuedCards: number;
  currentValueCents: number;
  costBasisCents: number;
  comparableValueCents: number;
  gainLossCents: number;
  unpricedLines: number;
  unpricedCards: number;
  otherCurrencyLines: number;
  oldestPriceDay: string | null;
}

export interface PricePoint {
  cardVariantId: string;
  finish: string;
  language: string;
  condition: string;
  day: string;
  medianCents: number;
  p25Cents: number;
  p75Cents: number;
  lowCents: number;
  highCents: number;
  observationCount: number;
  currency: string;
}

export interface CardPrices {
  cardId: string;
  /** Empty means "not enough evidence to publish", never a price of zero. */
  points: PricePoint[];
  sources: { source: string; observations: number }[];
}

/**
 * A key as its owner sees it. There is no secret here and never will be: the server hands
 * the plaintext back exactly once, at creation, and stores only a keyed hash of it.
 */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  tier: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const api = {
  cards: (query: string) =>
    getPublic<Page<Card>>(`/v1/cards?limit=24${query ? `&q=${encodeURIComponent(query)}` : ''}`),
  card: (id: string) =>
    getPublic<Card & { variants: { finish: string; language: string }[] }>(`/v1/cards/${id}`),
  products: () => getPublic<Page<SealedProduct>>('/v1/products?game=gundam&limit=50'),
  me: () =>
    getAuthed<{ id: string; email: string; displayName: string | null; role: string }>('/v1/me'),
  watches: () =>
    getAuthed<{
      items: { id: string; sealedProductId: string | null; channels: string[] }[];
      limit: number;
    }>('/v1/watches'),
  breaks: () => getAuthed<{ items: BreakSummary[] }>('/v1/breaks'),
  /** The creator's own pull list, with ids. The public view deliberately has none. */
  creatorPulls: (breakId: string) =>
    getAuthed<{ items: CreatorPull[] }>(`/v1/breaks/${breakId}/pulls`),
  collections: () => getAuthed<{ items: CollectionSummary[]; limit: number }>('/v1/collections'),
  /**
   * Viewer-aware: forwards the session cookie when there is one, and works without it for a
   * public or unlisted collection. Which rows that admits is decided by row-level security,
   * not by a branch here.
   */
  collection: async (id: string): Promise<CollectionDetail | null> => {
    const cookie = (await headers()).get('cookie');
    try {
      const response = await fetch(`${INTERNAL_API}/v1/collections/${id}`, {
        headers: {
          accept: 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(await forwardedFor()),
        },
        cache: 'no-store',
      });
      if (!response.ok) return null;
      return (await response.json()) as CollectionDetail;
    } catch {
      return null;
    }
  },
  collectionValue: async (id: string): Promise<CollectionValuation | null> => {
    const cookie = (await headers()).get('cookie');
    try {
      const response = await fetch(`${INTERNAL_API}/v1/collections/${id}/value`, {
        headers: {
          accept: 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(await forwardedFor()),
        },
        cache: 'no-store',
      });
      if (!response.ok) return null;
      return (await response.json()) as CollectionValuation;
    } catch {
      return null;
    }
  },
  /**
   * Price history for a card, with the mix of sources it was computed from.
   *
   * Cached briefly rather than for the catalog's five minutes: a stale price is wrong in a
   * way a stale card name is not.
   */
  cardPrices: (id: string, options: { days?: number; condition?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.days !== undefined) query.set('days', String(options.days));
    if (options.condition !== undefined) query.set('condition', options.condition);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return getPublic<CardPrices>(`/v1/cards/${id}/prices${suffix}`);
  },
  developerKeys: () =>
    getAuthed<{ items: ApiKeySummary[]; limit: number; scopes: string[] }>('/v1/developer/keys'),
  /**
   * Not cached, unlike the rest of the public catalog.
   *
   * This list is where "public" becomes visible, so someone who has just flipped the switch
   * goes straight here to check. A minute of correct-but-stale absence reads as "the control
   * did not work", and a sharing control people do not trust is worse than a slower page.
   */
  publicCollections: async (): Promise<{ items: CollectionSummary[] } | null> => {
    try {
      const response = await fetch(`${INTERNAL_API}/v1/collections/public`, {
        headers: { accept: 'application/json', ...(await forwardedFor()) },
        cache: 'no-store',
      });
      if (!response.ok) return null;
      return (await response.json()) as { items: CollectionSummary[] };
    } catch {
      return null;
    }
  },
  myProfile: () => getAuthed<{ profile: CreatorProfile | null }>('/v1/me/profile'),
  /**
   * The moderation queue, with the reason for any refusal preserved.
   *
   * Not built on `getAuthed`, which collapses every failure to null — here the difference
   * between "not an admin" and "sign in again" is the whole user experience.
   */
  adminQueue: async (): Promise<AdminQueueResult> => {
    const cookie = (await headers()).get('cookie');
    if (!cookie) return { kind: 'signed_out' };
    try {
      const response = await fetch(`${INTERNAL_API}/v1/admin/moderation`, {
        headers: { accept: 'application/json', cookie, ...(await forwardedFor()) },
        cache: 'no-store',
      });
      if (response.status === 401) return { kind: 'signed_out' };
      if (response.status === 403) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        return body?.error === 'step_up_required' ? { kind: 'step_up' } : { kind: 'forbidden' };
      }
      if (!response.ok) return { kind: 'unavailable' };
      const queue = (await response.json()) as {
        reports: PendingReport[];
        flagged: HeldObservation[];
      };
      return { kind: 'ok', ...queue };
    } catch {
      return { kind: 'unavailable' };
    }
  },
  /** The seller's own log. Carries buyer handles, so it is never cached anywhere. */
  liveSales: () => getAuthed<{ items: LiveSale[] }>('/v1/live-sales'),
  breakers: () => getPublic<{ items: BreakerSummary[] }>('/v1/breakers'),
  /**
   * Not cached. The page carries a fairness verdict about a named person, and a cached
   * "verified" surviving a chain that has just been found broken is the single worst thing
   * this page could do.
   */
  breaker: async (handle: string): Promise<BreakerProfile | null> => {
    try {
      const response = await fetch(`${INTERNAL_API}/v1/breakers/${encodeURIComponent(handle)}`, {
        headers: { accept: 'application/json', ...(await forwardedFor()) },
        cache: 'no-store',
      });
      if (!response.ok) return null;
      return (await response.json()) as BreakerProfile;
    } catch {
      return null;
    }
  },
  // A break page must never serve a stale total, so it opts out of the 60s cache.
  publicBreak: async (id: string): Promise<PublicBreak | null> => {
    try {
      const response = await fetch(`${INTERNAL_API}/v1/breaks/${id}/public`, {
        headers: { accept: 'application/json', ...(await forwardedFor()) },
        cache: 'no-store',
      });
      if (!response.ok) return null;
      return (await response.json()) as PublicBreak;
    } catch {
      return null;
    }
  },
};
