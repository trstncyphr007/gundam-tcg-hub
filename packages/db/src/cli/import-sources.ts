import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from '@gth/core';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../client.js';
import { games, retailers, sealedProducts } from '../schema/catalog.js';

/**
 * Import the reviewed retailers and real products (pnpm db:import-sources).
 *
 * Retailers are only enabled when this file records a completed robots/ToS review, because
 * the database refuses to enable one otherwise (see the retailers check constraint).
 * Re-running is safe: everything is upserted by its natural key.
 */
const fileSchema = z.object({
  game: z.object({ slug: z.string(), name: z.string() }),
  retailers: z.array(
    z.object({
      name: z.string().min(1),
      domain: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/, 'expected a bare domain, no scheme or path'),
      adapterKey: z.string().min(1),
      robotsOk: z.boolean(),
      minIntervalS: z.number().int().min(60),
      note: z.string().optional(),
    }),
  ),
  products: z.array(
    z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/),
      name: z.string().min(1),
      kind: z.enum(['booster_box', 'booster_pack', 'starter_deck', 'case', 'bundle', 'accessory']),
    }),
  ),
});

const { DATABASE_URL_MIGRATOR } = parseEnv(
  z.object({ DATABASE_URL_MIGRATOR: z.string().startsWith('postgres') }),
);

const path = process.argv[2] ?? fileURLToPath(new URL('../seed/sources.json', import.meta.url));
// eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied path, admin CLI
const parsed = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

const { db, close } = createDb({ url: DATABASE_URL_MIGRATOR, max: 1 });
try {
  const [game] = await db
    .insert(games)
    .values({ slug: parsed.game.slug, name: parsed.game.name })
    .onConflictDoUpdate({ target: games.slug, set: { name: parsed.game.name } })
    .returning();
  if (!game) throw new Error('game upsert failed');

  const reviewedAt = new Date();
  for (const r of parsed.retailers) {
    await db
      .insert(retailers)
      .values({
        name: r.name,
        domain: r.domain,
        adapterKey: r.adapterKey,
        robotsOk: r.robotsOk,
        tosReviewedAt: reviewedAt,
        // Only a retailer whose review says robots permits our use is switched on.
        enabled: r.robotsOk,
        minIntervalS: r.minIntervalS,
      })
      .onConflictDoUpdate({
        target: retailers.domain,
        set: {
          name: r.name,
          adapterKey: r.adapterKey,
          robotsOk: r.robotsOk,
          tosReviewedAt: reviewedAt,
          enabled: r.robotsOk,
          minIntervalS: r.minIntervalS,
          updatedAt: reviewedAt,
        },
      });
  }

  for (const p of parsed.products) {
    await db
      .insert(sealedProducts)
      .values({ gameId: game.id, kind: p.kind, name: p.name, slug: p.slug })
      .onConflictDoUpdate({
        target: sealedProducts.slug,
        set: { name: p.name, kind: p.kind, updatedAt: reviewedAt },
      });
  }

  const counts = await db.execute<{ retailers: number; products: number; enabled: number }>(
    sql`select
          (select count(*)::int from app.retailers) as retailers,
          (select count(*)::int from app.retailers where enabled) as enabled,
          (select count(*)::int from app.sealed_products) as products`,
  );
  console.log(
    `imported: ${String(counts[0]?.retailers)} retailers (${String(counts[0]?.enabled)} enabled), ` +
      `${String(counts[0]?.products)} products`,
  );
  console.log('product keys the scanner should use:');
  const rows = await db
    .select({ slug: sealedProducts.slug, name: sealedProducts.name })
    .from(sealedProducts)
    .where(eq(sealedProducts.gameId, game.id));
  for (const row of rows) console.log(`  ${row.slug}  (${row.name})`);
} finally {
  await close();
}
