import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../config';
import { getToken } from '../auth';
import { getBaseUrl } from './serverInfo';

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

/**
 * Write a per-run MCP config pointing Claude at the NARUKAMI bridge, and return
 * the `--mcp-config <path>` args to pass to `claude`. Returns [] (launch Claude
 * unchanged) when orchestration is disabled, the server URL isn't known yet, or
 * the bridge script can't be found — orchestration is best-effort, never fatal.
 *
 * The config is NOT strict: the user's own MCP servers still load alongside it.
 * `command` is this process's own binary; ELECTRON_RUN_AS_NODE makes a packaged
 * Electron binary behave as plain Node when it runs the bridge.
 */
export function buildClaudeMcpArgs(selfRunId: string): string[] {
  if (!orchestrationEnabled()) return [];

  const baseUrl = getBaseUrl();
  if (!baseUrl) return [];

  const bridge = locateBridge();
  if (!bridge) return [];

  let token: string;
  try {
    token = getToken();
  } catch {
    return [];
  }

  const config = {
    mcpServers: {
      narukami: {
        command: process.execPath,
        args: [bridge],
        env: {
          NARUKAMI_BASE_URL: baseUrl,
          NARUKAMI_TOKEN: token,
          NARUKAMI_SELF_RUN_ID: selfRunId,
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    },
  };

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const file = path.join(CONFIG_DIR, `${selfRunId}.json`);
    fs.writeFileSync(file, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
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
