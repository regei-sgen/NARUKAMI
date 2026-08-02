import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // These pure-unit tests never touch Postgres or spawn processes.
    passWithNoTests: false,

    // `npm run test:unit` layers `--exclude "**/*.integration.test.ts"` on top of
    // this list, which is why the defaults are spelled out here: the vitest CLI
    // REPLACES `exclude` rather than appending to it, so the unit script has to
    // restate node_modules itself. Keep the two in sync.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/generated/**'],

    coverage: {
      // Only active when a run passes `--coverage`; a plain `vitest run` is
      // unaffected, so the thresholds below gate the verify chain and nothing else.
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // `build/` (not `coverage/`) because .gitignore:3 already ignores `build/`
      // repo-wide and neither package emits anything there — so a coverage run
      // never leaves untracked files in `git status`. Nothing else writes here.
      reportsDirectory: './build/coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/generated/**'],
      // MEASURED on 2026-08-01 against the unit-only run (41 files / 503 tests):
      //   statements 65.91  branches 80.73  functions 78.26  lines 65.91
      // Floors sit ~2-3 points under the measurement: high enough that deleting a
      // covered module or landing a large untested one goes red, low enough that
      // ordinary churn does not. Raise them when the real numbers rise; never
      // lower them to make a red run green.
      thresholds: {
        statements: 63,
        branches: 78,
        functions: 75,
        lines: 63,
      },
    },
  },
});
