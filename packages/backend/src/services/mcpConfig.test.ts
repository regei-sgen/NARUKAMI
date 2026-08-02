import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleMcpServers, buildClaudeMcpArgs, cleanupMcpConfig } from './mcpConfig';

// The bridge is a standalone ESM stdio server, so its end-to-end suite lives
// beside it at packages/backend/mcp-bridge.test.mjs. vitest.config.ts collects
// `src/**/*.test.ts` only, so that file would never run on its own — this
// side-effect import is what puts it in `npm run test:unit`. It belongs here
// because this module is what attaches the bridge in the first place.
import '../../mcp-bridge.test.mjs';

// buildClaudeMcpArgs reads the live server URL + token. Stub both so the
// orchestration switch is the ONLY thing that differs between the two cases
// below — without this, an un-bound server would make both of them return [].
vi.mock('./serverInfo', () => ({ getBaseUrl: () => 'http://127.0.0.1:4321' }));
vi.mock('../auth', () => ({ getToken: () => 'unit-test-token' }));

describe('assembleMcpServers', () => {
  const base = {
    execPath: '/node',
    bridge: '/bridge.mjs' as string | null,
    baseUrl: 'http://127.0.0.1:1' as string | null,
    token: 'tok' as string | null,
    selfRunId: 'r1',
  };

  it('includes narukami when the bridge/url/token are all present', () => {
    const s = assembleMcpServers(base);
    expect(Object.keys(s)).toEqual(['narukami']);
    expect(s.narukami.command).toBe('/node');
    expect(s.narukami.args).toEqual(['/bridge.mjs']);
    expect(s.narukami.env?.NARUKAMI_SELF_RUN_ID).toBe('r1');
  });

  it('omits narukami when the bridge is missing', () => {
    expect(assembleMcpServers({ ...base, bridge: null })).toEqual({});
  });

  it('omits narukami when the token is missing', () => {
    expect(assembleMcpServers({ ...base, token: null })).toEqual({});
  });

  it('returns an empty map when there is nothing to attach', () => {
    expect(assembleMcpServers({ ...base, bridge: null, token: null })).toEqual({});
  });
});

describe('buildClaudeMcpArgs / NARUKAMI_ORCHESTRATION kill switch', () => {
  const prior = process.env.NARUKAMI_ORCHESTRATION;

  afterEach(() => {
    if (prior === undefined) delete process.env.NARUKAMI_ORCHESTRATION;
    else process.env.NARUKAMI_ORCHESTRATION = prior;
    cleanupMcpConfig('kill-switch-test');
  });

  it('attaches the bridge by default, so the Claude tab gets the terminal tools', () => {
    delete process.env.NARUKAMI_ORCHESTRATION;
    const args = buildClaudeMcpArgs('kill-switch-test');
    expect(args[0]).toBe('--mcp-config');

    // The switch is enforced by NOT WRITING this file, so what it contains is
    // the whole surface it gates: one `narukami` server pointing at the bridge
    // script. Every tool the bridge exposes — the original three and the four
    // orchestration tools added later — arrives through this single entry, so
    // there is nothing per-tool to gate separately.
    const cfg = JSON.parse(fs.readFileSync(args[1], 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(Object.keys(cfg.mcpServers)).toEqual(['narukami']);
    expect(cfg.mcpServers.narukami.args[0]).toMatch(/mcp-bridge\.mjs$/);
  });

  it('attaches nothing at all when NARUKAMI_ORCHESTRATION=0', () => {
    process.env.NARUKAMI_ORCHESTRATION = '0';
    expect(buildClaudeMcpArgs('kill-switch-test')).toEqual([]);
  });
});
