import { parseEnv } from '@gth/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../client.js';
import { writeAuditLog } from '../queries/users.js';
import { users } from '../schema/auth.js';

/**
 * Grant or revoke a role (SR-2.6, SR-X.9).
 *   pnpm role:set <email> creator
 *   pnpm role:set <email> user
 *
 * Deliberately a CLI and not an API route. Roles decide who can publish under the brand,
 * so the grant needs server access rather than a session, and every change is written to
 * the audit log. `role` is `input: false` in Better Auth, so this is the only way it moves.
 */
const ROLES = ['user', 'creator', 'seller', 'admin'] as const;

const { DATABASE_URL_MIGRATOR } = parseEnv(
  z.object({ DATABASE_URL_MIGRATOR: z.string().startsWith('postgres') }),
);

const [email, role] = process.argv.slice(2);

if (!email || !role) {
  console.log(`usage: role:set <email> <${ROLES.join('|')}>`);
  process.exit(1);
}
if (!ROLES.includes(role as (typeof ROLES)[number])) {
  console.error(`unknown role "${role}". Expected one of: ${ROLES.join(', ')}`);
  process.exit(1);
}

const { db, close } = createDb({ url: DATABASE_URL_MIGRATOR, max: 1 });
try {
  const [before] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!before) {
    console.error(`no account with that email. They must sign in once first.`);
    process.exit(1);
  }
  if (before.role === role) {
    console.log(`already ${role}; nothing to do`);
  } else {
    await db
      .update(users)
      .set({ role: role as (typeof ROLES)[number], updatedAt: new Date() })
      .where(eq(users.id, before.id));
    // Who gained what, and from what: a role change must be reconstructable later.
    await writeAuditLog(db, {
      action: 'user.role_changed',
      targetType: 'user',
      targetId: before.id,
      diff: { from: before.role, to: role, via: 'cli' },
    });
    console.log(`${email}: ${before.role} → ${role} (audited)`);
  }
} finally {
  await close();
}
