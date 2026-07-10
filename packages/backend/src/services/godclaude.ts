import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT } from '../config';
import { collectSessions, readUsage, type ArgusSessions, type GodStats, type Usage } from './argus';

const execFileAsync = promisify(execFile);

/**
 * NARUKAMI's own embedded GODCLAUDE instance — separate from the user's native
 * install under ~/.claude.
 *
 * The GODCLAUDE layer resolves ALL of its state, contracts, modes, and logs from
 * `DET_HOOKS_HOME || os.homedir()` (verified across every script in the layer),
 * and hook processes inherit the environment of the terminal that spawned
 * `claude`. So NARUKAMI:
 *
 *   1. provisions its own god home at `~/.narukami/godclaude/.claude/` from the
 *      assets vendored in-repo (packages/backend/godclaude-assets/), and
 *   2. sets `DET_HOOKS_HOME=<godHome>` on every process it spawns (ptys, admin
 *      shells, headless `claude -p`).
 *
 * Inside NARUKAMI sessions the (natively wired) hook code then reads NARUKAMI's
 * armed/mode/contract state; native terminal sessions keep using ~/.claude.
 * This module never reads from or writes to the native ~/.claude except one
 * read-only wiring check in `nativeWiring()`.
 */

/** Root of NARUKAMI's god home (the value handed to DET_HOOKS_HOME). */
export function godHome(): string {
  return process.env.NARUKAMI_GOD_HOME ?? path.join(os.homedir(), '.narukami', 'godclaude');
}

/** The `.claude` state tree inside the god home (the layer appends `/.claude` itself). */
export function godClaudeDir(): string {
  return path.join(godHome(), '.claude');
}

const MANIFEST = 'narukami-godclaude.json';

