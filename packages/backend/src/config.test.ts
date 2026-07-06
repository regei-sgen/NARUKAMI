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

  it('returns a string fallback when no marker is found nearby', () => {
    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-orphan-'));
    expect(typeof findRepoRoot(orphan)).toBe('string');
  });
});
