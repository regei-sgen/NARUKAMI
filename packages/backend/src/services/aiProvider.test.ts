import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: { appSetting: { findUnique: h.findUnique, upsert: h.upsert } },
}));

import {
  AI_SETTING_KEY,
  DEFAULT_AI_CONFIG,
  DEFAULT_EFFORT,
  SettingsError,
  type AiConfig,
  claudeSpawnEnv,
  loadAiConfig,
  maskKey,
  publicAiConfig,
  sanitizeApiKey,
  sanitizeBaseUrl,
  sanitizeEffort,
  setCachedAiConfig,
  writeAiConfig,
} from './aiProvider';

const KEY = 'sk-ant-api03-abcdefghijklmnop1234';

function cfg(over: Partial<AiConfig> = {}): AiConfig {
  return { ...DEFAULT_AI_CONFIG, ...over };
}

beforeEach(() => {
  h.findUnique.mockReset();
  h.upsert.mockReset();
  h.findUnique.mockResolvedValue(null);
  setCachedAiConfig({ ...DEFAULT_AI_CONFIG });
});

describe('sanitizeApiKey', () => {
  it('trims and keeps a normal Anthropic key (hyphens are legal)', () => {
    expect(sanitizeApiKey(`  ${KEY}  `)).toBe(KEY);
  });

  it('treats blank / non-string input as "no key"', () => {
    expect(sanitizeApiKey('   ')).toBe('');
    expect(sanitizeApiKey(undefined)).toBe('');
    expect(sanitizeApiKey(42)).toBe('');
  });

  it('rejects embedded whitespace and control characters', () => {
    expect(() => sanitizeApiKey('sk-ant key')).toThrow(SettingsError);
    expect(() => sanitizeApiKey('sk-ant\nkey')).toThrow(SettingsError);
    expect(() => sanitizeApiKey(`sk-ant${String.fromCharCode(0)}key`)).toThrow(SettingsError);
  });

  it('rejects an absurdly long value', () => {
    expect(() => sanitizeApiKey('k'.repeat(513))).toThrow(/too long/);
  });
});

