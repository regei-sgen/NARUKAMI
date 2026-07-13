# Editor "Changes" tab — design spec

**Date:** 2026-07-13
**Status:** Approved for planning
**Component:** NARUKAMI desktop — Editor view (`packages/frontend/src/components/CodeEditor.tsx`) + backend git services/routes

## Summary

Add an interactive source-control panel to the Editor's left sidebar. Today the
sidebar is a single "Explorer" (file tree + Name/Code search) and the git branch
shows only as a passive label in the editor toolbar. This adds a second sidebar
tab, **Changes**, that lists the working tree split into **Merge Conflicts /
Staged Changes / Changes (unstaged)**, shows the current branch, and lets the
user **stage, unstage, discard, and commit** — all local-only. Clicking a
changed file opens it in the editor's existing Monaco side-by-side diff
(committed vs working).

## Goals

- One place in the Editor to see what changed since the last commit, correctly
  separated into staged vs unstaged vs merge-conflicted.
- Local git actions from the UI: stage / unstage / discard (per file + all),
  and commit the staged set with a message.
- Reuse the existing `± Diff` view for viewing a file's changes (no new diff UI).
- Show the branch name (and detached state) prominently in the panel.

## Non-goals (explicitly out of v1)

- **Push** — intentionally not built and not exposed as a route. (GODCLAUDE
  goddev boundary: never push; a push would be propose-only.)
- Amend, per-hunk / partial-line staging, ahead/behind counts, stash UI, branch
  switching/creation. Each is a possible follow-up.

## Current state (what exists today)

- `services/gitEditor.ts` — `currentBranch(cwd)` → `{branch, detached}`;
  `fileAtHead(cwd, relPosix)` → committed content. Both wired:
  - `GET /api/projects/:id/git/branch`
  - `GET /api/projects/:id/git/file-head?path=` (in `routes/files.ts`)
- `services/gitStatus.ts` — `gitStatus()` and `gitDiffRanges()`. **Not wired to
  any route.** `gitStatus()` **collapses** git's index (X) and worktree (Y)
  porcelain columns into one bucket via `classify()`, so it cannot express
  staged-vs-unstaged or conflicts. It is left untouched by this work.
- `routes/files.ts` — `resolveInProject(root, rel)` (exported) is the path-escape
  guard (blocks `..`, absolute escape, symlink escape). Reused here.
- `CodeEditor.tsx` — left `aside.file-tree` (search + tree); right `editor-main`
  (Monaco `Editor`, and a `DiffEditor` toggled by `showDiff` that diffs
  `headContent` (HEAD) vs `content` (working buffer)). Branch label already polls
  `getGitBranch` every 3.5s.

## Architecture

### Backend

**New service: `packages/backend/src/services/gitChanges.ts`** — pure parsing +
one I/O entrypoint. Kept separate from `gitStatus.ts` (which serves a different,
collapsed purpose) so neither changes the other's contract.

Types:

```ts
export type GitChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface GitChangeEntry {
  path: string;        // project-relative, POSIX separators
  type: GitChangeType; // for the row's colour/letter badge
  staged: boolean;     // which bucket produced it (index side vs worktree side)
}

export interface GitChangesResult {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  staged: GitChangeEntry[];    // index differs from HEAD
  unstaged: GitChangeEntry[];  // worktree differs from index (incl. untracked)
  conflicts: GitChangeEntry[]; // unmerged paths
}
```

Pure functions (unit-tested against captured porcelain):

- `parseStatusFull(raw: string): { x: string; y: string; path: string }[]`
  — parses `git status --porcelain=v1 -z --untracked-files=all`, preserving both
  status columns. Handles `-z` NUL records and rename/copy (R/C) records where the
  original path is the *next* NUL field (kept as the "from" but the new path is
  what we report).
- `bucketChanges(entries, prefix): GitChangesResult['{staged,unstaged,conflicts}']`
  — applies the classification rules below and strips the monorepo `prefix`
  (from `rev-parse --show-prefix`) so paths line up with the project subtree,
  dropping anything outside it (same approach as `gitStatus`).

Classification rules (X = index, Y = worktree):

- **Conflict** (exclusive; goes only to `conflicts`) when
  `x==='U' || y==='U' || (x==='D'&&y==='D') || (x==='A'&&y==='A')`
  (covers porcelain unmerged codes `DD AU UD UA DU AA UU`).
- Otherwise a file may appear in **both** staged and unstaged (e.g. `MM`):
  - **staged** when `x` is not `' '` and not `'?'` (index moved: `M A D R C T`),
    with `type` derived from `x`.
  - **unstaged** when `y` is not `' '` (`M D T`) **or** untracked (`x==='?'` →
    `type: 'untracked'`), with `type` derived from `y`.

I/O entrypoint:

