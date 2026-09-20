# ADR-016: The scanner reports product + shop + URL; the platform resolves the listing

- Status: Accepted (2026-09-20). Extends the ADR-013 data contract.
- Context: The two sides model stock differently.
  - The scanner (`trstncyphr007/gundam-scanner`) searches each shop **by product name** and
    reports whatever page it found. It has no notion of our ids.
  - The platform tracks a specific **listing** (`app.retailer_products`): one product, at one
    retailer, at one URL. Watches, restock events and alert deliveries all hang off that row.

  Making the scanner carry our UUIDs would mean a second source of truth to keep in sync, and a
  registration step before any new shop page could ever be reported.

- Decision: `/v1/ingest/stock` accepts either shape per report:
  - `{ retailerProductId, … }` — a listing we already know, unchanged; or
  - `{ productSlug, retailerDomain, url, … }` — the scanner's own vocabulary.

  For the second shape the platform resolves the listing and **creates it on first sight**.
  `sealed_products` therefore gains a stable human-readable `slug` (migration 0008) which is what
  the scanner is configured with; ids stay internal.

- Guards. The caller is a machine credential, so resolution is deny-by-default
  (`packages/db/src/queries/listings.ts`):
  - the product slug must already exist — a report cannot invent a product;
  - the retailer must exist **and be enabled**, which a CHECK constraint ties to a recorded
    ToS/robots review — a report cannot introduce or approve a shop;
  - the URL must be `https:` and its host must be the retailer's domain or a subdomain of it,
    matched on a label boundary so `shop.invalid.evil.test` fails;
  - at most `MAX_LISTINGS_PER_PRODUCT_RETAILER` (20) auto-created listings per product per
    retailer, so a malfunctioning scanner cannot fill the table;
  - a rejected report returns **422** with the reason, never a silent accept.

  Migration 0009 grants `app_worker` INSERT on `retailer_products` and nothing else: no UPDATE
  (an existing listing cannot be repointed), no DELETE, and no access to `retailers` or
  `sealed_products`. The grant is the floor under the application guards, not a substitute.

- Consequences:
  - Adding a shop is a catalog change (`pnpm db:import-sources`), not a scanner change. The
    scanner can only report against shops we have already reviewed.
  - `packages/db/src/seed/sources.json` is the reviewed source list, and records in comments why
    each excluded shop is excluded.
  - The scanner needs a small push client; that work lives in its own repo.
