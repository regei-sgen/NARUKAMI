import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepoRoot } from './config';

describe('findRepoRoot', () => {
  it('walks up to the directory containing package-lock.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-root-'));
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}\n');
    const nested = path.join(root, 'packages', 'backend', 'src');
    fs.mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(root);
  });

  it('falls back to three levels up when no package-lock.json is found within 8 parents', () => {
    const orphan = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-orphan-')));
    // A path deep enough that none of the 8 walked parents hold package-lock.json.
    const deep = path.join(orphan, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i');
    fs.mkdirSync(deep, { recursive: true });
    // Asserts the ACTUAL fallback value, not just that it's a string.
    expect(findRepoRoot(deep)).toBe(path.resolve(deep, '..', '..', '..'));
  });
});
