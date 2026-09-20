import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Route tests start a real Postgres via Testcontainers; a cold CI runner must pull
    // the image first, which is far slower than a warm local cache.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    /**
     * Each route test file starts its own Postgres. There are seven of them now, and seven
     * coming up at once is enough for a runner to drop one — which surfaces as an entire
     * file failing in `beforeAll`, a failure that says nothing about the code.
     *
     * Four at a time keeps most of the parallelism and has not flaked. The real fix is one
     * container shared across files; that is a larger change to the harness, worth doing
     * when the count grows again rather than now.
     */
    pool: 'forks',
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
    },
  },
});
