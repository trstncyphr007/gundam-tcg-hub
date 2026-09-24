import { defineConfig } from 'tsup';

export default defineConfig({
  // The migration runner and the scheduled jobs ship with the app, so the server runs exactly
  // the code that was built, scanned and signed — and so that they can run at all: the
  // production image is distroless, with no pnpm and no repository to run a script from.
  entry: [
    'src/index.ts',
    'src/migrate.ts',
    'src/job-retention.ts',
    'src/job-rollup.ts',
    'src/job-watchdog.ts',
    'src/job-alert-retry.ts',
  ],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source; bundle them into the app.
  noExternal: [/^@gth\//],
});
