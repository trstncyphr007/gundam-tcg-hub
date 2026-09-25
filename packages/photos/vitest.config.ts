import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Generous, because these tests are CPU-bound rather than waiting on anything.
     *
     * Decoding, resampling and re-encoding a multi-megapixel photograph in pure JavaScript is
     * a second or two here, and roughly four times that under V8 coverage instrumentation.
     *
     * The number has moved twice, and both times for the same reason: a CPU-bound test on a
     * shared runner is not slow, it is **starved**. This package now also starts two
     * containers, `turbo` runs eight packages beside it, and a resize that takes three seconds
     * alone took over thirty while competing — a tenfold spread that no fixture size fixes.
     *
     * So the number is set to exceed the slowest plausible machine rather than to describe the
     * work. A test that takes two minutes here is broken; one that takes forty seconds on a
     * busy runner is doing exactly what it should, and should not fail for it.
     */
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // `src/cli/**`, for the same reason `@gth/db` excludes its own: a command is an entry
      // point, exercised by running it — CI runs `pnpm photos:bucket` before the e2e suite —
      // and a unit test of `main()` would assert that argument parsing calls the functions it
      // calls. What is worth covering is `putCorsPolicy`, and that is tested against a real S3
      // server by sending it the preflight a browser would.
      exclude: ['src/**/*.test.ts', 'src/cli/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
