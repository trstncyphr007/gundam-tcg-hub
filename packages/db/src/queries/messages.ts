import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { retailerProducts, retailers, sealedProducts } from '../schema/catalog.js';

export interface RestockContext {
  productName: string;
  retailerName: string;
  url: string;
}

/** Everything an alert needs about a listing, in one query. */
export async function getRestockContext(
  db: Database,
  retailerProductId: string,
): Promise<RestockContext | null> {
  const [row] = await db
    .select({
      productName: sealedProducts.name,
      retailerName: retailers.name,
      url: retailerProducts.url,
    })
    .from(retailerProducts)
    .innerJoin(retailers, eq(retailers.id, retailerProducts.retailerId))
    .innerJoin(sealedProducts, eq(sealedProducts.id, retailerProducts.sealedProductId))
    .where(eq(retailerProducts.id, retailerProductId))
    .limit(1);
  return row ?? null;
}
