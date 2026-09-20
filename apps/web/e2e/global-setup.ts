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
const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';

export default async function globalSetup(): Promise<void> {
  const url = process.env['DATABASE_URL_MIGRATOR'];
  if (!url) throw new Error('DATABASE_URL_MIGRATOR is required to seed the e2e creator');

  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' }).catch(() => undefined);

  const { db, close } = createDb({ url, max: 1 });
  try {
    const email = CREATOR_EMAIL.replaceAll("'", "''");
    const rows = await db.execute<{ id: string }>(
      `insert into app.users (id, name, email, email_verified, role)
       values ('e2e-creator', 'E2E Creator', '${email}', true, 'creator')
       on conflict (email) do update set role = 'creator', updated_at = now()
       returning id`,
    );
    const id = String(rows[0]?.id);
    await db.execute(
      `insert into app.audit_log (action, target_type, target_id, diff)
       values ('user.role_changed', 'user', '${id}', '{"to":"creator","via":"e2e-setup"}'::jsonb)`,
    );
  } finally {
    await close();
  }
}
