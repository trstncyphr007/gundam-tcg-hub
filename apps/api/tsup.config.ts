import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source; bundle them into the app.
  noExternal: [/^@gth\//],
});
