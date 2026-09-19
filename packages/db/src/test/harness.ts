import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type Database, createDb } from '../client.js';
import { runMigrations } from '../migrate.js';

const INIT_SCRIPT = fileURLToPath(new URL('../../init/01-roles.sh', import.meta.url));

/** Throwaway credentials for the test container only. A Map avoids dynamic object indexing. */
const PASSWORDS = new Map([
  ['migrator', 'test_migrator_pw'],
  ['web', 'test_web_pw'],
  ['worker', 'test_worker_pw'],
  ['readonly', 'test_readonly_pw'],
] as const);

export type RoleName = 'migrator' | 'web' | 'worker' | 'readonly';

function pw(role: RoleName): string {
  const value = PASSWORDS.get(role);
  if (!value) throw new Error(`unknown test role: ${role}`);
  return value;
}

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  db: Database;
  /** Connection URL for one of the least-privilege roles, to test grants for real. */
  urlFor: (role: RoleName) => string;
  close: () => Promise<void>;
}

/**
 * Start a throwaway Postgres with the same roles and init script as dev/prod, then migrate.
 * Requires Docker (available locally and on GitHub runners).
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17-bookworm')
    .withDatabase('gth')
    .withUsername('gth_admin')
    .withPassword('test_admin_pw')
    .withEnvironment({
      PG_MIGRATOR_PASSWORD: pw('migrator'),
      PG_WEB_PASSWORD: pw('web'),
      PG_WORKER_PASSWORD: pw('worker'),
      PG_READONLY_PASSWORD: pw('readonly'),
    })
    .withCopyContentToContainer([
      {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- module-relative constant, no user input
        content: readFileSync(INIT_SCRIPT, 'utf8'),
        target: '/docker-entrypoint-initdb.d/01-roles.sh',
        mode: 0o755,
      },
    ])
    .start();

  const urlFor = (role: RoleName): string =>
    `postgres://app_${role}:${pw(role)}@${container.getHost()}:${String(
      container.getMappedPort(5432),
    )}/gth`;

  await runMigrations(urlFor('migrator'));

  const { db, close } = createDb({ url: urlFor('migrator'), max: 2 });
  return {
    container,
    db,
    urlFor,
    close: async () => {
      await close();
      await container.stop();
    },
  };
}
