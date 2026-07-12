import { describe, it, expect } from 'vitest';
import {
  closeBrowser,
  DEFAULT_URL,
  fitScale,
  frameSize,
  layoutByHeight,
  layoutByWidth,
  layoutFill,
  layoutFit,
  normalizeTabs,
  normalizeUrl,
  parseEnabled,
  pickActive,
  renderEngineFor,
  viewportById,
  VIEWPORTS,
  type BrowserTab,
} from './browserView';

describe('normalizeUrl', () => {
  it('passes through existing http(s) URLs untouched (any casing)', () => {
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('https://example.com/app')).toBe('https://example.com/app');
    expect(normalizeUrl('HTTPS://Example.com')).toBe('HTTPS://Example.com');
  });

  it('adds http:// to a bare host / port / path', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeUrl('127.0.0.1:8080/dash')).toBe('http://127.0.0.1:8080/dash');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeUrl('  localhost:3000  ')).toBe('http://localhost:3000');
  });

  it('returns empty string for blank input (nothing to load)', () => {
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
  });
});

describe('frameSize', () => {
  it('never upscales a viewport narrower than the target width', () => {
    expect(frameSize(375, 812, 380)).toEqual({ scale: 1, dispW: 375, dispH: 812 });
  });

  it('scales a wide viewport down to fit the target width', () => {
    const { scale, dispW, dispH } = frameSize(1440, 900, 360);
    expect(scale).toBeCloseTo(0.25, 5);
    expect(dispW).toBe(360);
    expect(dispH).toBe(225);
  });

  it('rounds display dimensions to whole pixels', () => {
    const r = frameSize(1000, 777, 333);
    expect(Number.isInteger(r.dispW)).toBe(true);
    expect(Number.isInteger(r.dispH)).toBe(true);
  });
});

describe('parseEnabled', () => {
  const valid = ['mobile', 'tablet', 'laptop', 'desktop', 'wide'];
  const defaults = ['mobile', 'tablet', 'desktop'];

  it('keeps the saved ids that are still valid presets, in order', () => {
    expect(parseEnabled('desktop,mobile', valid, defaults)).toEqual(['desktop', 'mobile']);
  });

  it('drops ids that are no longer known presets', () => {
    expect(parseEnabled('mobile,gone,wide', valid, defaults)).toEqual(['mobile', 'wide']);
  });

  it('falls back to defaults when storage is missing, empty, or all-stale', () => {
    expect(parseEnabled(null, valid, defaults)).toEqual(defaults);
    expect(parseEnabled('', valid, defaults)).toEqual(defaults);
    expect(parseEnabled('gone,missing', valid, defaults)).toEqual(defaults);
  });
});

