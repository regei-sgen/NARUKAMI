import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../config';
import { getToken } from '../auth';
import { getBaseUrl } from './serverInfo';
import { codeGraphBin, codeGraphBinInstalled } from './codeGraph';

// Cross-terminal orchestration is on by default; set NARUKAMI_ORCHESTRATION=0 to
// disable (Claude sessions then launch without the terminal-control MCP tools).
function orchestrationEnabled(): boolean {
  return process.env.NARUKAMI_ORCHESTRATION !== '0';
}

/** Locate the stdio MCP bridge script across dev (src/dist) and packaged layouts. */
export function locateBridge(): string | null {
  // resourcesPath only exists under Electron; typed loosely so tsc is happy in Node.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath ?? '';
  const candidates = [
    path.join(REPO_ROOT, 'packages', 'backend', 'mcp-bridge.mjs'),
    path.resolve(__dirname, '..', '..', 'mcp-bridge.mjs'), // dist/services|src/services -> backend
    path.resolve(__dirname, '..', '..', '..', 'mcp-bridge.mjs'),
    ...(resourcesPath ? [path.join(resourcesPath, 'mcp-bridge.mjs')] : []), // packaged desktop
  ];
  for (const c of candidates) {
    try {
      if (c && fs.statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const CONFIG_DIR = path.join(os.tmpdir(), 'narukami-mcp');

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Assemble the `mcpServers` map from its already-resolved inputs. Pure (no I/O)
 * so the server-selection logic is directly unit-testable.
 *   - `narukami` (cross-terminal orchestration bridge) is added when its bridge
 *     script, server URL, and token are all present.
 *   - `codebase-memory` (the Code Map engine, run as a stdio MCP server — see
 *     `codebase-memory-mcp --help`) is added when `codeMapBin` is provided, so the
 *     session can query the project's structural graph on demand.
 */
export function assembleMcpServers(input: {
  execPath: string;
  bridge: string | null;
  baseUrl: string | null;
  token: string | null;
  selfRunId: string;
  codeMapBin: string | null;
}): Record<string, McpServerEntry> {
  const servers: Record<string, McpServerEntry> = {};
  if (input.bridge && input.baseUrl && input.token) {
    servers.narukami = {
      command: input.execPath,
      args: [input.bridge],
      env: {
        NARUKAMI_BASE_URL: input.baseUrl,
        NARUKAMI_TOKEN: input.token,
        NARUKAMI_SELF_RUN_ID: input.selfRunId,
        ELECTRON_RUN_AS_NODE: '1',
      },
    };
  }
  if (input.codeMapBin) {
    servers['codebase-memory'] = { command: input.codeMapBin, args: [] };
  }
  return servers;
}

/**
 * Write a per-run MCP config for `claude` and return the `--mcp-config <path>`
 * args. Returns [] (launch Claude unchanged) when there is nothing to attach.
 * Best-effort, never fatal.
 *
 * The config is NOT strict: the user's own MCP servers still load alongside it.
 * `opts.codeMap` attaches the Code Map engine (codebase-memory-mcp) so this
 * session can inspect the project's codebase graph on demand — enabled per
 * project via the CodeMap "Embed in Claude" toggle.
 */
export function buildClaudeMcpArgs(selfRunId: string, opts: { codeMap?: boolean } = {}): string[] {
  const wantNarukami = orchestrationEnabled();
  const bridge = wantNarukami ? locateBridge() : null;
  const baseUrl = wantNarukami ? getBaseUrl() : null;
  let token: string | null = null;
  if (wantNarukami) {
    try {
      token = getToken();
    } catch {
      token = null;
    }
  }

  // Only attach the Code Map server when embed is requested AND the engine binary
  // is actually installed — otherwise Claude would get a server that can't start.
  const codeMapBin = opts.codeMap && codeGraphBinInstalled() ? codeGraphBin() : null;

  const servers = assembleMcpServers({
    execPath: process.execPath,
    bridge,
    baseUrl,
    token,
    selfRunId,
    codeMapBin,
  });
  if (Object.keys(servers).length === 0) return [];

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const file = path.join(CONFIG_DIR, `${selfRunId}.json`);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { encoding: 'utf8', mode: 0o600 });
    return ['--mcp-config', file];
  } catch {
    return [];
  }
}

/**
 * Delete the per-run MCP config for a run that has ended. These files embed the
 * live bearer token, so they must not accumulate in the shared temp dir for the
 * machine's lifetime. Best-effort — a missing file is fine.
 */
export function cleanupMcpConfig(selfRunId: string): void {
  try {
    fs.rmSync(path.join(CONFIG_DIR, `${selfRunId}.json`), { force: true });
  } catch {
    /* already gone — ignore */
  }
}

/**
 * On boot, remove the entire config dir: any files left there belong to a prior
 * session whose Claude processes are dead, and they still hold a stale token.
 */
export function sweepMcpConfigs(): void {
  try {
    fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  } catch {
    /* nothing to sweep — ignore */
  }
}
