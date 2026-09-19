import { and, asc, eq, gt, ilike, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { cardVariants, cards, games, sealedProducts, sets } from '../schema/catalog.js';

/** Hard ceiling so a caller can never ask for an unbounded page (SR-X.29). */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when the list is exhausted. */
  nextCursor: string | null;
}

function clampLimit(limit = DEFAULT_PAGE_SIZE): number {
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(limit), MAX_PAGE_SIZE);
}

function paginate<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

export async function listGames(db: Database) {
  return db.select().from(games).orderBy(asc(games.name));
}

export async function listSets(
  db: Database,
  opts: ListOptions = {},
): Promise<Page<typeof sets.$inferSelect>> {
  const limit = clampLimit(opts.limit);
  const filters = [
    opts.gameSlug
      ? eq(
          sets.gameId,
          db.select({ id: games.id }).from(games).where(eq(games.slug, opts.gameSlug)).limit(1),
        )
      : undefined,
    opts.cursor ? gt(sets.id, opts.cursor) : undefined,
  ].filter((f) => f !== undefined);

  const rows = await db
    .select()
    .from(sets)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(sets.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

export interface CardSearchOptions {
  /** Free-text query matched against card name and number (trigram index). */
  q?: string | undefined;
  setId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListOptions {
  gameSlug?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export async function searchCards(
  db: Database,
  opts: CardSearchOptions = {},
): Promise<Page<typeof cards.$inferSelect>> {
  const limit = clampLimit(opts.limit);
  const term = opts.q?.trim();
  const filters = [
    term ? or(ilike(cards.name, `%${term}%`), ilike(cards.number, `%${term}%`)) : undefined,
    opts.setId ? eq(cards.setId, opts.setId) : undefined,
    opts.cursor ? gt(cards.id, opts.cursor) : undefined,
  ].filter((f) => f !== undefined);

  const rows = await db
    .select()
    .from(cards)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(cards.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

export async function getCardById(db: Database, id: string) {
  const [card] = await db.select().from(cards).where(eq(cards.id, id)).limit(1);
  if (!card) return null;
  const variants = await db
    .select()
    .from(cardVariants)
    .where(eq(cardVariants.cardId, id))
    .orderBy(asc(cardVariants.finish), asc(cardVariants.language));
  return { ...card, variants };
}

export async function listSealedProducts(
  db: Database,
  opts: ListOptions = {},
): Promise<Page<typeof sealedProducts.$inferSelect>> {
  const limit = clampLimit(opts.limit);
  const filters = [
    opts.gameSlug
      ? eq(
          sealedProducts.gameId,
          db.select({ id: games.id }).from(games).where(eq(games.slug, opts.gameSlug)).limit(1),
        )
      : undefined,
    opts.cursor ? gt(sealedProducts.id, opts.cursor) : undefined,
  ].filter((f) => f !== undefined);

  const rows = await db
    .select()
    .from(sealedProducts)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(sealedProducts.id))
    .limit(limit + 1);
  return paginate(rows, limit);
}

/** Lightweight liveness probe for /readyz (FR-0.6). */
export async function pingDatabase(db: Database): Promise<boolean> {
  const result = await db.execute(sql`select 1 as ok`);
  return result.length > 0;
}
