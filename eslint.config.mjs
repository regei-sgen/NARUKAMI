// ESLint FLAT config (eslint 10 — flat is the only format it reads).
//
// Deliberately narrow. This repo had no linter at all until now, so turning on
// a full `recommended` set would bury the two classes of defect this audit item
// actually cares about under hundreds of stylistic findings nobody will read:
//
//   @typescript-eslint/no-floating-promises  — a rejected promise nobody awaits
//   @typescript-eslint/no-misused-promises   — an async fn passed where void is
//                                              expected (event handlers, hooks)
//   eslint-plugin-react-hooks                — hook order / dependency bugs
//
// Both promise rules are TYPE-AWARE, so each package gets its own parser block
// pointing at that package's tsconfig. Widen this file rule by rule, measuring
// the count each time — see `npm run lint` in the README of this change.
//
// MEASURED BASELINE on 2026-08-01, 186 files linted, `npm run lint` exit 1:
//   22 errors, 6 warnings
//     21  @typescript-eslint/no-misused-promises   (error)
//      1  @typescript-eslint/no-floating-promises  (error)  desktop/src/main.ts:1154
//      1  react-hooks/exhaustive-deps              (warn)   TerminalTab.tsx:586
//      5  unused eslint-disable directives         (warn)   stale suppressions
// Every one of the 22 errors is in application source (App.tsx, Popout.tsx,
// ProjectPanel.tsx, CodeEditor.tsx, TerminalTab.tsx, ChangesPanel.tsx,
// HeaderCluster.tsx, ArgusPanoptes.tsx, desktop/main.ts). They are real findings,
// each a behaviour change needing its own review — so lint is wired ADVISORY
// (continue-on-error in .github/workflows/ci.yml) and kept OUT of `npm run verify`.
// To make it blocking: fix those 22, then flip the CI job's continue-on-error to
// false. Do not make it blocking by weakening this file.
//
// Run:  npm run lint          (report)
//       npm run lint:strict   (report, non-zero exit on any warning too)

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const typeAwarePromiseRules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-main/**',
      '**/dist-app/**',
      '**/build/**',
      '**/release/**',
      '**/coverage/**',
      // Prisma client — generated on postinstall, never hand-edited.
      'packages/backend/src/generated/**',
      // Vendored third-party payload shipped verbatim into the installer.
      'packages/backend/godclaude-assets/**',
      'packages/frontend/public/**',
      'packages/mobile/**',
      'deploy/**',
      'logs/**',
    ],
  },

  // ── backend (CommonJS TS, node) ──────────────────────────────────────────
  {
    files: ['packages/backend/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./packages/backend/tsconfig.typecheck.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: typeAwarePromiseRules,
  },

  // ── frontend (ESM TS/TSX, browser + React) ───────────────────────────────
  {
    files: ['packages/frontend/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./packages/frontend/tsconfig.typecheck.json'],
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
      globals: globals.browser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...typeAwarePromiseRules,
      // The two classic hook bugs. The rest of react-hooks v7's (much larger)
      // rule set is intentionally left off for now — see the header note.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── desktop (Electron main/preload, CommonJS TS) ─────────────────────────
  {
    files: ['packages/desktop/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ['./packages/desktop/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: typeAwarePromiseRules,
  },
];
