import { createDb } from '@gth/db';

/**
 * Seed the e2e creator account, already holding the creator role.
 *
 * The role cannot be granted through the app: it is `input: false` in Better Auth and only
 * moves via an operator with database access (SR-2.6). So the suite does exactly that --
 * it writes the account directly, the way `pnpm role:set` would, and the tests then sign
 * in through the real magic-link flow. Better Auth matches the existing row by email, so
 * the session they get is a genuine one.
 *
 * Deliberately not by shelling out to the CLI: `child_process` is banned in app code
 * (SR-X.13), and that rule is worth more than the convenience.
 */
const CREATOR_EMAIL = process.env['E2E_CREATOR_EMAIL'] ?? 'creator@example.test';
/**
 * A second creator, for the breaker-profile suite.
 *
 * A profile is a running total over everything its owner has ever done, so a suite that
 * shares one account cannot assert "this breaker has no verified breaks" — an earlier spec's
 * commit–reveal has already made it false. That is the page working correctly, and a test
 * that has to be deleted to accommodate it would be the wrong thing to delete.
 */
const BREAKER_EMAIL = process.env['E2E_BREAKER_EMAIL'] ?? 'breaker@example.test';
const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';

export default async function globalSetup(): Promise<void> {
  const url = process.env['DATABASE_URL_MIGRATOR'];
  if (!url) throw new Error('DATABASE_URL_MIGRATOR is required to seed the e2e creator');

  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' }).catch(() => undefined);

  const { db, close } = createDb({ url, max: 1 });
  try {
    for (const [id, email] of [
      ['e2e-creator', CREATOR_EMAIL],
      ['e2e-breaker', BREAKER_EMAIL],
    ] as const) {
      const escaped = email.replaceAll("'", "''");
      const rows = await db.execute<{ id: string }>(
        `insert into app.users (id, name, email, email_verified, role)
         values ('${id}', 'E2E ${id}', '${escaped}', true, 'creator')
         on conflict (email) do update set role = 'creator', updated_at = now()
         returning id`,
      );
      const userId = String(rows[0]?.id);
      await db.execute(
        `insert into app.audit_log (action, target_type, target_id, diff)
         values ('user.role_changed', 'user', '${userId}', '{"to":"creator","via":"e2e-setup"}'::jsonb)`,
      );
      if (id !== 'e2e-breaker') continue;
      // A fresh slate for the breaker account's public record, so its spec asserts what it
      // did rather than what a previous run left behind. Inside a transaction that declares
      // the user, because both tables are FORCE'd: even the owner deletes nothing without
      // saying whose rows these are.
      await db.transaction(async (tx) => {
        await tx.execute(`select set_config('app.user_id', '${userId}', true)`);
        await tx.execute(`delete from app.breaks where creator_id = '${userId}'`);
        await tx.execute(`delete from app.creator_profiles where user_id = '${userId}'`);
      });
    }
  } finally {
    await close();
  }
}
