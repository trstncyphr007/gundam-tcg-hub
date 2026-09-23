import { parseEnv } from '@gth/core';
import { z } from 'zod';
import { createDb } from '../client.js';
import { listDeletionsSince, reapplyDeletion } from '../queries/deletions.js';

/**
 * Re-apply account deletions after a restore (SR-X.25, `docs/runbooks/restore.md`).
 *
 *   pnpm db:reapply-deletions --since 2026-09-20T03:00:00Z            # shows what it would do
 *   pnpm db:reapply-deletions --since 2026-09-20T03:00:00Z --apply    # does it
 *
 * A backup taken before someone deleted their account still contains them, so restoring it
 * brings back people who were told they were gone. This puts them out again, through the same
 * database function the account page uses.
 *
 * **Dry run by default**, like the catalog import (FR-1.2): during an incident the first thing
 * anyone wants is to see what a command will do before it does it.
 *
 * The list of deletions comes from the audit log. By default that is read from the database
 * being repaired; pass `--audit-url` to read it from the live one instead, which is the usual
 * case — the restored log is older than the deletions being re-applied.
 */
const { DATABASE_URL_MIGRATOR } = parseEnv(
  z.object({ DATABASE_URL_MIGRATOR: z.string().startsWith('postgres') }),
);

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const apply = args.includes('--apply');

const sinceRaw = flag('since');
if (sinceRaw === undefined) {
  console.error('--since <ISO timestamp> is required: the time of the snapshot you restored');
  process.exit(1);
}
const since = new Date(sinceRaw);
if (Number.isNaN(since.getTime())) {
  console.error(`--since is not a timestamp: ${sinceRaw}`);
  process.exit(1);
}

const auditUrl = flag('audit-url') ?? DATABASE_URL_MIGRATOR;

const target = createDb({ url: DATABASE_URL_MIGRATOR, max: 1 });
const audit = auditUrl === DATABASE_URL_MIGRATOR ? null : createDb({ url: auditUrl, max: 1 });

try {
  const deletions = await listDeletionsSince(audit?.db ?? target.db, since);
  console.log(
    `${String(deletions.length)} deletion(s) recorded since ${since.toISOString()}` +
      (audit ? ' (from the audit database)' : ''),
  );

  if (!apply) {
    for (const deletion of deletions) {
      console.log(`  would delete ${deletion.userId} (deleted ${deletion.at.toISOString()})`);
    }
    console.log(deletions.length > 0 ? '\ndry run — pass --apply to carry these out' : '');
    // Nothing to do is a perfectly good answer, and exiting 0 keeps it out of an alert.
  } else {
    let deleted = 0;
    let absent = 0;
    for (const deletion of deletions) {
      const outcome = await reapplyDeletion(target.db, deletion.userId);
      if (outcome === 'deleted') deleted += 1;
      else absent += 1;
      console.log(`  ${outcome}: ${deletion.userId}`);
    }
    console.log(
      `\nre-applied ${String(deleted)}; ${String(absent)} were not in the restored snapshot`,
    );
    console.log('record these numbers in the incident notes (docs/runbooks/restore.md)');
  }
} finally {
  await target.close();
  await audit?.close();
}
