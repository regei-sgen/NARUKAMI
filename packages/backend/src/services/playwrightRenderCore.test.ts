import { describe, it, expect } from 'vitest';
import {
  clampDim,
  clampPoint,
  deviceProfile,
  IOS_UA,
  normalizeRenderUrl,
  parseRenderMsg,
  RENDER_LIMITS,
  resolveRenderEngine,
} from './playwrightRenderCore';

describe('resolveRenderEngine', () => {
  it('maps Firefox and both Safaris to real engines', () => {
    expect(resolveRenderEngine('firefox')).toBe('firefox');
    expect(resolveRenderEngine('safari')).toBe('webkit');
    expect(resolveRenderEngine('safari-ios')).toBe('webkit');
  });
  it('returns null for Chromium-family ids (rendered natively by the webview)', () => {
    for (const id of ['chrome', 'edge', 'brave', 'opera', 'unknown']) {
      expect(resolveRenderEngine(id)).toBeNull();
    }
  });
});

describe('clampDim', () => {
  it('clamps into range and rounds', () => {
    expect(clampDim(50, 200, 2560)).toBe(200);
    expect(clampDim(9999, 200, 2560)).toBe(2560);
    expect(clampDim(375.6, 200, 2560)).toBe(376);
  });
  it('falls back to the minimum for non-finite input', () => {
    expect(clampDim(NaN, 200, 2560)).toBe(200);
    expect(clampDim('x', 200, 2560)).toBe(200);
    expect(clampDim(undefined, 200, 2560)).toBe(200);
  });
});

describe('deviceProfile', () => {
  it('emulates an iPhone (touch, DPR 3, iOS UA) for safari-ios on real WebKit', () => {
    const p = deviceProfile('safari-ios', 375, 812);
    expect(p).toEqual({
      width: 375,
      height: 812,
      userAgent: IOS_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
  });
  it('renders desktop Safari at the real default UA (no forced mobile)', () => {
    const p = deviceProfile('safari', 1440, 900);
    expect(p.isMobile).toBe(false);
    expect(p.hasTouch).toBe(false);
    expect(p.deviceScaleFactor).toBe(1);
    expect(p.userAgent).toBeUndefined();
  });
  it('never marks Firefox as mobile (isMobile is unsupported in Gecko)', () => {
    const p = deviceProfile('firefox', 375, 812);
    expect(p.isMobile).toBe(false);
    expect(p.hasTouch).toBe(false);
    expect(p.userAgent).toBeUndefined();
  });
  it('clamps an absurd viewport to the render limits', () => {
    const p = deviceProfile('firefox', 5, 99999);
    expect(p.width).toBe(RENDER_LIMITS.minW);
    expect(p.height).toBe(RENDER_LIMITS.maxH);
  });
});

describe('normalizeRenderUrl', () => {
  it('passes http(s) through, prefixes bare hosts, trims, and blanks empty', () => {
    expect(normalizeRenderUrl('https://x.com')).toBe('https://x.com');
    expect(normalizeRenderUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeRenderUrl('  localhost:5173  ')).toBe('http://localhost:5173');
    expect(normalizeRenderUrl('')).toBe('');
    expect(normalizeRenderUrl(42)).toBe('');
  });
});

describe('parseRenderMsg', () => {
  it('parses an open message and clamps its viewport', () => {
    expect(parseRenderMsg({ type: 'open', engineId: 'firefox', url: 'localhost:3000', w: 5, h: 800 })).toEqual({
      type: 'open',
      engineId: 'firefox',
      url: 'localhost:3000',
      w: 200,
      h: 800,
    });
  });
  it('parses from a JSON string too', () => {
    const m = parseRenderMsg('{"type":"nav","url":"https://a.com"}');
    expect(m).toEqual({ type: 'nav', url: 'https://a.com' });
  });
  it('accepts each interaction kind and keeps only the relevant fields', () => {
    expect(parseRenderMsg({ type: 'input', kind: 'click', x: 10, y: 20, button: 'left' })).toEqual({
      type: 'input',
      kind: 'click',
      x: 10,
      y: 20,
      button: 'left',
    });
    expect(parseRenderMsg({ type: 'input', kind: 'scroll', dy: 120 })).toEqual({
      type: 'input',
      kind: 'scroll',
      dy: 120,
    });
    expect(parseRenderMsg({ type: 'input', kind: 'text', text: 'hi' })).toEqual({
      type: 'input',
      kind: 'text',
      text: 'hi',
    });
  });
  it('rejects malformed / unknown / hostile messages', () => {
    expect(parseRenderMsg('not json')).toBeNull();
    expect(parseRenderMsg(null)).toBeNull();
    expect(parseRenderMsg({ type: 'bogus' })).toBeNull();
    expect(parseRenderMsg({ type: 'open', engineId: 'firefox' })).toBeNull(); // missing url
    expect(parseRenderMsg({ type: 'nav' })).toBeNull(); // missing url
    expect(parseRenderMsg({ type: 'input', kind: 'explode' })).toBeNull();
  });
});

describe('clampPoint', () => {
  it('keeps a point inside the viewport box', () => {
    expect(clampPoint(-5, 50, 375, 812)).toEqual({ x: 0, y: 50 });
    expect(clampPoint(400, 900, 375, 812)).toEqual({ x: 375, y: 812 });
  });
});