- `gitSourceControl(projectPath: string): Promise<GitChangesResult>`
  — fail-soft: returns `{isRepo:false, …}` when not a git repo/git missing.
  Runs `rev-parse --show-prefix` (repo check + prefix), `status --porcelain=v1 -z
  --untracked-files=all`, and reuses `currentBranch()` for branch/detached.
  Reuses the hardened `git()` helper pattern from `gitStatus.ts`
  (`execFile`, args array, `-C`, `timeout`, `windowsHide`, `maxBuffer`,
  `GIT_LITERAL_PATHSPECS=1`). Result capped at `MAX_STATUS_FILES` **after**
  subtree filtering.

Mutations (thin functions, each `execFile`-based, args array, `-C projectPath`,
`GIT_LITERAL_PATHSPECS=1`, timeout, `windowsHide`):

- `stagePath(projectPath, relPath)` → `git add -- <rel>` (stages adds, mods, and
  deletions of that path).
- `unstagePath(projectPath, relPath)` → `git restore --staged -- <rel>`; on an
  unborn HEAD (no commits) fall back to `git rm --cached --quiet -- <rel>`.
- `discardPath(projectPath, relPath, untracked)` → for tracked:
  `git restore -- <rel>` (revert worktree to index/HEAD); for untracked:
  delete the file on disk (`fs.rm`, path validated). **Destructive.**
- `commitStaged(projectPath, message)` → `git commit -m <message>`; returns the
  new short HEAD. Surfaces git's error (e.g. "nothing to commit") to the caller.
- `stageAll(projectPath)` → `git add -A -- .`;
  `unstageAll(projectPath)` → `git reset -q -- .` (unborn-HEAD fallback:
  `git rm -r --cached --quiet -- .`).

**New route file: `packages/backend/src/routes/git.ts`** (`gitRoutes`,
registered in `index.ts` after `fileRoutes`). Every mutating handler validates
the body `path` with `resolveInProject(project.path, rel)` (throws → 400) before
touching git, so a crafted path can't escape the project root. Endpoints:

| Method + path | Body | Returns |
|---|---|---|
| `GET  /api/projects/:id/git/changes` | — | `GitChangesResult` |
| `POST /api/projects/:id/git/stage` | `{path}` | `{ok:true}` |
| `POST /api/projects/:id/git/unstage` | `{path}` | `{ok:true}` |
| `POST /api/projects/:id/git/discard` | `{path, untracked?}` | `{ok:true}` |
| `POST /api/projects/:id/git/commit` | `{message}` | `{ok:true, head}` |
| `POST /api/projects/:id/git/stage-all` | — | `{ok:true}` |
| `POST /api/projects/:id/git/unstage-all` | — | `{ok:true}` |

All handlers 404 on unknown project, 400 on missing/invalid input, and surface
git failures as `{error}` with a 4xx/5xx code. Read path (`/changes`) is
fail-soft (`isRepo:false` rather than an error) so a non-git project just shows
an empty panel. `/git/branch` and `/git/file-head` stay in `files.ts` unchanged
(moving them would be churn for no gain; the toolbar still uses `/git/branch`).

### Frontend

`types.ts` — mirror `GitChangeType`, `GitChangeEntry`, `GitChangesResult`
(named `GitChanges` on the client).

`api.ts` — add: `getGitChanges(projectId)`, `stageFile`, `unstageFile`,
`discardFile(projectId, path, untracked)`, `commitChanges(projectId, message)`,
`stageAll`, `unstageAll`. POSTs send JSON bodies; reads reuse `request<…>`.

`CodeEditor.tsx` — add sidebar tab state `leftTab: 'explorer' | 'changes'`
(default `'explorer'`). A small segmented control at the top of `aside.file-tree`
switches between:
- `explorer` → the current search box + tree (unchanged).
- `changes` → the new `<ChangesPanel>`.

`CodeEditor` passes `ChangesPanel` an `onOpenDiff(path, deleted)` callback that:
`await openPath(path)` then `setShowDiff(true)`. For a **deleted** file (no
working file to open) it instead loads `getFileHead`, sets the diff's committed
side to that content and the working side to empty, showing the deletion.

**New component: `packages/frontend/src/components/ChangesPanel.tsx`**
Props: `{ projectId, currentPath, onOpenDiff }`. Behaviour:
- Fetches `getGitChanges` on mount, on a ~3.5s poll, and after every mutation
  (identity-bail on unchanged, like the branch poll, to avoid re-render churn).
- Renders, top → bottom:
  - **Branch header** — `<Ic name="branch"/> name` + "detached" badge.
  - **Merge Conflicts** section (only when non-empty; visually distinct). Rows
    open the file to edit.
  - **Staged Changes** section — rows with an **Unstage** button; a header
    **Unstage all**; and a **commit box** (message `<textarea>` + **Commit**
    button, disabled when the message is blank or nothing is staged).
  - **Changes** section — rows with **Stage** and **Discard** buttons; header
    **Stage all**.
- Each row: status letter badge (A/M/D/R/? colour-coded), filename + dimmed
  dir path, click-to-open-diff on the row body.
- **Discard** calls `window.confirm(...)` first (destructive); on confirm →
  `discardFile` → refetch.
- Errors surface inline in a small banner; the panel never throws.

