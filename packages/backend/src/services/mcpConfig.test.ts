import { describe, it, expect } from 'vitest';
import { assembleMcpServers } from './mcpConfig';

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
