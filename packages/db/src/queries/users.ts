import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { auditLog } from '../schema/audit.js';
import { users } from '../schema/auth.js';

/** Fields the account owner may see about themselves. Never exposed publicly. */
export interface SelfProfile {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  image: string | null;
  role: string;
  createdAt: Date;
}

export async function getSelfProfile(db: Database, userId: string): Promise<SelfProfile | null> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      displayName: users.displayName,
      image: users.image,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return user ?? null;
}

/**
 * Update only the caller's own display name. The WHERE clause is keyed on the session-derived
 * id, and `role` is not in the update set, so this can never escalate privileges (SR-X.9).
 */
export async function updateDisplayName(
  db: Database,
  userId: string,
  displayName: string | null,
): Promise<{ id: string; displayName: string | null } | null> {
  const [updated] = await db
    .update(users)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id, displayName: users.displayName });
  return updated ?? null;
}

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  ipHash?: string | null;
  uaHash?: string | null;
  /**
   * What changed, for actions where "it changed" is not enough to reconstruct later --
   * a role grant, for instance, is only meaningful with the previous role beside it.
   * Never put credentials or PII here; the audit log is retained for a year (SR-X.23).
   */
  diff?: Record<string, unknown> | null;
}

/** Append-only by database grant; failures must never break the request path. */
export async function writeAuditLog(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    ipHash: entry.ipHash ?? null,
    uaHash: entry.uaHash ?? null,
    diff: entry.diff ?? null,
  });
}