`styles.css` — section headers, row layout, letter-badge colours (reuse the
add/modify/delete theme tokens already used for tree decoration where possible),
commit box, and the Explorer/Changes segmented control.

## Data flow

```
ChangesPanel ──GET /git/changes──▶ gitRoutes ──▶ gitSourceControl()
   │  (poll 3.5s + after each action)                 │
   │                                                   └─ git status -z + currentBranch()
   ├─ Stage/Unstage/Discard/Commit ─POST─▶ gitRoutes ─▶ stagePath/…/commitStaged
   │                                                   (then panel refetches)
   └─ click row ─▶ CodeEditor.onOpenDiff(path) ─▶ openPath() + showDiff
                                                   (existing DiffEditor: HEAD vs working)
```

## Error handling & edge cases

- Non-git project / git missing → `/changes` returns `isRepo:false`; panel shows
  "Not a git repository."
- Unborn HEAD (no commits): status still works; unstage/unstage-all use the
  `rm --cached` fallback; commit surfaces git's message if the message is empty.
- Nested project inside a bigger repo: prefix-strip + subtree filter (same as
  `gitStatus`), so only the project's own changes show and mutation pathspecs
  resolve under `-C project.path`.
- Path safety: mutation `path` is validated with `resolveInProject` **and**
  `GIT_LITERAL_PATHSPECS=1` neutralizes git pathspec magic.
- Discard of an untracked file deletes it from disk — guarded by a UI confirm.
- Deleted file row → committed-vs-empty diff via `file-head`.
- File switched mid-request: panel refetch is idempotent; `openPath` already
  guards the editor's own in-flight races.

## Testing (TDD — write the test first, red → green)

**Backend — `services/gitChanges.test.ts` (pure):** `parseStatusFull` and
`bucketChanges` against captured porcelain strings for: staged add `A `,
staged mod `M `, unstaged mod ` M`, both `MM`, staged delete `D `, unstaged
delete ` D`, untracked `??`, rename `R ` (two NUL paths), and every conflict
code `DD AU UD UA DU AA UU`; plus monorepo prefix stripping and the
`MAX_STATUS_FILES` cap.

**Backend — `routes/git.integration.test.ts` (real git, no mocks):** using the
`release.integration.test.ts` harness pattern (`mkdtemp` + `execFileSync` git
init/config/commit), drive the routes via Fastify `app.inject`:
- `/git/changes` buckets: seed a staged file, an unstaged file, an untracked
  file → assert each lands in the right bucket with the right `type`.
- Produce a **real merge conflict** (two branches editing the same line, `git
  merge` fails) → assert the file appears in `conflicts`.
- `stage` then `unstage` a file → it moves buckets and back.
- `discard` a modified tracked file → worktree reverts (content == HEAD).
- `commit` with a message → staged set clears and HEAD advances (verified via
  `git log`). Empty message → 400.

This exercises the **public contract** end-to-end (goddev rule: touching an API
route requires the route test, not just a unit test).

**Frontend — `components/ChangesPanel.test.tsx` (RTL + mocked `api`):**
renders branch + three buckets from a mocked `getGitChanges`; **Stage** calls
`api.stageFile` then refetches; **Unstage** calls `api.unstageFile`; **Discard**
calls `window.confirm` (mocked) then `api.discardFile`; clicking a row calls
`onOpenDiff`; **Commit** is disabled with a blank message and calls
`api.commitChanges` when filled. Plus a `CodeEditor` test that the sidebar
defaults to Explorer and switches to the Changes panel on tab click.

**Full-suite gate:** entire backend (serial, to dodge the known tinypool flake)
and frontend suites green, minus the two pre-existing environmental godclaude
failures (`godclaude.test.ts` + `godclaude.integration.test.ts`), which are
unrelated to this change.

## Acceptance criteria

1. `GET /git/changes` returns correct staged / unstaged / conflict buckets +
   branch — proven by the integration test including a real merge conflict.
2. Stage / unstage / discard / commit mutate the repo correctly — proven by
   integration tests (files move buckets; discard reverts; commit advances HEAD).
3. Editor sidebar has Explorer|Changes tabs; Changes shows the branch and three
   buckets; clicking a file opens the existing Monaco side-by-side diff — proven
   by component tests and a real run in the packaged app after the next build.
4. Discard is guarded by a confirm dialog.
5. No push route exists anywhere in `git.ts`.
6. Both suites green (minus the known pre-existing godclaude pair).

## Files touched

**New:** `services/gitChanges.ts`, `services/gitChanges.test.ts`,
`routes/git.ts`, `routes/git.integration.test.ts`,
`components/ChangesPanel.tsx`, `components/ChangesPanel.test.tsx`,
`components/CodeEditor.test.tsx` (sidebar Explorer↔Changes tab toggle — no such
test file exists today).

**Modified:** `index.ts` (register `gitRoutes`), `components/CodeEditor.tsx`
(sidebar tabs + `onOpenDiff` + deleted-file diff), `api.ts`, `types.ts`,
`styles.css`.

**Untouched (deliberately):** `services/gitStatus.ts`, `routes/files.ts`
git endpoints.
