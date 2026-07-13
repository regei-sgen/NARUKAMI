import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SGA_VERSION_FILES,
  VERSION_RE,
  bumpJsonVersion,
  bumpVersionMd,
  dirtyBeyondVersionFiles,
  ensureZipDir,
  extractUnreleased,
  fingerprintSga,
  localDateKey,
  readCurrentVersion,
  suggestNextVersion,
} from './release';

// Fixtures mirror the REAL SGA files (Documents/SGEN) so the surgical editors
// are proven against the exact shapes they'll meet in production.
const PACKAGE_JSON_FIXTURE = `{
  "name": "sgen-claude-chat-bridge",
  "version": "2.7.0",
  "private": true,
  "type": "module",
  "main": "server.js",
  "dependencies": {
    "some-lib": { "version": "9.9.9" }
  }
}
`;

const MANIFEST_FIXTURE = `{
  "manifest_version": 3,
  "name": "SGEN × Claude Chat",
  "description": "Floating Claude chat that drives the SGEN admin via your local Claude Code bridge.",
  "version": "2.7.0",
  "minimum_chrome_version": "116"
}
`;

const VERSION_MD_FIXTURE = `# Version

**Current:** \`2.7.0\` — 2026-07-01
**Main branch:** \`main\`

This file is the single source of truth.
`;

const CHANGELOG_FIXTURE = `# Changelog

All notable changes.

## [Unreleased]

### Changed

- **Media localize now uploads batches in PARALLEL.** Details here.

### Fixed

- **Conversation log no longer ships score (P2-083).** Details here.

## [2.7.0] — 2026-07-01

### Added

- Old release content that must NOT be extracted.
`;

describe('bumpJsonVersion', () => {
  it('replaces only the FIRST "version" occurrence in package.json', () => {
    const out = bumpJsonVersion(PACKAGE_JSON_FIXTURE, '2.7.1');
    expect(out).toContain('"version": "2.7.1"');
    expect(out).toContain('{ "version": "9.9.9" }'); // nested dependency untouched
    expect(out).toContain('"name": "sgen-claude-chat-bridge"');
  });

  it('bumps the manifest.json version field', () => {
    const out = bumpJsonVersion(MANIFEST_FIXTURE, '2.7.1');
    expect(out).toContain('"version": "2.7.1"');
    expect(out).toContain('"manifest_version": 3'); // untouched
    expect(out).not.toContain('"version": "2.7.0"');
  });

  it('never reformats the file — only the version substring changes', () => {
    const out = bumpJsonVersion(PACKAGE_JSON_FIXTURE, '3.0.0');
    expect(out.replace('"version": "3.0.0"', '"version": "2.7.0"')).toBe(PACKAGE_JSON_FIXTURE);
  });
});

describe('bumpVersionMd', () => {
  it('rewrites the header line with the new version + date (em dash preserved)', () => {
    const out = bumpVersionMd(VERSION_MD_FIXTURE, '2.7.1', '2026-07-12');
    expect(out).toContain('**Current:** `2.7.1` — 2026-07-12');
    expect(out).not.toContain('2.7.0');
    expect(out).toContain('**Main branch:** `main`'); // rest untouched
  });

  it('tolerates a hyphen separator variant', () => {
    const out = bumpVersionMd('**Current:** `1.0.0` - 2026-01-01\n', '1.0.1', '2026-07-12');
    expect(out).toContain('`1.0.1`');
    expect(out).toContain('2026-07-12');
  });
});

