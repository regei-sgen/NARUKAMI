// Theme system. Each theme is a full set of CSS custom-property overrides applied
// to <html> at runtime. styles.css defines the crimson defaults on :root; applyTheme
// re-sets every var so switching is instant and total. The selected theme id is
// persisted server-side under the AppSetting key 'theme' (see App.tsx), and cached
// in localStorage so the first paint after reload uses the right theme (no flash).

export type ThemeId = 'crimson' | 'light' | 'midnight' | 'emerald' | 'sunset';

export interface Theme {
  id: ThemeId;
  name: string;
  kind: 'dark' | 'light';
  // [background, accent, accent-2] — drives the little preview swatch in the picker.
  swatch: [string, string, string];
  vars: Record<string, string>;
}

export const THEMES: Theme[] = [
  {
    id: 'crimson',
    name: 'Crimson',
    kind: 'dark',
    swatch: ['#0d0d11', '#ff2d3c', '#ff5561'],
    vars: {
      '--bg': '#08080a',
      '--bg-2': '#0d0d11',
      '--bg-3': '#16161c',
      '--bg-elev': '#1d1d25',
      '--border': '#26262f',
      '--border-red': 'rgba(255, 45, 60, 0.28)',
      '--text': '#e8e8ee',
      '--text-dim': '#8a8a97',
      '--accent': '#ff2d3c',
      '--accent-2': '#ff5561',
      '--accent-deep': '#b00614',
      '--accent-rgb': '255, 45, 60',
      '--glow': 'rgba(255, 45, 60, 0.5)',
      '--green': '#35e08a',
      '--red': '#ff3b3b',
      '--yellow': '#ffb020',
      '--purple': '#ff7a90',
      '--app-glow': 'rgba(255, 45, 60, 0.10)',
      '--grid-line': 'rgba(255, 255, 255, 0.014)',
      '--header-grad-a': '#101014',
      '--header-grad-b': '#0b0b0e',
      '--scrollbar-thumb': '#26262f',
      '--on-accent': '#ffffff',
      '--sig-gradient': 'linear-gradient(135deg, #ff2d3c, #b00614)',
    },
  },
  {
    id: 'light',
    name: 'Light',
    kind: 'light',
    swatch: ['#eef0f5', '#e0234a', '#ff6b4d'],
    vars: {
      '--bg': '#eef0f5',
      '--bg-2': '#ffffff',
      '--bg-3': '#e4e7ee',
      '--bg-elev': '#ffffff',
      '--border': '#d3d7e0',
      '--border-red': 'rgba(224, 35, 74, 0.30)',
      '--text': '#171821',
      '--text-dim': '#63657a',
      '--accent': '#e0234a',
      '--accent-2': '#ff4d67',
      '--accent-deep': '#a80f30',
      '--accent-rgb': '224, 35, 74',
      '--glow': 'rgba(224, 35, 74, 0.28)',
      '--green': '#0f9a58',
      '--red': '#d92b2b',
      '--yellow': '#b0790a',
      '--purple': '#b8347a',
      '--app-glow': 'rgba(224, 35, 74, 0.07)',
      '--grid-line': 'rgba(20, 20, 40, 0.035)',
      '--header-grad-a': '#ffffff',
      '--header-grad-b': '#eef0f5',
      '--scrollbar-thumb': '#c8ccd6',
      '--on-accent': '#ffffff',
      '--sig-gradient': 'linear-gradient(135deg, #e0234a, #ff6b4d)',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    kind: 'dark',
    swatch: ['#0b0e1c', '#5b8cff', '#9b6bff'],
    vars: {
      '--bg': '#070912',
      '--bg-2': '#0b0e1c',
      '--bg-3': '#121631',
      '--bg-elev': '#171d3d',
      '--border': '#232a4a',
      '--border-red': 'rgba(91, 140, 255, 0.30)',
      '--text': '#e6e9f5',
      '--text-dim': '#8891b4',
      '--accent': '#5b8cff',
      '--accent-2': '#86a8ff',
      '--accent-deep': '#2f4bd6',
      '--accent-rgb': '91, 140, 255',
      '--glow': 'rgba(91, 140, 255, 0.5)',
      '--green': '#35e0b0',
      '--red': '#ff5d7a',
      '--yellow': '#ffc340',
      '--purple': '#b58cff',
      '--app-glow': 'rgba(91, 140, 255, 0.12)',
      '--grid-line': 'rgba(255, 255, 255, 0.016)',
      '--header-grad-a': '#0d1226',
      '--header-grad-b': '#090c1a',
      '--scrollbar-thumb': '#232a4a',
      '--on-accent': '#ffffff',
      '--sig-gradient': 'linear-gradient(135deg, #5b8cff, #9b6bff)',
    },
  },
  {
    id: 'emerald',
    name: 'Emerald',
    kind: 'dark',
    swatch: ['#08170f', '#2ee6a0', '#12b3c6'],
    vars: {
      '--bg': '#06110d',
      '--bg-2': '#08170f',
      '--bg-3': '#0e2419',
      '--bg-elev': '#123020',
      '--border': '#1d3b2c',
      '--border-red': 'rgba(46, 230, 160, 0.28)',
      '--text': '#e4f2ea',
      '--text-dim': '#82a596',
      '--accent': '#2ee6a0',
      '--accent-2': '#5cf0b8',
      '--accent-deep': '#0f9d68',
      '--accent-rgb': '46, 230, 160',
      '--glow': 'rgba(46, 230, 160, 0.45)',
      '--green': '#35e08a',
      '--red': '#ff5d5d',
      '--yellow': '#ffd24d',
      '--purple': '#4ad6c0',
      '--app-glow': 'rgba(46, 230, 160, 0.10)',
      '--grid-line': 'rgba(255, 255, 255, 0.015)',
      '--header-grad-a': '#0a1c14',
      '--header-grad-b': '#07140e',
      '--scrollbar-thumb': '#1d3b2c',
      '--on-accent': '#04140d',
      '--sig-gradient': 'linear-gradient(135deg, #2ee6a0, #12b3c6)',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    kind: 'dark',
    swatch: ['#1a0c12', '#ff8a3d', '#ff5b8d'],
    vars: {
      '--bg': '#120a0e',
      '--bg-2': '#1a0c12',
      '--bg-3': '#26121b',
      '--bg-elev': '#311723',
      '--border': '#45222f',
      '--border-red': 'rgba(255, 138, 61, 0.30)',
      '--text': '#f5e9e4',
      '--text-dim': '#b58f88',
      '--accent': '#ff8a3d',
      '--accent-2': '#ff6b9d',
      '--accent-deep': '#d1452a',
      '--accent-rgb': '255, 138, 61',
      '--glow': 'rgba(255, 138, 61, 0.5)',
      '--green': '#4de0a0',
      '--red': '#ff5252',
      '--yellow': '#ffc93d',
      '--purple': '#ff6bc4',
      '--app-glow': 'rgba(255, 105, 157, 0.12)',
      '--grid-line': 'rgba(255, 255, 255, 0.015)',
      '--header-grad-a': '#1f0e16',
      '--header-grad-b': '#160a10',
      '--scrollbar-thumb': '#45222f',
      '--on-accent': '#1a0a04',
      '--sig-gradient': 'linear-gradient(135deg, #ff8a3d, #ff5b8d 55%, #a24bd6)',
    },
  },
];

export const DEFAULT_THEME_ID: ThemeId = 'crimson';
const STORAGE_KEY = 'narukami.theme';

export function getTheme(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Apply a theme's CSS vars to <html>. Returns the id actually applied (falls back to default). */
export function applyTheme(id: string | null | undefined): ThemeId {
  const theme = getTheme(id);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  root.setAttribute('data-theme', theme.id);
  root.setAttribute('data-theme-kind', theme.kind);
  return theme.id;
}

/** Last-applied theme id, cached locally for a flash-free first paint. */
export function cachedThemeId(): ThemeId {
  try {
    return getTheme(localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function cacheThemeId(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore (private mode / storage disabled)
  }
}