describe('browser tabs', () => {
  const tab = (id: string): BrowserTab => ({ id, name: id, url: '', viewports: [], engine: 'chrome' });
  const list = [tab('a'), tab('b'), tab('c')];

  it('closeBrowser removes only the named tab', () => {
    expect(closeBrowser(list, 'b').map((t) => t.id)).toEqual(['a', 'c']);
    expect(closeBrowser(list, 'zzz').map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('pickActive keeps the current tab when a different one is closed', () => {
    expect(pickActive(list, 'a', 'c')).toBe('c');
  });

  it('pickActive moves to the tab that slides into a closed active middle tab', () => {
    expect(pickActive(list, 'b', 'b')).toBe('c');
  });

  it('pickActive falls back to the previous tab when the active last tab is closed', () => {
    expect(pickActive(list, 'c', 'c')).toBe('b');
  });

  it('pickActive leaves the active id unchanged when closing the only tab', () => {
    expect(pickActive([tab('a')], 'a', 'a')).toBe('a');
  });
});

describe('fitScale', () => {
  it('downscales to fit the limiting (height) dimension', () => {
    // desktop 1440x900 into a 1000x500 box: height limits → 500/900
    const r = fitScale(1440, 900, 1000, 500);
    expect(r.scale).toBeCloseTo(500 / 900, 5);
    expect(r.dispH).toBe(500);
    expect(r.dispW).toBe(800);
  });

  it('downscales to fit the limiting (width) dimension', () => {
    const r = fitScale(1920, 1080, 960, 900);
    expect(r.scale).toBeCloseTo(0.5, 5);
    expect(r.dispW).toBe(960);
    expect(r.dispH).toBe(540);
  });

  it('upscales a small viewport to fill a large window (unlike frameSize)', () => {
    const r = fitScale(375, 812, 1500, 1624);
    expect(r.scale).toBeCloseTo(2, 5);
    expect(r.dispW).toBe(750);
    expect(r.dispH).toBe(1624);
  });
});

describe('layoutByWidth', () => {
  it('renders at native size, scaled so the width fits (never upscales)', () => {
    // narrower-than-target device stays 1:1
    expect(layoutByWidth(375, 812, 380)).toEqual({
      scale: 1,
      dispW: 375,
      dispH: 812,
      frameW: 375,
      frameH: 812,
    });
    // wide device scales down by width
    const r = layoutByWidth(1440, 900, 360);
    expect(r.scale).toBeCloseTo(0.25, 5);
    expect(r).toMatchObject({ dispW: 360, dispH: 225, frameW: 1440, frameH: 900 });
  });
});

describe('layoutByHeight', () => {
  it('scales every device so its HEIGHT fits the target (never upscales)', () => {
    // tall device scales down by height
    const r = layoutByHeight(375, 812, 406);
    expect(r.scale).toBeCloseTo(0.5, 5);
    expect(r).toMatchObject({ dispW: 188, dispH: 406, frameW: 375, frameH: 812 });
    // short device is capped at 1:1
    expect(layoutByHeight(1440, 400, 800)).toMatchObject({ scale: 1, dispH: 400 });
  });
});

describe('layoutFill', () => {
  it('keeps device width crisp and stretches the frame to fill the panel height', () => {
    // desktop 1440 wider than a 720px panel → scale down by width, fill 600px tall
    const r = layoutFill(1440, 720, 600);
    expect(r.scale).toBeCloseTo(0.5, 5);
    expect(r.dispW).toBe(720);
    expect(r.dispH).toBe(600);
    expect(r.frameW).toBe(1440);
    // frame renders taller than any device preset so it fills the panel: 600/0.5
    expect(r.frameH).toBe(1200);
  });

  it('never upscales a device narrower than the panel (scale capped at 1)', () => {
    // mobile 375 inside a wide 1000px panel → 1:1 width, frame height == panel
    const r = layoutFill(375, 1000, 700);
    expect(r.scale).toBe(1);
    expect(r.dispW).toBe(375);
    expect(r.dispH).toBe(700);
    expect(r.frameH).toBe(700);
  });
});

describe('layoutFit', () => {
  it('fits a device within a box on both axes without upscaling', () => {
    // desktop into a short box: height limits
    const r = layoutFit(1440, 900, 1000, 450);
    expect(r.scale).toBeCloseTo(0.5, 5);
    expect(r).toMatchObject({ dispW: 720, dispH: 450, frameW: 1440, frameH: 900 });
  });
  it('caps at 1:1 so a small device is not blurrily upscaled', () => {
    expect(layoutFit(375, 812, 1500, 1624)).toMatchObject({ scale: 1, dispW: 375, dispH: 812 });
  });
});

describe('viewportById', () => {
  it('resolves known device ids and returns undefined otherwise', () => {
    expect(viewportById('desktop')).toMatchObject({ id: 'desktop', w: 1440, h: 900 });
    expect(viewportById('mobile')).toMatchObject({ id: 'mobile', w: 375 });
    expect(viewportById('nope')).toBeUndefined();
  });
  it('every preset has positive dimensions and a name', () => {
    for (const v of VIEWPORTS) {
      expect(v.w).toBeGreaterThan(0);
      expect(v.h).toBeGreaterThan(0);
      expect(v.name.length).toBeGreaterThan(0);
    }
  });
});

describe('renderEngineFor', () => {
  it('maps Firefox and both Safaris to a real Playwright engine', () => {
    expect(renderEngineFor('firefox')).toBe('firefox');
    expect(renderEngineFor('safari')).toBe('webkit');
    expect(renderEngineFor('safari-ios')).toBe('webkit');
  });
  it('returns null for Chromium-family ids (they render natively)', () => {
    for (const id of ['chrome', 'edge', 'brave', 'opera']) {
      expect(renderEngineFor(id)).toBeNull();
    }
  });
});

describe('normalizeTabs', () => {
  const valid = ['mobile', 'tablet', 'laptop', 'desktop', 'wide'];
  const defaults = ['mobile', 'tablet', 'desktop'];
  // Deterministic id generator for assertions.
  const gen = () => {
    let n = 0;
    return () => `gen${++n}`;
  };

  it('loads a valid stored tab array as-is (keeping a valid engine)', () => {
    const stored = JSON.stringify([
      { id: 'x', name: 'Frontend', url: 'http://localhost:3000', viewports: ['mobile', 'wide'], engine: 'firefox' },
      { id: 'y', name: 'Admin', url: 'http://localhost:8080', viewports: ['desktop'], engine: 'edge' },
    ]);
    expect(normalizeTabs(stored, null, null, valid, defaults, gen())).toEqual([
      { id: 'x', name: 'Frontend', url: 'http://localhost:3000', viewports: ['mobile', 'wide'], engine: 'firefox' },
      { id: 'y', name: 'Admin', url: 'http://localhost:8080', viewports: ['desktop'], engine: 'edge' },
    ]);
  });

  it('fills missing/invalid fields on stored tabs (incl. unknown engine → chrome)', () => {
    const stored = JSON.stringify([{ url: 'http://x' }, { id: 'k', viewports: ['nope'], engine: 'netscape' }]);
    expect(normalizeTabs(stored, null, null, valid, defaults, gen())).toEqual([
      { id: 'gen1', name: 'Browser', url: 'http://x', viewports: defaults, engine: 'chrome' },
      { id: 'k', name: 'Browser', url: DEFAULT_URL, viewports: defaults, engine: 'chrome' },
    ]);
  });

  it('migrates the legacy single board when there is no stored array', () => {
    expect(normalizeTabs(null, 'http://localhost:5173', 'mobile,wide', valid, defaults, gen())).toEqual([
      { id: 'gen1', name: 'Browser 1', url: 'http://localhost:5173', viewports: ['mobile', 'wide'], engine: 'chrome' },
    ]);
  });

  it('seeds a single default tab when nothing is stored', () => {
    expect(normalizeTabs(null, null, null, valid, defaults, gen())).toEqual([
      { id: 'gen1', name: 'Browser 1', url: DEFAULT_URL, viewports: defaults, engine: 'chrome' },
    ]);
  });

  it('falls back to migration on malformed JSON or an empty array', () => {
    expect(normalizeTabs('{not json', 'http://a', null, valid, defaults, gen())).toEqual([
      { id: 'gen1', name: 'Browser 1', url: 'http://a', viewports: defaults, engine: 'chrome' },
    ]);
    expect(normalizeTabs('[]', 'http://b', null, valid, defaults, gen())).toEqual([
      { id: 'gen1', name: 'Browser 1', url: 'http://b', viewports: defaults, engine: 'chrome' },
    ]);
  });
});