describe('sanitizeBaseUrl', () => {
  it('accepts http(s) and strips a trailing slash', () => {
    expect(sanitizeBaseUrl('https://gateway.example.com/')).toBe('https://gateway.example.com');
    expect(sanitizeBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('treats blank as "Anthropic default"', () => {
    expect(sanitizeBaseUrl('  ')).toBe('');
    expect(sanitizeBaseUrl(undefined)).toBe('');
  });

  it('rejects a non-URL and a non-http scheme', () => {
    expect(() => sanitizeBaseUrl('gateway.example.com')).toThrow(SettingsError);
    expect(() => sanitizeBaseUrl('ftp://example.com')).toThrow(/http/);
  });
});

describe('sanitizeEffort', () => {
  it('keeps a word-char level and falls back otherwise', () => {
    expect(sanitizeEffort('high')).toBe('high');
    expect(sanitizeEffort('ultracode')).toBe('ultracode');
    expect(sanitizeEffort('high; rm -rf /')).toBe(DEFAULT_EFFORT);
    expect(sanitizeEffort('')).toBe(DEFAULT_EFFORT);
  });
});

describe('maskKey', () => {
  it('never reveals the middle of the key', () => {
    const masked = maskKey(KEY);
    expect(masked.startsWith('sk-ant-')).toBe(true);
    expect(masked.endsWith(KEY.slice(-4))).toBe(true);
    expect(masked).not.toContain('abcdefghijklmnop');
  });

  it('fully hides a short value and returns "" for none', () => {
    expect(maskKey('short')).toBe('••••••••');
    expect(maskKey('')).toBe('');
  });
});

describe('claudeSpawnEnv', () => {
  it('injects NOTHING in the default claude-code mode', () => {
    expect(claudeSpawnEnv(cfg())).toEqual({});
    // even if a key is stored but the provider was switched back
    expect(claudeSpawnEnv(cfg({ apiKey: KEY }))).toEqual({});
  });

  it('injects the key (and optional base URL) in api-key mode', () => {
    expect(claudeSpawnEnv(cfg({ provider: 'api-key', apiKey: KEY }))).toEqual({
      ANTHROPIC_API_KEY: KEY,
    });
    expect(
      claudeSpawnEnv(cfg({ provider: 'api-key', apiKey: KEY, baseUrl: 'https://gw.example.com' })),
    ).toEqual({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: 'https://gw.example.com' });
  });

  it('falls back to injecting nothing when api-key mode has no key', () => {
    expect(claudeSpawnEnv(cfg({ provider: 'api-key' }))).toEqual({});
  });
});

describe('publicAiConfig', () => {
  it('never serializes the key itself', () => {
    const pub = publicAiConfig(cfg({ provider: 'api-key', apiKey: KEY }), {});
    expect(JSON.stringify(pub)).not.toContain(KEY);
    expect(pub.hasKey).toBe(true);
    expect(pub.keyPreview).toBe(maskKey(KEY));
    expect(pub.effective).toBe('api-key');
  });

  it('reports the CLI login as effective when nothing is configured', () => {
    const pub = publicAiConfig(cfg(), {});
    expect(pub).toMatchObject({ hasKey: false, keyPreview: '', effective: 'claude-code-login' });
    expect(pub.inheritedAuthVars).toEqual([]);
  });

  it('flags an inherited env credential that would outrank the login', () => {
    const pub = publicAiConfig(cfg(), { ANTHROPIC_API_KEY: 'sk-ant-from-the-shell' });
    expect(pub.inheritedAuthVars).toEqual(['ANTHROPIC_API_KEY']);
    expect(pub.effective).toBe('inherited-env');
  });

  it('ignores a blank inherited var', () => {
    expect(publicAiConfig(cfg(), { ANTHROPIC_API_KEY: '   ' }).effective).toBe('claude-code-login');
  });
});

describe('loadAiConfig', () => {
  it('returns the default when no row is stored', async () => {
    await expect(loadAiConfig()).resolves.toEqual(DEFAULT_AI_CONFIG);
  });

  it('reads a stored row', async () => {
    h.findUnique.mockResolvedValue({
      value: JSON.stringify({ provider: 'api-key', apiKey: KEY, baseUrl: '', defaultEffort: 'high' }),
    });
    await expect(loadAiConfig()).resolves.toEqual({
      provider: 'api-key',
      apiKey: KEY,
      baseUrl: '',
      defaultEffort: 'high',
    });
  });

  it('falls back to the default on malformed JSON or a DB error', async () => {
    h.findUnique.mockResolvedValue({ value: 'not json' });
    await expect(loadAiConfig()).resolves.toEqual(DEFAULT_AI_CONFIG);

    h.findUnique.mockRejectedValue(new Error('db down'));
    await expect(loadAiConfig()).resolves.toEqual(DEFAULT_AI_CONFIG);
  });
});

describe('writeAiConfig', () => {
  it('persists under the AI settings key and updates the sync cache', async () => {
    const saved = await writeAiConfig({ provider: 'api-key', apiKey: KEY });
    expect(saved).toEqual({ provider: 'api-key', apiKey: KEY, baseUrl: '', defaultEffort: DEFAULT_EFFORT });
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: AI_SETTING_KEY } }),
    );
    // the spawn path reads the cache synchronously — it must already be current
    expect(claudeSpawnEnv()).toEqual({ ANTHROPIC_API_KEY: KEY });
  });

  it('KEEPS the stored key when the patch omits it', async () => {
    h.findUnique.mockResolvedValue({
      value: JSON.stringify({ provider: 'api-key', apiKey: KEY, baseUrl: '', defaultEffort: 'high' }),
    });
    const saved = await writeAiConfig({ defaultEffort: 'medium' });
    expect(saved.apiKey).toBe(KEY);
    expect(saved.defaultEffort).toBe('medium');
  });

  it('clears the key on an explicit empty string', async () => {
    h.findUnique.mockResolvedValue({
      value: JSON.stringify({ provider: 'api-key', apiKey: KEY, baseUrl: '', defaultEffort: 'high' }),
    });
    const saved = await writeAiConfig({ provider: 'claude-code', apiKey: '' });
    expect(saved.apiKey).toBe('');
    expect(claudeSpawnEnv()).toEqual({});
  });

  it('refuses api-key mode with no key rather than silently using the login', async () => {
    await expect(writeAiConfig({ provider: 'api-key' })).rejects.toThrow(SettingsError);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid base URL without writing', async () => {
    await expect(writeAiConfig({ baseUrl: 'nope' })).rejects.toThrow(SettingsError);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