describe('version helpers', () => {
  it('suggestNextVersion bumps the patch segment', () => {
    expect(suggestNextVersion('2.7.0')).toBe('2.7.1');
    expect(suggestNextVersion('0.2.9')).toBe('0.2.10');
  });

  it('suggestNextVersion returns null on garbage', () => {
    expect(suggestNextVersion(null)).toBeNull();
    expect(suggestNextVersion('v2.7')).toBeNull();
    expect(suggestNextVersion('2.7.0-beta')).toBeNull();
  });

  it('VERSION_RE accepts x.y.z only', () => {
    expect(VERSION_RE.test('2.7.1')).toBe(true);
    expect(VERSION_RE.test('2.7')).toBe(false);
    expect(VERSION_RE.test('2.7.1.4')).toBe(false);
    expect(VERSION_RE.test('abc')).toBe(false);
  });

  it('localDateKey is YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 6, 12))).toBe('2026-07-12');
  });
});

describe('extractUnreleased', () => {
  it('returns only the [Unreleased] section body', () => {
    const out = extractUnreleased(CHANGELOG_FIXTURE);
    expect(out).toContain('Media localize now uploads batches in PARALLEL');
    expect(out).toContain('P2-083');
    expect(out).not.toContain('Old release content');
    expect(out).not.toContain('[Unreleased]');
  });

  it("returns '' when there is no [Unreleased] heading", () => {
    expect(extractUnreleased('# Changelog\n\n## [1.0.0]\n- stuff\n')).toBe('');
  });

  it('runs to EOF when [Unreleased] is the last section', () => {
    const out = extractUnreleased('# C\n\n## [Unreleased]\n\n- only entry\n');
    expect(out).toBe('- only entry');
  });
});

describe('dirtyBeyondVersionFiles', () => {
  it('exempts exactly the three version files', () => {
    const files = [
      { path: 'VERSION.md', status: 'modified' as const },
      { path: 'bridge/package.json', status: 'modified' as const },
      { path: 'extension/manifest.json', status: 'modified' as const },
      { path: 'bridge/server.js', status: 'modified' as const },
      { path: 'newfile.txt', status: 'added' as const },
    ];
    const out = dirtyBeyondVersionFiles(files);
    expect(out.map((f) => f.path)).toEqual(['bridge/server.js', 'newfile.txt']);
  });
});

describe('ensureZipDir', () => {
  it('creates a missing nested folder and returns the resolved path', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-ezd-'));
    const target = path.join(base, 'a', 'b', 'releases');
    try {
      expect(ensureZipDir(target)).toBe(path.resolve(target));
      expect(fs.statSync(target).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('accepts an existing folder', () => {
    expect(ensureZipDir(os.tmpdir())).toBe(path.resolve(os.tmpdir()));
  });

  it('rejects a relative or empty path', () => {
    expect(() => ensureZipDir('relative/folder')).toThrow(/absolute path/);
    expect(() => ensureZipDir('   ')).toThrow(/absolute path/);
  });

  it('rejects a path that points at a FILE', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-ezd-file-'));
    const filePath = path.join(base, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'x');
    try {
      expect(() => ensureZipDir(filePath)).toThrow(/file, not a folder/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('fingerprintSga + readCurrentVersion (temp dir)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-release-fp-'));
    fs.mkdirSync(path.join(dir, 'bridge'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'VERSION.md'), VERSION_MD_FIXTURE);
    fs.writeFileSync(path.join(dir, 'bridge', 'package.json'), PACKAGE_JSON_FIXTURE);
    fs.writeFileSync(path.join(dir, 'extension', 'manifest.json'), MANIFEST_FIXTURE);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('recognizes the SGA shape when all three files exist', () => {
    expect(fingerprintSga(dir)).toEqual({ isSga: true, missing: [] });
  });

  it('reports the missing files when the shape is wrong', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-release-notsga-'));
    try {
      const fp = fingerprintSga(other);
      expect(fp.isSga).toBe(false);
      expect(fp.missing).toEqual([...SGA_VERSION_FILES]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('reads the current version from bridge/package.json', () => {
    expect(readCurrentVersion(dir)).toBe('2.7.0');
  });

  it('returns null when bridge/package.json is absent or unparsable', () => {
    expect(readCurrentVersion(os.tmpdir())).toBeNull();
  });
});
