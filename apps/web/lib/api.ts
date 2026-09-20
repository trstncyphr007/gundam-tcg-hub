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

/** Fetch public catalog data during server rendering. Never forwards the user's cookies. */
async function getPublic<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${INTERNAL_API}${path}`, {
      headers: { accept: 'application/json' },
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
      headers: { accept: 'application/json', cookie },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
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
};
