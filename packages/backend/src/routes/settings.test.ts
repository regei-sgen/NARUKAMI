import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: { appSetting: { findUnique: h.findUnique, upsert: h.upsert } },
}));

import { settingsRoutes } from './settings';
import { AI_SETTING_KEY, DEFAULT_EFFORT, claudeSpawnEnv } from '../services/aiProvider';

const KEY = 'sk-ant-api03-abcdefghijklmnop1234';

function stubLogger() {
  const log = {
    fatal: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, error: () => {},
    child: () => log,
  };
  return log;
}

/** The stored row as Prisma would return it. */
function row(over: Record<string, unknown> = {}) {
  return {
    value: JSON.stringify({
      provider: 'claude-code',
      apiKey: '',
      baseUrl: '',
      defaultEffort: DEFAULT_EFFORT,
      ...over,
    }),
  };
}

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ loggerInstance: stubLogger() as unknown as FastifyBaseLogger });
  await app.register(settingsRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.findUnique.mockReset().mockResolvedValue(null);
  h.upsert.mockReset().mockResolvedValue({});
});

describe('GET /api/settings/ai', () => {
  it('defaults to the Claude Code login with no key configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/ai' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      provider: 'claude-code',
      hasKey: false,
      keyPreview: '',
      defaultEffort: DEFAULT_EFFORT,
    });
  });

  it('returns a masked preview, never the stored key', async () => {
    h.findUnique.mockResolvedValue(row({ provider: 'api-key', apiKey: KEY }));
    const res = await app.inject({ method: 'GET', url: '/api/settings/ai' });
    expect(res.payload).not.toContain(KEY);
    expect(res.json()).toMatchObject({ provider: 'api-key', hasKey: true, effective: 'api-key' });
    expect(res.json().keyPreview).toContain('…');
  });
});

describe('POST /api/settings/ai', () => {
  it('saves a key, switches provider, and arms the spawn env', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/ai',
      payload: { provider: 'api-key', apiKey: KEY, baseUrl: 'https://gw.example.com/' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(KEY);
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: AI_SETTING_KEY } }));
    // trailing slash normalised on the way in
    expect(res.json().baseUrl).toBe('https://gw.example.com');
    expect(claudeSpawnEnv()).toEqual({
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
    });
  });

  it('rejects api-key mode with no key (400, nothing written)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/ai',
      payload: { provider: 'api-key' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/API key/i);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('rejects a malformed base URL (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/ai',
      payload: { baseUrl: 'gateway.example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('changes the default effort without touching the stored key', async () => {
    h.findUnique.mockResolvedValue(row({ provider: 'api-key', apiKey: KEY }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/ai',
      payload: { defaultEffort: 'high' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ defaultEffort: 'high', hasKey: true, provider: 'api-key' });
  });
});

describe('DELETE /api/settings/ai/key', () => {
  it('forgets the key and falls back to the Claude Code login', async () => {
    h.findUnique.mockResolvedValue(row({ provider: 'api-key', apiKey: KEY }));
    const res = await app.inject({ method: 'DELETE', url: '/api/settings/ai/key' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: 'claude-code', hasKey: false, keyPreview: '' });
    expect(claudeSpawnEnv()).toEqual({});
  });
});

describe('GET /api/settings/about', () => {
  it('reports read-only diagnostics', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/about' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.platform).toBe(process.platform);
    expect(body.node).toBe(process.versions.node);
    expect(typeof body.godHome).toBe('string');
  });
});
