import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { retailerProducts, retailers, sealedProducts } from '../schema/catalog.js';

/** Ceiling on auto-registered listings per product per retailer, so a buggy or hostile
 * scanner cannot fill the table with junk URLs. */
export const MAX_LISTINGS_PER_PRODUCT_RETAILER = 20;

export type ResolveFailure =
  | 'unknown_product'
  | 'unknown_retailer'
  | 'retailer_not_enabled'
  | 'url_host_mismatch'
  | 'listing_limit_reached';

export type ResolveResult =
  { ok: true; retailerProductId: string; created: boolean } | { ok: false; reason: ResolveFailure };

/** True when `host` is the retailer's domain or a subdomain of it (not a lookalike). */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Turn a scanner report of "this product, at this shop, at this URL" into a listing id,
 * creating the listing on first sight (ADR-013 data contract).
 *
 * Every guard here exists because the caller is a machine credential, not a person:
 *  - the product must already exist in our catalog (no inventing products)
 *  - the retailer must exist *and be enabled*, which the database only permits once a
 *    ToS/robots review is recorded
 *  - the URL must be https and its host must belong to that retailer, so a report cannot
 *    point a listing at an arbitrary site
 *  - the number of listings per product/retailer is capped
 */
export async function resolveListing(
  db: Database,
  input: { productSlug: string; retailerDomain: string; url: string },
): Promise<ResolveResult> {
  const [product] = await db
    .select({ id: sealedProducts.id })
    .from(sealedProducts)
    .where(eq(sealedProducts.slug, input.productSlug))
    .limit(1);
  if (!product) return { ok: false, reason: 'unknown_product' };

  const [retailer] = await db
    .select({ id: retailers.id, domain: retailers.domain, enabled: retailers.enabled })
    .from(retailers)
    .where(eq(retailers.domain, input.retailerDomain))
    .limit(1);
  if (!retailer) return { ok: false, reason: 'unknown_retailer' };
  if (!retailer.enabled) return { ok: false, reason: 'retailer_not_enabled' };

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, reason: 'url_host_mismatch' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'url_host_mismatch' };
  if (!hostMatchesDomain(parsed.hostname, retailer.domain)) {
    return { ok: false, reason: 'url_host_mismatch' };
  }

  const [existing] = await db
    .select({ id: retailerProducts.id })
    .from(retailerProducts)
    .where(and(eq(retailerProducts.retailerId, retailer.id), eq(retailerProducts.url, input.url)))
    .limit(1);
  if (existing) return { ok: true, retailerProductId: existing.id, created: false };

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(retailerProducts)
    .where(
      and(
        eq(retailerProducts.retailerId, retailer.id),
        eq(retailerProducts.sealedProductId, product.id),
      ),
    );
  if (count >= MAX_LISTINGS_PER_PRODUCT_RETAILER) {
    return { ok: false, reason: 'listing_limit_reached' };
  }

  const [created] = await db
    .insert(retailerProducts)
    .values({ retailerId: retailer.id, sealedProductId: product.id, url: input.url })
    .onConflictDoNothing()
    .returning({ id: retailerProducts.id });

  if (created) return { ok: true, retailerProductId: created.id, created: true };

  // Lost a race with a concurrent report: read the row the other transaction created.
  const [raced] = await db
    .select({ id: retailerProducts.id })
    .from(retailerProducts)
    .where(and(eq(retailerProducts.retailerId, retailer.id), eq(retailerProducts.url, input.url)))
    .limit(1);
  return raced
    ? { ok: true, retailerProductId: raced.id, created: false }
    : { ok: false, reason: 'unknown_retailer' };
}
