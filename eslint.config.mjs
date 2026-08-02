// ESLint FLAT config (eslint 10 — flat is the only format it reads).
//
// Deliberately narrow. This repo had no linter at all until 2026-08-01, so
// turning on a full `recommended` set would bury the classes of defect this
// config actually cares about under hundreds of stylistic findings nobody reads:
//
//   @typescript-eslint/no-floating-promises  — a rejected promise nobody awaits
//   @typescript-eslint/no-misused-promises   — an async fn passed where void is
//                                              expected (event handlers, hooks)
//   @typescript-eslint/no-explicit-any       — see "the `any` guard" below
//   @typescript-eslint/no-unsafe-*           — ditto
//   eslint-plugin-react-hooks                — hook order / dependency bugs
//
// Every rule here is TYPE-AWARE, so each package gets its own parser block
// pointing at that package's tsconfig. Widen this file rule by rule, measuring
// the count each time.
//
// `npm run lint:strict` (= eslint . --max-warnings 0) is a BLOCKING CI job and
// the tree is at ZERO errors and ZERO warnings. That means a rule can only be
// added here at 'error' if it is already green, or is made green in the same
// change — a 'warn' is just as red as an 'error' under --max-warnings 0, so
// "downgrade it to a warning" is NOT an escape hatch in this repo. A rule that
// cannot be made green is scoped OFF, in this file, with its measured count and
// the reason — never with an inline eslint-disable.
//
// ── the `any` guard (added 2026-08-02) ──────────────────────────────────────
// `npm run typecheck` can always be satisfied by widening a type to `any`, which
// makes the type error disappear without making the code correct. That is the
// single easiest way for an automated contributor to "fix" a build, so the
// no-explicit-any / no-unsafe-* family is what actually holds the line.
//
// MEASURED on 2026-08-02 by switching the whole family on at 'error' repo-wide:
//   195 errors, 0 warnings
//     125  no-unsafe-member-access
//      41  no-unsafe-assignment
//      13  no-unsafe-argument
//       8  no-unsafe-call
//       5  no-unsafe-return
//       3  no-explicit-any
//   Split by location: 124 in *.test.ts(x), 51 in packages/desktop/src/main.ts,
//   17 in backend/frontend application source, 3 no-explicit-any (all of them in
//   desktop/src/main.ts).
//
// What shipped, and why:
//   • backend + frontend application source — FULL family at 'error'. The 17
//     violations were all type-level (`JSON.parse` returning `any`, `new Array(n)`
//     inferring `any[]`, `Array.isArray` narrowing `unknown` to `any[]`) and were
//     fixed at the call sites with no runtime change.
//   • *.test.ts(x) — no-explicit-any stays 'error' (it was already green there),
//     the five no-unsafe-* rules are OFF. Those 124 findings are tests reading
//     untyped `await res.json()` payloads, which is what a black-box test of an
//     HTTP route legitimately does. Turning them on would mean typing every
//     fixture, and would push contributors toward asserting less, not more.
//   • packages/desktop/src/main.ts — family OFF for the whole desktop workspace.
//     All 54 of its findings are Chrome DevTools Protocol event payloads
//     (`wc.debugger.on('message', (_e, method, params) => …)`), whose shape varies
//     per domain/method. The correct fix is a typed CDP surface (e.g. the
//     devtools-protocol types) plus guards at ~50 access sites — a real refactor
//     of code the test suite does not cover at all (scripts/run-unit-tests.mjs
//     runs backend + frontend only). Not done here rather than done blind.
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

/** The `any` guard — see the header block for the measured rollout. */
const noExplicitAnyRule = {
  '@typescript-eslint/no-explicit-any': 'error',
};

const noUnsafeRules = {
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
};

const anyGuardRules = { ...noExplicitAnyRule, ...noUnsafeRules };

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
      // Vendored third-party payload shipped verbatim into the installer. Not
      // linted here on purpose (it is upstream's code, re-vendored wholesale by
      // scripts/vendor-godclaude.mjs) — but it IS tested: its own regression
      // suite runs via `npm run test:hooks`, wired into the CI verify job.
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
    rules: { ...typeAwarePromiseRules, ...anyGuardRules },
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
      ...anyGuardRules,
      // The two classic hook bugs. The rest of react-hooks v7's (much larger)
      // rule set is intentionally left off for now — see the header note.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── desktop (Electron main/preload, CommonJS TS) ─────────────────────────
  // The `any` guard is NOT applied here: main.ts's CDP event handling accounts
  // for all 54 of the workspace's findings and needs a typed protocol surface
  // first. See the header block.
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

  // ── tests ────────────────────────────────────────────────────────────────
  // Last block wins in flat config, so this relaxes the two blocks above for
  // test files only. `no-explicit-any` deliberately survives: a test may READ an
  // untyped payload, but it should still never DECLARE `any`.
  {
    files: ['packages/*/src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
];
