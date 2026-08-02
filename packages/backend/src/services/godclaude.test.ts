import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectStatus,
  godClaudeDir,
  godHome,
  godSpawnEnv,
  isPayloadStale,
  isProvisioned,
  locateAssets,
  provision,
  sessionModes,
  setArmed,
  setMode,
  vendoredVersion,
} from './godclaude';

/**
 * Everything runs against a throwaway god home via NARUKAMI_GOD_HOME — the
 * native ~/.claude and the real ~/.narukami are never touched. Tests that shell
 * the vendored CLIs exercise the REAL godclaude scripts against the temp home.
 */

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-god-test-'));
  process.env.NARUKAMI_GOD_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.NARUKAMI_GOD_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('paths', () => {
  it('godHome honors NARUKAMI_GOD_HOME and godClaudeDir appends .claude', () => {
    expect(godHome()).toBe(tmpHome);
    expect(godClaudeDir()).toBe(path.join(tmpHome, '.claude'));
  });

  it('defaults to ~/.narukami/godclaude when the override is unset', () => {
    delete process.env.NARUKAMI_GOD_HOME;
    expect(godHome()).toBe(path.join(os.homedir(), '.narukami', 'godclaude'));
  });
});

describe('vendored assets', () => {
  it('locates the in-repo vendored assets with a version', () => {
    expect(locateAssets()).not.toBeNull();
    expect(vendoredVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the vendored payload carries a content hash stamped by scripts/hash-vendor-assets.mjs', () => {
    const assets = locateAssets();
    expect(assets).not.toBeNull();
    const vendor = JSON.parse(
      fs.readFileSync(path.join(assets as string, 'VENDOR.json'), 'utf8'),
    ) as { contentHash?: string };
    expect(vendor.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

/**
 * The staleness rule refreshIfProvisioned() runs at boot. `version` alone used
 * to be the whole key, which made an edit to a vendored hook invisible to every
 * already-provisioned user; the third case below is that exact bug.
 */
describe('isPayloadStale', () => {
  const HASH_A = 'sha256:' + 'a'.repeat(64);
  const HASH_B = 'sha256:' + 'b'.repeat(64);

  it('is not stale when version and content hash both match', () => {
    expect(
      isPayloadStale({ version: '1.7.3', contentHash: HASH_A }, { version: '1.7.3', contentHash: HASH_A }),
    ).toBe(false);
  });

  it('is stale when the version moved', () => {
    expect(
      isPayloadStale({ version: '1.7.3', contentHash: HASH_A }, { version: '1.8.0', contentHash: HASH_A }),
    ).toBe(true);
  });

  it('is stale when a vendored file changed but the version string did NOT', () => {
    expect(
      isPayloadStale({ version: '1.7.3', contentHash: HASH_A }, { version: '1.7.3', contentHash: HASH_B }),
    ).toBe(true);
  });

  it('treats an install predating the hash as stale exactly once', () => {
    expect(isPayloadStale({ version: '1.7.3' }, { version: '1.7.3', contentHash: HASH_A })).toBe(true);
    // …and after that refresh stamped the hash in, it settles.
    expect(
      isPayloadStale({ version: '1.7.3', contentHash: HASH_A }, { version: '1.7.3', contentHash: HASH_A }),
    ).toBe(false);
  });

  it('falls back to version-only when the vendored payload has no hash (fail-open)', () => {
    expect(isPayloadStale({ version: '1.7.3', contentHash: HASH_A }, { version: '1.7.3', contentHash: null })).toBe(
      false,
    );
    expect(isPayloadStale({ version: '1.7.3' }, { version: '1.8.0', contentHash: null })).toBe(true);
  });
});

describe('provision', () => {
  it('is not provisioned before install, and godSpawnEnv is empty (fail-open)', () => {
    expect(isProvisioned()).toBe(false);
    expect(godSpawnEnv()).toEqual({});
  });

  it('provisions the full layer into the god home and flips godSpawnEnv on', async () => {
    const res = await provision();
    expect(res.ok).toBe(true);
    expect(isProvisioned()).toBe(true);
    const dir = godClaudeDir();
    // the pieces the layer needs at runtime
    for (const f of [
      'hooks/godmode-gate.mjs',
      'hooks/godmode-mode.js',
      'hooks/godstate-core.js',
      'hooks/inject-deterministic-contract.js',
      'hooks/block-unverified-completion.js',
      'deterministic-contract.md',
      'godmode.mjs',
      'godmonitor.mjs',
      'modes/developer/contract.md',
      'modes/qa/gate.json',
    ]) {
      expect(fs.existsSync(path.join(dir, f)), `${f} missing`).toBe(true);
    }
    expect(godSpawnEnv()).toEqual({ DET_HOOKS_HOME: tmpHome });
  });

  it('records the vendored content hash in the install manifest', async () => {
    await provision();
    const installed = JSON.parse(
      fs.readFileSync(path.join(godClaudeDir(), 'narukami-godclaude.json'), 'utf8'),
    ) as { version?: string; contentHash?: string };
    expect(installed.version).toMatch(/^\d+\.\d+\.\d+$/);
    // Without this, refreshIfProvisioned() has nothing to compare and a hook
    // edit that leaves `version` untouched never reaches this home.
    expect(installed.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is idempotent and preserves state files across re-provision', async () => {
    await provision();
    const sentinel = path.join(godClaudeDir(), 'godmode-active');
    fs.writeFileSync(sentinel, 'enabled\n');
    const res = await provision();
    expect(res.ok).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});

describe('control plane (real vendored CLIs against the temp home)', () => {
  it('arms via sentinel and disarms via the CLI', async () => {
    await provision();
    const on = await setArmed(true);
    expect(on.ok).toBe(true);
    expect(fs.existsSync(path.join(godClaudeDir(), 'godmode-active'))).toBe(true);

    const off = await setArmed(false);
    expect(off.ok, off.output).toBe(true);
    expect(fs.existsSync(path.join(godClaudeDir(), 'godmode-active'))).toBe(false);
  }, 30_000);

  it('setMode switches the global mode (and arms), and status reflects it', async () => {
    await provision();
    const res = await setMode('godqa');
    expect(res.ok, res.output).toBe(true);

    const status = await collectStatus();
    expect(status.installed).toBe(true);
    expect(status.armed).toBe(true);
    expect(status.modes).toContain('qa');
  }, 30_000);

  it('setMode rejects a malformed mode name without shelling out', async () => {
    const res = await setMode('../evil');
    expect(res.ok).toBe(false);
  });

  it('setMode scopes to a session overlay with --session', async () => {
    await provision();
    const sid = '11111111-2222-3333-4444-555555555555';
    const res = await setMode('goddev', sid);
    expect(res.ok, res.output).toBe(true);
    expect(sessionModes(sid)).toContain('developer');
    // global mode untouched
    const status = await collectStatus();
    expect(status.modes).not.toContain('developer');
  }, 30_000);

  it('sessionModes rejects a path-traversal session id', () => {
    expect(sessionModes('../../etc')).toEqual([]);
  });
});

describe('collectStatus before install', () => {
  it('reports uninstalled with vendored version available', async () => {
    const status = await collectStatus();
    expect(status.installed).toBe(false);
    expect(status.armed).toBe(false);
    expect(status.vendoredVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.home).toBe(tmpHome);
  });
});
