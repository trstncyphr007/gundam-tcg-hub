import { count, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { passkeys } from '../schema/auth.js';

/**
 * How many passkeys an account holds (ADR-025).
 *
 * The number that decides who may add another: none, and a fresh sign-in by email or Discord
 * may register the first; one or more, and only a session opened *with* a passkey may add a
 * second. Without that rule, anyone who can read the account's email could enrol their own
 * passkey and walk through the admin gate as the owner.
 */
export async function countPasskeys(db: Database, userId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(passkeys).where(eq(passkeys.userId, userId));
  return row?.n ?? 0;
}
