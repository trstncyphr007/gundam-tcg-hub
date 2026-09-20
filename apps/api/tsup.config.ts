import { defineConfig } from 'tsup';

export default defineConfig({
  // The migration runner ships with the app so a deploy applies exactly the migrations
  // that were built and scanned.
  entry: ['src/index.ts', 'src/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source; bundle them into the app.
  noExternal: [/^@gth\//],
});
