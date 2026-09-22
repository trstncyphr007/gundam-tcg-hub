import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { auditLog } from '../schema/audit.js';
import {
  accounts,
  passkeys,
  sessions,
  signInDevices,
  users,
  verifications,
} from '../schema/auth.js';
import { breakCommitments, breakPulls, breaks, pullEvidence } from '../schema/breaks.js';
import { cardVariants, cards, retailerProducts, sealedProducts, sets } from '../schema/catalog.js';
import { collectionItems, collections } from '../schema/collections.js';
import { apiKeys } from '../schema/ingest.js';
import { liveSales } from '../schema/live-sales.js';
import { priceObservations } from '../schema/pricing.js';
import { creatorProfiles } from '../schema/profiles.js';
import { watchSubscriptions } from '../schema/watches.js';
import { asUser } from './watches.js';

/**
 * Everything this service holds about one person, for them to take away (SR-X.25, ADR-027).
 *
 * Read in one transaction that declares the user, so row-level security is in force for
 * every table that has it: this function *cannot* read anyone else's rows, whatever a bug in
 * it might ask for.
 *
 * What is deliberately left out is listed in `withheld`, not silently dropped:
 *
 *  - **Secrets that open things:** session tokens, OAuth access/refresh tokens, API key
 *    hashes, overlay token hashes, unrevealed break seeds. An export is a file people email
 *    to themselves and leave in Downloads; nothing in it should be a working credential.
 *  - **Other people's personal data:** buyer handles from the live-sale logger. They are a
 *    third party's name, which the seller already sees in their own listing and which is
 *    erased after 90 days anyway (SR-4.5); a portable copy would outlive that.
 */
export interface AccountExport {
  format: 'gundam-tcg-hub-export';
  version: 1;
  exportedAt: string;
  withheld: string[];
  account: Record<string, unknown>;
  signInMethods: Record<string, unknown>[];
  passkeys: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  signInDevices: Record<string, unknown>[];
  watches: Record<string, unknown>[];
  collections: Record<string, unknown>[];
  creatorProfile: Record<string, unknown> | null;
  breaks: Record<string, unknown>[];
  liveSales: Record<string, unknown>[];
  priceReports: Record<string, unknown>[];
  apiKeys: Record<string, unknown>[];
  activity: Record<string, unknown>[];
}

export const EXPORT_WITHHELD = [
  'session tokens, OAuth tokens, API key hashes and overlay token hashes — they open things',
  'the secret seed of any break not yet revealed',
  "buyer handles from the live-sale logger — another person's name (SR-4.5)",
] as const;

/** A card as a person would recognise it, rather than a bare id. */
const cardColumns = {
  cardName: cards.name,
  cardNumber: cards.number,
  setCode: sets.code,
  finish: cardVariants.finish,
  language: cardVariants.language,
};