/** Locate the vendored godclaude assets across dev (src/dist) and packaged layouts. */
export function locateAssets(): string | null {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath ?? '';
  const candidates = [
    path.join(REPO_ROOT, 'packages', 'backend', 'godclaude-assets'),
    path.resolve(__dirname, '..', '..', 'godclaude-assets'), // dist/services|src/services -> backend
    path.resolve(__dirname, '..', '..', '..', 'godclaude-assets'),
    ...(resourcesPath ? [path.join(resourcesPath, 'godclaude-assets')] : []), // packaged desktop
  ];
  for (const c of candidates) {
    try {
      if (c && fs.statSync(path.join(c, 'VENDOR.json')).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

interface VendorManifest {
  version?: string;
  vendoredAt?: string;
  files?: string[];
  dirs?: string[];
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Version of the assets shipped with this build ('unknown' when unstated, null when absent). */
export function vendoredVersion(): string | null {
  const assets = locateAssets();
  if (!assets) return null;
  return readJson<VendorManifest>(path.join(assets, 'VENDOR.json'))?.version ?? 'unknown';
}

interface InstallManifest {
  version: string;
  provisionedAt: string;
  assetsFrom: string;
}

function installedManifest(): InstallManifest | null {
  return readJson<InstallManifest>(path.join(godClaudeDir(), MANIFEST));
}

/** Provisioned = manifest present AND the gate wrapper actually on disk. */
export function isProvisioned(): boolean {
  return (
    installedManifest() != null &&
    fs.existsSync(path.join(godClaudeDir(), 'hooks', 'godmode-gate.mjs'))
  );
}

/**
 * Copy the vendored assets into the god home (idempotent overwrite; state files
 * like the armed sentinel, logs, and session overlays are untouched because the
 * copy only writes asset paths). Never touches the native ~/.claude.
 */
export async function provision(): Promise<{ ok: boolean; error?: string }> {
  const assets = locateAssets();
  if (!assets) return { ok: false, error: 'vendored godclaude assets not found in this build' };
  const vendor = readJson<VendorManifest>(path.join(assets, 'VENDOR.json'));
  const dir = godClaudeDir();
  // Windows: a copy can transiently fail (EBUSY/EPERM) while an AV scanner or
  // another process touches a file — retry each entry briefly before giving up.
  const copyRetry = async (fn: () => Promise<void>): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
  };
  try {
    await fsp.mkdir(dir, { recursive: true });
    for (const f of vendor?.files ?? []) {
      await copyRetry(() => fsp.copyFile(path.join(assets, f), path.join(dir, f)));
    }
    for (const d of vendor?.dirs ?? []) {
      await copyRetry(() =>
        fsp.cp(path.join(assets, d), path.join(dir, d), { recursive: true, force: true }),
      );
    }
    const manifest: InstallManifest = {
      version: vendor?.version ?? 'unknown',
      provisionedAt: new Date().toISOString(),
      assetsFrom: assets.replace(/\\/g, '/'),
    };
    await fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** At boot: refresh an EXISTING install's assets when the vendored version moved. Best-effort. */
export async function refreshIfProvisioned(): Promise<void> {
  try {
    const installed = installedManifest();
    if (!installed) return; // never auto-install — that's the user's click
    const vendored = vendoredVersion();
    if (vendored && vendored !== installed.version) await provision();
  } catch {
    /* boot must not fail on this */
  }
}

/**
 * Extra env for every process NARUKAMI spawns: point the GODCLAUDE layer's state
 * home at NARUKAMI's own god home. Empty until provisioned, so an uninstalled
 * embedded godclaude changes nothing about spawned sessions (fail-open).
 */
export function godSpawnEnv(): Record<string, string> {
  return isProvisioned() ? { DET_HOOKS_HOME: godHome() } : {};
}

// ── control plane (shell NARUKAMI's own vendored CLIs — authoritative) ──────

const CLI_TIMEOUT_MS = 15_000;

/**
 * Run one of the embedded god CLIs against the EMBEDDED home. DET_HOOKS_HOME is
 * set explicitly (the scripts resolve state from it, not from their own path) and
 * any inherited CLAUDE_CODE_SESSION_ID is dropped so a backend launched from
 * inside a Claude session can't accidentally scope a global command to that
 * session's overlay.
 */
async function runGodCli(
  script: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  const scriptPath = path.join(godClaudeDir(), script);
  const env: Record<string, string | undefined> = {
    ...process.env,
    DET_HOOKS_HOME: godHome(),
    ELECTRON_RUN_AS_NODE: '1',
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
      env,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    return { ok: false, output: (`${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message) };
  }
}

/** Canonical + alias mode names the UI may send. The CLI is the real validator. */
const MODE_NAME = /^[a-z][a-z0-9-]{1,31}$/;

export async function setMode(
  mode: string,
  sessionId?: string,
): Promise<{ ok: boolean; output: string }> {
  if (!MODE_NAME.test(mode)) return { ok: false, output: `invalid mode name "${mode}"` };
  if (sessionId && !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return { ok: false, output: 'invalid session id' };
  }
  const args = sessionId ? [mode, '--session', sessionId] : [mode, '--global'];
  return runGodCli('godmode.mjs', args);
}

/**
 * Arm without clobbering the remembered mode: the global armed state IS the
 * sentinel file (godstate-core `armed()` checks its existence), so arming writes
 * it directly — running `godmode.mjs general` instead would RESET the mode.
 * Disarm goes through the CLI (`off`) so the explicit pin clears properly too.
 */
export async function setArmed(on: boolean): Promise<{ ok: boolean; output: string }> {
  if (on) {
    try {
      await fsp.mkdir(godClaudeDir(), { recursive: true });
      await fsp.writeFile(path.join(godClaudeDir(), 'godmode-active'), 'enabled\n');
      return { ok: true, output: 'GODCLAUDE armed (embedded).' };
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  }
  return runGodCli('godmode.mjs', ['off']);
}

export async function setAutopilot(on: boolean): Promise<{ ok: boolean; output: string }> {
  return runGodCli('godmode.mjs', ['autopilot', on ? 'on' : 'off']);
}

// ── status ───────────────────────────────────────────────────────────────────

/** Global mode list from the embedded home (empty/`general` filtered out). */
function globalModes(): string[] {
  try {
    return fs
      .readFileSync(path.join(godClaudeDir(), 'godmode-mode'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== 'general');
  } catch {
    return [];
  }
}

/** Mode overlay for one NARUKAMI-launched Claude session (embedded home). */
export function sessionModes(sessionId: string): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return [];
  try {
    return fs
      .readFileSync(path.join(godClaudeDir(), 'godmode-sessions', sessionId, 'mode'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== 'general');
  } catch {
    return [];
  }
}

// Session-overlay OFF values — mirrors godstate-core's tri-state contents (an
// overlay `active` file whose content is one of these means OFF for that
// session; any other content means ON; no file falls back to the global sentinel).
const OVERLAY_OFF = new Set(['off', '0', 'false', 'no', 'disable', 'disabled']);

/**
 * Is the embedded layer active for ONE session? Same resolution godstate-core's
 * `armed(home, sid)` uses: session overlay decides by content when present,
 * else the global sentinel's existence.
 */
export function sessionGodActive(sessionId: string): boolean {
  if (!isProvisioned()) return false;
  if (/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    try {
      const raw = fs
        .readFileSync(path.join(godClaudeDir(), 'godmode-sessions', sessionId, 'active'), 'utf8')
        .trim()
        .toLowerCase();
      return !OVERLAY_OFF.has(raw);
    } catch {
      /* no overlay — fall through to global */
    }
  }
  return fs.existsSync(path.join(godClaudeDir(), 'godmode-active'));
}

/**
 * Toggle the embedded layer for ONE session (the terminal-toolbar "god" toggle).
 * ON writes the overlay directly (content 'enabled', same as the CLI's
 * ensureArmed); OFF goes through the CLI (`off --session`) so the session's
 * explicit pin clears too. Gate + per-turn reminder pick it up on the session's
 * NEXT turn — the mid-session semantics of the god layer itself.
 */
export async function setSessionArmed(
  sessionId: string,
  on: boolean,
): Promise<{ ok: boolean; output: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return { ok: false, output: 'invalid session id' };
  if (on) {
    try {
      const dir = path.join(godClaudeDir(), 'godmode-sessions', sessionId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'active'), 'enabled\n');
      return { ok: true, output: `GODCLAUDE active for session ${sessionId.slice(0, 8)} (embedded).` };
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  }
  return runGodCli('godmode.mjs', ['off', '--session', sessionId]);
}

export interface NativeWiring {
  /** godmode-gate entries found in the native ~/.claude/settings.json (read-only check) */
  settingsWired: boolean;
  /** native gate wrapper present on disk */
  hooksPresent: boolean;
}

/**
 * The embedded layer's hooks FIRE through the wiring in the native
 * ~/.claude/settings.json (hook wiring is Claude-config-scoped; NARUKAMI
 * deliberately never writes there). Detect — read-only — whether that wiring
 * exists so the UI can say "install godclaude natively to wire hooks" instead
 * of silently doing nothing.
 */
export function nativeWiring(): NativeWiring {
  const home = os.homedir();
  let settingsWired = false;
  try {
    settingsWired = fs
      .readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')
      .includes('godmode-gate.mjs');
  } catch {
    /* not wired */
  }
  const hooksPresent = fs.existsSync(path.join(home, '.claude', 'hooks', 'godmode-gate.mjs'));
  return { settingsWired, hooksPresent };
}

/** godmonitor.mjs --json → health/modes/activity/heartbeats/routing (embedded home). */
interface GodMonitorSnapshot {
  health: Record<string, unknown>;
  modes: Array<Record<string, unknown>>;
  activity: Record<string, { allow: number; block: number }>;
  heartbeats: Array<Record<string, unknown>>;
  routing: Record<string, unknown>;
}

let healthCache: { t: number; v: GodMonitorSnapshot | null } | null = null;

async function readHealth(): Promise<GodMonitorSnapshot | null> {
  // 10s TTL: every miss SPAWNS a node child (godmonitor.mjs) — expensive on
  // Windows — and the dashboard poll doesn't need sub-10s health freshness.
  if (healthCache && Date.now() - healthCache.t < 10_000) return healthCache.v;
  let v: GodMonitorSnapshot | null = null;
  if (isProvisioned()) {
    const res = await runGodCli('godmonitor.mjs', ['--json']);
    if (res.ok) {
      try {
        v = JSON.parse(res.output) as GodMonitorSnapshot;
      } catch {
        v = null;
      }
    }
  }
  healthCache = { t: Date.now(), v };
  return v;
}

let statsCache: { t: number; v: GodStats | null } | null = null;

/** godmode-stats.mjs --json against the EMBEDDED home (perf/gate aggregates). */
async function readStats(): Promise<GodStats | null> {
  if (statsCache && Date.now() - statsCache.t < 30_000) return statsCache.v;
  let v: GodStats | null = null;
  if (isProvisioned()) {
    const res = await runGodCli('godmode-stats.mjs', ['--json']);
    if (res.ok) {
      try {
        v = JSON.parse(res.output) as GodStats;
      } catch {
        v = null;
      }
    }
  }
  statsCache = { t: Date.now(), v };
  return v;
}

export interface EmbeddedGodStatus {
  ok: boolean;
  ts: string;
  home: string;
  installed: boolean;
  installedVersion: string | null;
  vendoredVersion: string | null;
  armed: boolean;
  autopilot: boolean;
  modes: string[];
  nativeWiring: NativeWiring;
  health: Record<string, unknown> | null;
  monitorModes: Array<Record<string, unknown>>;
  activity: Record<string, { allow: number; block: number }>;
  heartbeats: Array<Record<string, unknown>>;
  routing: Record<string, unknown> | null;
  /** perf/gate aggregates of the EMBEDDED home */
  stats: GodStats | null;
  /** NARUKAMI-launched Claude sessions only, modes from the embedded overlay */
  sessions: ArgusSessions;
  /** account-wide rate limits (written to the native ~/.claude by the usage collector) */
  usage: Usage | null;
}

/**
 * The full embedded-instance snapshot the GODCLAUDE tab polls. `narukamiIds`
 * (session ids this NARUKAMI launched) scopes the fleet: Claude Code's session
 * registry is machine-global, so without ids the fleet is empty rather than
 * leaking native sessions into NARUKAMI's view.
 */
export async function collectStatus(narukamiIds?: ReadonlySet<string>): Promise<EmbeddedGodStatus> {
  const installed = isProvisioned();
  const [snap, stats, allSessions, usage] = await Promise.all([
    readHealth(),
    readStats(),
    narukamiIds ? collectSessions(Date.now(), narukamiIds, godClaudeDir()) : null,
    readUsage(),
  ]);
  const items = (allSessions?.items ?? []).filter((s) => s.origin === 'narukami');
  return {
    ok: true,
    ts: new Date().toISOString(),
    home: godHome(),
    installed,
    installedVersion: installedManifest()?.version ?? null,
    vendoredVersion: vendoredVersion(),
    armed: installed && fs.existsSync(path.join(godClaudeDir(), 'godmode-active')),
    autopilot: installed && fs.existsSync(path.join(godClaudeDir(), 'godmode-autosession')),
    modes: globalModes(),
    nativeWiring: nativeWiring(),
    health: snap?.health ?? null,
    monitorModes: snap?.modes ?? [],
    activity: snap?.activity ?? {},
    heartbeats: snap?.heartbeats ?? [],
    routing: snap?.routing ?? null,
    stats,
    sessions: {
      count: items.length,
      live: items.filter((s) => s.state === 'live').length,
      items,
    },
    usage,
  };
}
