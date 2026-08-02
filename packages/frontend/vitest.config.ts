import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom so both api-layer tests (which touch `window`) and React component
    // tests can run. The node env silently failed api.test.ts on `window`.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],

    // Restated so `npm run test:unit`'s `--exclude` (which REPLACES this list
    // rather than appending to it) stays equivalent. The frontend has no
    // *.integration.test.* files today, so test:unit == test here.
    exclude: ['**/node_modules/**', '**/dist/**'],

    coverage: {
      // Only active when a run passes `--coverage`.
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // `build/` (not `coverage/`) because .gitignore:3 already ignores `build/`
      // repo-wide and neither package emits anything there — so a coverage run
      // never leaves untracked files in `git status`. Nothing else writes here.
      reportsDirectory: './build/coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
      // MEASURED on 2026-08-01 (24 files / 235 tests):
      //   statements 46.69  branches 78.93  functions 46.79  lines 46.69
      // Floors sit ~2-3 points under. This package is component-heavy and much of
      // the uncovered surface is JSX that only a browser exercises; the floor is a
      // ratchet against regression, not a target. Raise it, never lower it.
      thresholds: {
        statements: 44,
        branches: 76,
        functions: 44,
        lines: 44,
      },
    },
  },
});
