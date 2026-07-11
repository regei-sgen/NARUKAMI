// Sync guards: the frontend's hardcoded mode/kami copies must not drift from
// the vendored godclaude assets they are distilled from. Reads the REAL asset
// tree (node:fs — vitest runs in node even under the jsdom environment).
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG } from './panels/ModeCatalog';
import { KAMI } from './lib';

// This file lives at packages/frontend/src/components/argus — the repo root is
// five levels up. Anchored on import.meta.url so the test does not depend on
// the directory vitest was launched from.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const assetsDir = join(repoRoot, 'packages', 'backend', 'godclaude-assets');
const modesDir = join(assetsDir, 'modes');
const hookFile = join(assetsDir, 'hooks', 'godmode-mode.js');

/** Fail loudly with the expected path — never silently skip a missing asset tree. */
function mustExist(path: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `vendored godclaude asset not found at ${path} — kami-sync needs the real ` +
        'packages/backend/godclaude-assets tree to guard the frontend copies against drift',
    );
  }
}

function modeDirs(): string[] {
  mustExist(modesDir);
  return readdirSync(modesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

describe('ModeCatalog CATALOG ↔ vendored mode contracts', () => {
  it('lists exactly general + every directory under godclaude-assets/modes', () => {
    const expected = ['general', ...modeDirs()].sort();
    expect(CATALOG.map((m) => m.id).sort()).toEqual(expected);
  });

  it('shows the trigger named in each mode contract.md header', () => {
    for (const mode of modeDirs()) {
      const contract = join(modesDir, mode, 'contract.md');
      mustExist(contract);
      // Header shape: "# Deterministic Operating Contract — <mode> mode (goddev) · Kami"
      const header = readFileSync(contract, 'utf8').split('\n')[0];
      const match = header.match(/\((\w[\w-]*)\)/);
      expect(match, `no (trigger) in ${mode} contract header: "${header}"`).not.toBeNull();
      const entry = CATALOG.find((c) => c.id === mode);
      expect(entry, `CATALOG has no entry for mode "${mode}"`).toBeDefined();
      expect(entry!.trigger, `CATALOG trigger for "${mode}" drifted from its contract`).toBe(
        `/${match![1]}`,
      );
    }
  });

  it('presents general as the base layer, not a slash trigger', () => {
    expect(CATALOG.find((c) => c.id === 'general')?.trigger).toBe('base layer');
  });
});

describe('frontend KAMI map ↔ assets GODNAME map', () => {
  it('matches the GODNAME literal in godmode-mode.js exactly', () => {
    mustExist(hookFile);
    const src = readFileSync(hookFile, 'utf8');
    const block = src.match(/const GODNAME = \{([\s\S]*?)\};/);
    expect(block, `no GODNAME object literal found in ${hookFile}`).not.toBeNull();
    const parsed: Record<string, string> = {};
    for (const m of block![1].matchAll(/'?([\w-]+)'?\s*:\s*'([^']+)'/g)) {
      parsed[m[1]] = m[2];
    }
    // Prove the text extraction actually captured the map (visible in run output).
    console.log('parsed GODNAME from godmode-mode.js:', parsed);
    expect(Object.keys(parsed)).toHaveLength(9);
    expect(KAMI).toEqual(parsed);
  });
});
