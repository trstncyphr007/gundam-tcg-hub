import { and, count, desc, eq, gt, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { sessions, signInDevices } from '../schema/auth.js';
import { asUser } from './watches.js';

/**
 * A session as its owner may see it (ADR-026).
 *
 * **No token.** Better Auth's own `/list-sessions` returns every session's token, and the
 * only thing it asks first is a recent sign-in — which is exactly what someone holding the
 * inbox can get. These queries never select the column, so nothing built on them can leak it.
 */
export interface OwnSession {
  id: string;
  userAgent: string | null;
  authMethod: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export async function listActiveSessions(db: Database, userId: string): Promise<OwnSession[]> {
  return db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      authMethod: sessions.authMethod,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, sql`now()`)))
    .orderBy(desc(sessions.createdAt));
}

/** One of the user's own sessions, or nothing — "not yours" and "not there" look the same. */
export async function findOwnSession(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<Pick<OwnSession, 'id' | 'authMethod'> | undefined> {
  const [row] = await db
    .select({ id: sessions.id, authMethod: sessions.authMethod })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  return row;
}

/** Ends one session. Keyed on the owner as well as the id, so a guessed id ends nothing. */
export async function deleteOwnSession(
  db: Database,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/**
 * Ends every other session on the account, except — unless `includePasskey` — those opened
 * with a passkey, which only a passkey session may end (ADR-026).
 */
export async function deleteOtherSessions(
  db: Database,
  userId: string,
  keepSessionId: string,
  includePasskey: boolean,
): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        ne(sessions.id, keepSessionId),
        // `is distinct from`, not `<>`: a null method (a session from before ADR-025) must be
        // ended too, and `null <> 'passkey'` is null, which would quietly keep it.
        includePasskey ? undefined : sql`${sessions.authMethod} is distinct from 'passkey'`,
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

/** How many other sessions survived a "sign out everywhere else" because of the rule above. */
export async function countOtherPasskeySessions(
  db: Database,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        ne(sessions.id, keepSessionId),
        eq(sessions.authMethod, 'passkey'),
        gt(sessions.expiresAt, sql`now()`),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Note a sign-in from `device`, and say whether it is one this account has not used before
 * (SR-X.5, ADR-026).
 *
 * `otherDevices` is how many *different* devices the account already knew. Zero means this is
 * the account's first device ever — a new account, or the first sign-in since this table
 * existed — and nothing about that is worth an email.
 */
export async function recordSignInDevice(
  db: Database,
  userId: string,
  device: string,
): Promise<{ isNew: boolean; otherDevices: number }> {
  return asUser(db, userId, async (tx) => {
    const inserted = await tx
      .insert(signInDevices)
      .values({ userId, device })
      .onConflictDoNothing()
      .returning({ device: signInDevices.device });

    if (inserted.length === 0) {
      await tx
        .update(signInDevices)
        .set({ lastSeenAt: sql`now()` })
        .where(and(eq(signInDevices.userId, userId), eq(signInDevices.device, device)));
      return { isNew: false, otherDevices: 0 };
    }

    const [row] = await tx
      .select({ n: count() })
      .from(signInDevices)
      .where(and(eq(signInDevices.userId, userId), ne(signInDevices.device, device)));
    return { isNew: true, otherDevices: row?.n ?? 0 };
  });
}
