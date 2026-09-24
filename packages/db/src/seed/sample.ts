import type { Database } from '../client.js';
import { asUser } from '../queries/watches.js';
import { users } from '../schema/auth.js';
import {
  cardVariants,
  cards,
  games,
  retailerProducts,
  retailers,
  sealedProducts,
  sets,
} from '../schema/catalog.js';
import { creatorProfiles, packOdds } from '../schema/profiles.js';

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
      slug: 'sample-set-one-booster-box',
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

  /**
   * Invented pack odds for the invented product (FR-4.3).
   *
   * Real published odds for a real set are the publisher's data and arrive with the catalog
   * import, under the same IP review as everything else (plan §23, open item O2). These
   * exist so the breaker profile's comparison is visible locally, and the `.invalid` source
   * says plainly that nobody published them — which is also why `source_url` is NOT NULL: an
   * odds row that cannot be cited announces itself.
   */
  await db.insert(packOdds).values([
    {
      sealedProductId: product.id,
      rarity: 'SR',
      numerator: 1,
      denominator: 12,
      sourceUrl: 'https://sample-publisher.invalid/sample-set-one/odds',
    },
    {
      sealedProductId: product.id,
      rarity: 'R',
      numerator: 1,
      denominator: 4,
      sourceUrl: 'https://sample-publisher.invalid/sample-set-one/odds',
    },
  ]);

  /**
   * Somebody for those odds to be compared against.
   *
   * The odds above were seeded "so the breaker profile's comparison is visible locally" and
   * there was no profile, so `/v1/breakers` answered with an empty list and
   * `/v1/breakers/{handle}` answered 404 to everything. Both endpoints shipped, are published
   * in the OpenAPI document, and had never been exercised against a row that exists — the
   * nightly fuzzer said so every night: "1 operation repeatedly returned 404 Not Found,
   * preventing tests from reaching your API's core logic".
   *
   * The page is nearly empty until a creator logs some pulls, which is a thing a person does
   * rather than a thing a seed should forge: `break_pulls` is hash-chained (SR-4.1) and rows
   * invented outside the code that maintains the chain would be exactly the tampering that
   * table exists to detect.
   */
  const [creator] = await db
    .insert(users)
    .values({
      id: 'sample-breaker',
      name: 'Sample Breaker',
      email: 'breaker@sample.invalid',
      role: 'creator',
      displayName: 'Sample Breaker',
    })
    .onConflictDoNothing()
    .returning();

  if (creator) {
    // `creator_profiles` has FORCE'd row-level security, which applies to the table's owner
    // too: a connection that has not said who it is inserts nothing and is told why only if
    // it looks. Declaring the user is what every other writer of this table does.
    await asUser(db, creator.id, (tx) =>
      tx.insert(creatorProfiles).values({
        userId: creator.id,
        handle: 'sample-breaker',
        displayName: 'Sample Breaker',
        bio: 'A placeholder profile so the public breaker pages have something to show.',
        published: true,
      }),
    );
  }
}
