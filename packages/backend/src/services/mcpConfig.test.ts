import { describe, it, expect } from 'vitest';
import { assembleMcpServers } from './mcpConfig';

describe('assembleMcpServers', () => {
  const base = {
    execPath: '/node',
    bridge: '/bridge.mjs' as string | null,
    baseUrl: 'http://127.0.0.1:1' as string | null,
    token: 'tok' as string | null,
    selfRunId: 'r1',
    codeMapBin: null as string | null,
  };

  it('includes only narukami when the bridge/url/token are present and no code map', () => {
    const s = assembleMcpServers(base);
    expect(Object.keys(s)).toEqual(['narukami']);
    expect(s.narukami.command).toBe('/node');
    expect(s.narukami.args).toEqual(['/bridge.mjs']);
    expect(s.narukami.env?.NARUKAMI_SELF_RUN_ID).toBe('r1');
    expect(s['codebase-memory']).toBeUndefined();
  });

  it('adds codebase-memory as a stdio server (no args) when codeMapBin is provided', () => {
    const s = assembleMcpServers({ ...base, codeMapBin: 'C:/bin/codebase-memory-mcp.exe' });
    expect(Object.keys(s).sort()).toEqual(['codebase-memory', 'narukami']);
    expect(s['codebase-memory']).toEqual({ command: 'C:/bin/codebase-memory-mcp.exe', args: [] });
  });

  it('omits narukami when the bridge is missing but still attaches the code map', () => {
    const s = assembleMcpServers({ ...base, bridge: null, codeMapBin: '/cm' });
    expect(Object.keys(s)).toEqual(['codebase-memory']);
  });

  it('returns an empty map when there is nothing to attach', () => {
    expect(assembleMcpServers({ ...base, bridge: null, token: null, codeMapBin: null })).toEqual({});
  });
});
