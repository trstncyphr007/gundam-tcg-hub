import type { Database } from '../client.js';
import {
  cardVariants,
  cards,
  games,
  retailerProducts,
  retailers,
  sealedProducts,
  sets,
} from '../schema/catalog.js';

/**
 * Minimal SAMPLE catalog for local development and tests.
 *
 * This is NOT the real Gundam Card Game catalog: names/numbers are placeholders so nothing
 * depends on publisher data before the IP review (plan §23, open item O2). The real catalog
 * arrives via the import CLI once a lawful data source is agreed.
 */
export async function seedSample(db: Database): Promise<void> {
  const [game] = await db
    .insert(games)
    .values({ slug: 'gundam', name: 'Gundam Card Game' })
    .onConflictDoNothing()
    .returning();
  if (!game) return; // already seeded

  const [set] = await db
    .insert(sets)
    .values({
      gameId: game.id,
      code: 'SAMPLE-01',
      name: 'Sample Set One',
      releaseDate: '2026-01-01',
    })
    .returning();
  if (!set) throw new Error('seed: set insert failed');

  const inserted = await db
    .insert(cards)
    .values([
      { setId: set.id, number: '001', name: 'Sample Unit Alpha', cardType: 'unit', rarity: 'C' },
      { setId: set.id, number: '002', name: 'Sample Unit Beta', cardType: 'unit', rarity: 'R' },
      { setId: set.id, number: '003', name: 'Sample Pilot Gamma', cardType: 'pilot', rarity: 'SR' },
    ])
    .returning();

  await db.insert(cardVariants).values(
    inserted.flatMap((card) => [
      { cardId: card.id, finish: 'normal' as const, language: 'en' as const },
      { cardId: card.id, finish: 'parallel' as const, language: 'en' as const },
    ]),
  );

  const [product] = await db
    .insert(sealedProducts)
    .values({
      gameId: game.id,
      setId: set.id,
      kind: 'booster_box',
      name: 'Sample Set One Booster Box',
      msrpCents: 9999,
    })
    .returning();
  if (!product) throw new Error('seed: sealed product insert failed');

  // Disabled until a ToS/robots review is recorded - the DB check constraint enforces this.
  const [retailer] = await db
    .insert(retailers)
    .values({
      name: 'Sample Retailer',
      domain: 'sample-retailer.invalid',
      adapterKey: 'mock',
      enabled: false,
      robotsOk: false,
      minIntervalS: 900,
    })
    .returning();
  if (!retailer) throw new Error('seed: retailer insert failed');

  await db.insert(retailerProducts).values({
    retailerId: retailer.id,
    sealedProductId: product.id,
    url: 'https://sample-retailer.invalid/products/sample-booster-box',
  });
}
