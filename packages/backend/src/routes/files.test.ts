import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInProject } from './files';

// The path jail (resolveInProject) is the core arbitrary-read/write security
// control for the built-in editor. It previously had ZERO test coverage.
let root: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-jail-')));
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'hi');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveInProject (path jail)', () => {
  it('resolves a contained relative path', () => {
    expect(resolveInProject(root, 'sub/a.txt')).toBe(path.join(root, 'sub', 'a.txt'));
  });

  it('treats a leading-slash "absolute" path as relative to the root', () => {
    expect(resolveInProject(root, '/sub/a.txt')).toBe(path.join(root, 'sub', 'a.txt'));
    expect(resolveInProject(root, '\\sub\\a.txt')).toBe(path.join(root, 'sub', 'a.txt'));
  });

  it('rejects .. traversal that escapes the root', () => {
    expect(() => resolveInProject(root, '../outside.txt')).toThrow(/escapes/i);
    expect(() => resolveInProject(root, 'sub/../../outside.txt')).toThrow(/escapes/i);
  });

  it('allows a not-yet-existing file inside the root (new file)', () => {
    expect(resolveInProject(root, 'sub/new.txt')).toBe(path.join(root, 'sub', 'new.txt'));
  });

  it('allows the root itself', () => {
    expect(resolveInProject(root, '')).toBe(root);
  });
});
