import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests spin up a real Postgres via Testcontainers.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/cli/**', 'src/test/**'],
      thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
    },
  },
});
