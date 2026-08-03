import { defineConfig } from 'vitest/config';

// The desktop workspace had NO tests at all — 1,479 lines including the Electron main process, with
// typecheck as the only automated check. This config exists so that stops being true.
//
// No coverage FLOOR yet, deliberately. The backend/frontend floors are ratchets set from a measured
// baseline; inventing one here before there is a suite to measure would either be trivially passable
// or block the first honest commit. Add one once the numbers below are real and stable.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // main.ts imports electron at module scope, which cannot load outside an Electron runtime.
    // Tests target the modules that are importable in plain node; main.ts needs its pure helpers
    // extracted before it can be covered.
    exclude: ['**/node_modules/**', '**/dist-main/**', '**/release/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'build/coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // Floors set from the FIRST measurement on 2026-08-03 (18.32/67.12/24.52/18.32), rounded
      // down. A ratchet, never lowered — same convention as backend and frontend.
      //
      // These are low on purpose and should be read honestly: main.ts sits at 13.9% statements
      // because most of it is the async boot block (backend spawn, window creation, tray, updater)
      // which the mock deliberately never runs. What IS covered is the IPC surface the renderer
      // actually calls. Raising this means simulating more of Electron, which risks testing the
      // mock rather than the shell.
      thresholds: { statements: 18, branches: 67, functions: 24, lines: 18 },
    },
  },
});
