import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pins the wiring between the AI-provider setting and the process NARUKAMI
 * actually spawns: an armed API key must land in the pty env of a `claude`
 * launch, and must NOT leak into project commands or plain shells.
 *
 * The unit tests in aiProvider.test.ts prove the config→env derivation; this one
 * proves the derived env is really handed to node-pty.
 */

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: h.spawn,
}));

vi.mock('../db', () => ({
  prisma: {
    appSetting: { findUnique: h.findUnique, upsert: h.upsert },
    runLog: { createMany: vi.fn() },
    run: { update: vi.fn() },
  },
}));

// Keep the launch hermetic: no MCP config files, no godclaude overlay.
vi.mock('./mcpConfig', () => ({ buildClaudeMcpArgs: () => [], cleanupMcpConfig: () => {} }));
vi.mock('./godclaude', () => ({ godSpawnEnv: () => ({}) }));
// resolveExecutable would hit the real PATH — pin it so the test doesn't depend
// on whether Claude Code happens to be installed on the machine running it.
vi.mock('./exec', () => ({
  resolveExecutable: (name: string) => `C:\\bin\\${name}.exe`,
  wrapForWindows: (file: string, args: string[]) => ({ file, args }),
}));

import { DEFAULT_AI_CONFIG, setCachedAiConfig } from './aiProvider';
import { startClaude, startRun, startShell } from './runner';

const KEY = 'sk-ant-api03-abcdefghijklmnop1234';

/** The env node-pty was handed on the most recent spawn. */
function lastSpawnEnv(): Record<string, string> {
  const call = h.spawn.mock.calls.at(-1);
  return (call?.[2] as { env: Record<string, string> }).env;
}

beforeEach(() => {
  h.spawn.mockReset();
  h.spawn.mockImplementation(() => ({
    pid: 4242,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  }));
  setCachedAiConfig({ ...DEFAULT_AI_CONFIG });
});

describe('startClaude env', () => {
  it('injects NOTHING in the default claude-code mode', () => {
    startClaude({ runId: 'r1', cwd: 'C:\\proj' });
    const env = lastSpawnEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('hands the configured key (and base URL) to the pty in api-key mode', () => {
    setCachedAiConfig({
      provider: 'api-key',
      apiKey: KEY,
      baseUrl: 'https://gw.example.com',
      defaultEffort: 'high',
    });
    startClaude({ runId: 'r2', cwd: 'C:\\proj' });
    const env = lastSpawnEnv();
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com');
  });
});

describe('non-Claude spawns', () => {
  beforeEach(() => {
    setCachedAiConfig({
      provider: 'api-key',
      apiKey: KEY,
      baseUrl: '',
      defaultEffort: 'high',
    });
  });

  it('never leaks the key into a project command', () => {
    startRun({ runId: 'r3', command: 'npm run dev', cwd: 'C:\\proj' });
    expect(lastSpawnEnv().ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('never leaks the key into a plain shell', () => {
    startShell({ runId: 'r4', cwd: 'C:\\proj' });
    expect(lastSpawnEnv().ANTHROPIC_API_KEY).toBeUndefined();
  });
});
