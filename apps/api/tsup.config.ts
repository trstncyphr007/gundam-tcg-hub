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
    'src/job-complete-orders.ts',
    'src/job-release-payouts.ts',
  ],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source; bundle them into the app.
  noExternal: [/^@gth\//],
  /**
   * A real `require` for the CommonJS packages that end up inside an ESM bundle.
   *
   * `pngjs` and `jpeg-js` are CommonJS and call `require('util')` when they load. Bundled into
   * ESM output, esbuild replaces that with a shim whose entire behaviour is to throw
   * `Dynamic require of "util" is not supported` — so the built API crashed on startup, **in
   * the built artifact only**. No test touches the bundle, so the e2e job was the one gate that
   * could have caught this, and did.
   *
   * Marking them external does not work here: pnpm puts them in `packages/photos/node_modules`
   * rather than `apps/api/node_modules`, so the bundle would import something it cannot
   * resolve at runtime. This keeps the single-file bundle the distroless image expects.
   */
  banner: {
    js: [
      "import { createRequire as __gthCreateRequire } from 'node:module';",
      'const require = __gthCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