export async function exportAccountData(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<AccountExport | null> {
  return asUser(db, userId, async (tx) => {
    const [account] = await tx
      .select({
        id: users.id,
        email: users.email,
        emailVerified: users.emailVerified,
        name: users.name,
        displayName: users.displayName,
        image: users.image,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!account) return null;

    const signInMethods = await tx
      .select({
        provider: accounts.providerId,
        providerAccountId: accounts.accountId,
        scope: accounts.scope,
        createdAt: accounts.createdAt,
      })
      .from(accounts)
      .where(eq(accounts.userId, userId));

    const ownPasskeys = await tx
      .select({
        name: passkeys.name,
        deviceType: passkeys.deviceType,
        backedUp: passkeys.backedUp,
        createdAt: passkeys.createdAt,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, userId));

    // What is held about where they signed in from is theirs to see (SR-X.25) — which, since
    // ADR-028, is a same-day hash rather than an address, and is labelled as one. The token
    // is not data about them; it is a key.
    const ownSessions = await tx
      .select({
        signedInAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        method: sessions.authMethod,
        ipHash: sessions.ipAddress,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(asc(sessions.createdAt));

    const devices = await tx
      .select({
        device: signInDevices.device,
        firstSeenAt: signInDevices.firstSeenAt,
        lastSeenAt: signInDevices.lastSeenAt,
      })
      .from(signInDevices)
      .where(eq(signInDevices.userId, userId));

    const watches = await tx
      .select({
        product: sealedProducts.name,
        listingUrl: retailerProducts.url,
        channels: watchSubscriptions.channels,
        createdAt: watchSubscriptions.createdAt,
      })
      .from(watchSubscriptions)
      .leftJoin(sealedProducts, eq(sealedProducts.id, watchSubscriptions.sealedProductId))
      .leftJoin(retailerProducts, eq(retailerProducts.id, watchSubscriptions.retailerProductId))
      .where(eq(watchSubscriptions.userId, userId));

    const ownCollections = await tx
      .select({
        id: collections.id,
        name: collections.name,
        visibility: collections.visibility,
        createdAt: collections.createdAt,
      })
      .from(collections)
      .where(eq(collections.ownerId, userId))
      .orderBy(asc(collections.createdAt));
    const items =
      ownCollections.length === 0
        ? []
        : await tx
            .select({
              collectionId: collectionItems.collectionId,
              ...cardColumns,
              condition: collectionItems.condition,
              quantity: collectionItems.quantity,
              acquiredPriceCents: collectionItems.acquiredPriceCents,
              currency: collectionItems.currency,
              acquiredAt: collectionItems.acquiredAt,
              notes: collectionItems.notes,
              addedAt: collectionItems.createdAt,
            })
            .from(collectionItems)
            .leftJoin(cardVariants, eq(cardVariants.id, collectionItems.cardVariantId))
            .leftJoin(cards, eq(cards.id, cardVariants.cardId))
            .leftJoin(sets, eq(sets.id, cards.setId))
            .where(
              inArray(
                collectionItems.collectionId,
                ownCollections.map((c) => c.id),
              ),
            );

    const [profile] = await tx
      .select({
        handle: creatorProfiles.handle,
        displayName: creatorProfiles.displayName,
        bio: creatorProfiles.bio,
        published: creatorProfiles.published,
        createdAt: creatorProfiles.createdAt,
      })
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, userId));

    const ownBreaks = await tx
      .select({
        id: breaks.id,
        title: breaks.title,
        product: sealedProducts.name,
        costCents: breaks.costCents,
        packsOpened: breaks.packsOpened,
        vodUrl: breaks.vodUrl,
        status: breaks.status,
        startedAt: breaks.startedAt,
        endedAt: breaks.endedAt,
        createdAt: breaks.createdAt,
      })
      .from(breaks)
      .leftJoin(sealedProducts, eq(sealedProducts.id, breaks.sealedProductId))
      .where(eq(breaks.creatorId, userId))
      .orderBy(asc(breaks.createdAt));
    const breakIds = ownBreaks.map((b) => b.id);

    const pulls =
      breakIds.length === 0
        ? []
        : await tx
            .select({
              id: breakPulls.id,
              breakId: breakPulls.breakId,
              seq: breakPulls.seq,
              label: breakPulls.label,
              ...cardColumns,
              valueCentsAtPull: breakPulls.valueCentsAtPull,
              valueSource: breakPulls.valueSource,
              rowHash: breakPulls.rowHash,
              pulledAt: breakPulls.pulledAt,
            })
            .from(breakPulls)
            .leftJoin(cardVariants, eq(cardVariants.id, breakPulls.cardVariantId))
            .leftJoin(cards, eq(cards.id, cardVariants.cardId))
            .leftJoin(sets, eq(sets.id, cards.setId))
            .where(inArray(breakPulls.breakId, breakIds))
            .orderBy(asc(breakPulls.breakId), asc(breakPulls.seq));
    const evidence =
      pulls.length === 0
        ? []
        : await tx
            .select({
              breakPullId: pullEvidence.breakPullId,
              offsetSeconds: pullEvidence.offsetSeconds,
              vodUrl: pullEvidence.vodUrl,
            })
            .from(pullEvidence)
            .where(
              inArray(
                pullEvidence.breakPullId,
                pulls.map((p) => p.id),
              ),
            );
    // The commitment is public; the seed only once revealed. `server_seed_encrypted` is
    // never selected at all.
    const commitments =
      breakIds.length === 0
        ? []
        : await tx
            .select({
              breakId: breakCommitments.breakId,
              commitment: breakCommitments.commitment,
              clientSeed: breakCommitments.clientSeed,
              revealedSeed: breakCommitments.revealedSeed,
              slotCount: breakCommitments.slotCount,
              algorithmVersion: breakCommitments.algorithmVersion,
              committedAt: breakCommitments.committedAt,
              revealedAt: breakCommitments.revealedAt,
            })
            .from(breakCommitments)
            .where(inArray(breakCommitments.breakId, breakIds));

    const sales = await tx
      .select({
        label: liveSales.label,
        ...cardColumns,
        condition: liveSales.condition,
        priceCents: liveSales.priceCents,
        currency: liveSales.currency,
        soldAt: liveSales.soldAt,
        streamRef: liveSales.streamRef,
        hadBuyerHandle: liveSales.hasBuyerHandle,
      })
      .from(liveSales)
      .leftJoin(cardVariants, eq(cardVariants.id, liveSales.cardVariantId))
      .leftJoin(cards, eq(cards.id, cardVariants.cardId))
      .leftJoin(sets, eq(sets.id, cards.setId))
      .where(eq(liveSales.sellerId, userId))
      .orderBy(asc(liveSales.soldAt));

    const reports = await tx
      .select({
        ...cardColumns,
        condition: priceObservations.condition,
        priceCents: priceObservations.priceCents,
        currency: priceObservations.currency,
        observedAt: priceObservations.observedAt,
        evidenceRef: priceObservations.evidenceRef,
        approvedAt: priceObservations.approvedAt,
        rejectedAt: priceObservations.rejectedAt,
      })
      .from(priceObservations)
      .leftJoin(cardVariants, eq(cardVariants.id, priceObservations.cardVariantId))
      .leftJoin(cards, eq(cards.id, cardVariants.cardId))
      .leftJoin(sets, eq(sets.id, cards.setId))
      .where(eq(priceObservations.reporterId, userId))
      .orderBy(asc(priceObservations.observedAt));

    const keys = await tx
      .select({
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        tier: apiKeys.tier,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.ownerId, userId));

    // What the audit log records about this account: things they did, and things done to it.
    // Not *who* did the latter — an admin's id is not this person's data.
    const activity = await tx
      .select({ action: auditLog.action, at: auditLog.at })
      .from(auditLog)
      .where(
        or(
          eq(auditLog.actorId, userId),
          and(inArray(auditLog.targetType, ['user', 'session']), eq(auditLog.targetId, userId)),
        ),
      )
      .orderBy(asc(auditLog.at));

    return {
      format: 'gundam-tcg-hub-export',
      version: 1,
      exportedAt: now.toISOString(),
      withheld: [...EXPORT_WITHHELD],
      account,
      signInMethods,
      passkeys: ownPasskeys,
      sessions: ownSessions,
      signInDevices: devices,
      watches,
      // Nested, with their ids kept: the ids are the person's own record numbers, and they
      // are what ties an item to its collection if the file is ever read by a program.
      collections: ownCollections.map((c) => ({
        ...c,
        items: items.filter((i) => i.collectionId === c.id),
      })),
      creatorProfile: profile ?? null,
      breaks: ownBreaks.map((b) => ({
        ...b,
        commitment: commitments.find((c) => c.breakId === b.id) ?? null,
        pulls: pulls
          .filter((p) => p.breakId === b.id)
          .map((p) => ({ ...p, evidence: evidence.filter((e) => e.breakPullId === p.id) })),
      })),
      liveSales: sales,
      priceReports: reports,
      apiKeys: keys,
      activity,
    };
  });
}

/**
 * Permanently delete an account and everything that is only theirs (SR-X.25, ADR-027).
 *
 * The work is `app.delete_account` (migration 0033), which the web role may call but whose
 * steps it could not take itself: never-approved price reports are deleted, approved ones are
 * anonymised by the foreign key's `set null`, and everything else that was only theirs goes
 * with the cascade from `users` — including FORCE'd tables, because foreign-key actions run
 * as the table owner. All of that is proven in tests rather than assumed.
 *
 * Pending sign-in links reference no user at all — Better Auth keys each by its token and
 * keeps the address inside a JSON value — so the cascade misses them and they are removed by
 * hand. Otherwise the address would sit in the database for up to fifteen more minutes, and
 * an unused link from before the deletion would quietly create a new account on click.
 *
 * Returns the email the account had, for the goodbye notice, or null if there was nothing to
 * delete.
 */
export async function deleteAccount(db: Database, userId: string): Promise<string | null> {
  return asUser(db, userId, async (tx) => {
    const [row] = await tx.execute<{ email: string | null }>(
      sql`select app.delete_account(${userId}) as email`,
    );
    const email = row?.email ?? null;
    if (email === null) return null;
    // CASE, not AND: SQL does not promise to test validity before attempting the cast, and
    // other kinds of verification row are not JSON.
    await tx.delete(verifications).where(
      sql`case when pg_input_is_valid(${verifications.value}, 'jsonb')
                 then lower(${verifications.value}::jsonb ->> 'email') end = lower(${email})`,
    );
    await tx.insert(auditLog).values({
      actorId: null,
      action: 'account.deleted',
      targetType: 'user',
      targetId: userId,
    });
    return email;
  });
}
