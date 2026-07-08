import { describe, it, expect, afterEach } from 'vitest';
import { THEMES, DEFAULT_THEME_ID, getTheme, applyTheme, cachedThemeId, cacheThemeId } from './themes';

// Minimal stand-ins so the DOM/storage code paths run under the node test env
// (no jsdom). Each returns a handle to inspect what the code wrote.
function stubDom(): { props: Record<string, string>; attrs: Record<string, string> } {
  const props: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => {
          props[k] = v;
        },
      },
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
    },
  };
  return { props, attrs };
}

function stubStorage(throwOnSet = false): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (throwOnSet) throw new Error('storage disabled');
      store.set(k, v);
    },
  };
  return store;
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

describe('themes', () => {
  it('ships exactly 5 themes with unique ids, including a dark and a light one', () => {
    expect(THEMES).toHaveLength(5);
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).toContain('crimson');
    expect(ids).toContain('light');
    expect(THEMES.some((t) => t.kind === 'light')).toBe(true);
    expect(THEMES.some((t) => t.kind === 'dark')).toBe(true);
  });

  it('has the default theme present in the list', () => {
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  });

  it('every theme defines the identical set of CSS var keys', () => {
    // Switching sets each var explicitly; a theme missing a key would leave the
    // previous theme's value behind (partial theming). Guard against that.
    const base = Object.keys(THEMES[0].vars).sort();
    expect(base.length).toBeGreaterThan(0);
    for (const t of THEMES) {
      expect(Object.keys(t.vars).sort(), `theme "${t.id}" var keys`).toEqual(base);
    }
  });

  it('every var has a non-empty value and each theme has a 3-color swatch', () => {
    for (const t of THEMES) {
      expect(t.swatch).toHaveLength(3);
      for (const [key, value] of Object.entries(t.vars)) {
        expect(value.trim(), `${t.id} ${key}`).not.toBe('');
      }
    }
  });

  it('getTheme falls back to the default for unknown/empty ids', () => {
    expect(getTheme(undefined).id).toBe(DEFAULT_THEME_ID);
    expect(getTheme(null).id).toBe(DEFAULT_THEME_ID);
    expect(getTheme('nope').id).toBe(DEFAULT_THEME_ID);
    expect(getTheme('midnight').id).toBe('midnight');
  });
});

describe('applyTheme', () => {
  it('writes every one of the theme’s CSS vars to <html> and returns the id', () => {
    const { props, attrs } = stubDom();
    const midnight = THEMES.find((t) => t.id === 'midnight')!;

    const result = applyTheme('midnight');

    expect(result).toBe('midnight');
    // Every var the theme declares is set, with the exact value.
    for (const [key, value] of Object.entries(midnight.vars)) {
      expect(props[key], key).toBe(value);
    }
    // No stray vars beyond the declared set (so switching is a full replace).
    expect(Object.keys(props).sort()).toEqual(Object.keys(midnight.vars).sort());
    expect(attrs['data-theme']).toBe('midnight');
    expect(attrs['data-theme-kind']).toBe('dark');
  });

  it('falls back to the default theme for an unknown id', () => {
    const { props, attrs } = stubDom();
    const crimson = THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;

    const result = applyTheme('does-not-exist');

    expect(result).toBe(DEFAULT_THEME_ID);
    expect(attrs['data-theme']).toBe(DEFAULT_THEME_ID);
    expect(props['--accent']).toBe(crimson.vars['--accent']);
  });

  it('marks the light theme with data-theme-kind="light"', () => {
    const { attrs } = stubDom();
    applyTheme('light');
    expect(attrs['data-theme-kind']).toBe('light');
  });
});

describe('theme cache (localStorage)', () => {
  it('round-trips a cached id', () => {
    stubStorage();
    cacheThemeId('emerald');
    expect(cachedThemeId()).toBe('emerald');
  });

  it('returns the default when nothing is cached', () => {
    stubStorage();
    expect(cachedThemeId()).toBe(DEFAULT_THEME_ID);
  });

  it('returns the default when a stale/garbage value is cached', () => {
    const store = stubStorage();
    store.set('narukami.theme', 'not-a-real-theme');
    expect(cachedThemeId()).toBe(DEFAULT_THEME_ID);
  });

  it('cacheThemeId swallows storage failures (private mode)', () => {
    stubStorage(true);
    expect(() => cacheThemeId('sunset')).not.toThrow();
  });

  it('cachedThemeId returns the default when storage is unavailable', () => {
    // no stubStorage(): localStorage is undefined → the try/catch falls back.
    expect(cachedThemeId()).toBe(DEFAULT_THEME_ID);
  });
});
