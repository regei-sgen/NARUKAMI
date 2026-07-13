import { describe, expect, it } from 'vitest';
import {
  DEVICE_PRESETS,
  DEFAULT_DEVICE_IDS,
  normalizeUrl,
  isLoopbackUrl,
  alignLoopbackHost,
  fitScale,
  toggleDevice,
} from './browserView';

describe('normalizeUrl', () => {
  it('prepends http:// when no scheme is given', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173/');
  });

  it('passes https URLs through', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('trims whitespace', () => {
    expect(normalizeUrl('  localhost:3000  ')).toBe('http://localhost:3000/');
  });

  it('preserves path and query', () => {
    expect(normalizeUrl('localhost:5173/app?tab=1')).toBe('http://localhost:5173/app?tab=1');
  });

  it('returns null for empty or blank input', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(normalizeUrl('ht tp://x')).toBeNull();
    expect(normalizeUrl('http://')).toBeNull();
  });
});

describe('isLoopbackUrl', () => {
  it('accepts localhost, 127.x and [::1]', () => {
    expect(isLoopbackUrl('http://localhost:5173/')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:4000')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true);
  });

  it('rejects external hosts and garbage', () => {
    expect(isLoopbackUrl('https://example.com')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

describe('alignLoopbackHost', () => {
  it('rewrites localhost to 127.0.0.1 when the app runs on 127.0.0.1 (packaged)', () => {
    expect(alignLoopbackHost('http://localhost:5599/app?x=1', '127.0.0.1')).toBe(
      'http://127.0.0.1:5599/app?x=1',
    );
  });

  it('rewrites 127.0.0.1 to localhost when the app runs on localhost (dev)', () => {
    expect(alignLoopbackHost('http://127.0.0.1:5599/', 'localhost')).toBe('http://localhost:5599/');
  });

  it('keeps the port and leaves already-aligned URLs alone', () => {
    expect(alignLoopbackHost('http://localhost:3000/', 'localhost')).toBe('http://localhost:3000/');
  });

  it('never touches non-loopback hosts', () => {
    expect(alignLoopbackHost('https://example.com/', '127.0.0.1')).toBe('https://example.com/');
    expect(alignLoopbackHost('http://localhost:3000/', 'example.com')).toBe(
      'http://localhost:3000/',
    );
  });

  it('returns garbage input unchanged', () => {
    expect(alignLoopbackHost('not a url', '127.0.0.1')).toBe('not a url');
  });
});

describe('fitScale', () => {
  it('returns 1 when the device fits', () => {
    expect(fitScale(667, 800)).toBe(1);
  });

  it('scales down to fit', () => {
    expect(fitScale(1080, 540)).toBe(0.5);
  });

  it('floors at 0.1', () => {
    expect(fitScale(10000, 100)).toBe(0.1);
  });

  it('returns 1 for degenerate pre-measure sizes', () => {
    expect(fitScale(667, 0)).toBe(1);
    expect(fitScale(0, 800)).toBe(1);
    expect(fitScale(667, -5)).toBe(1);
  });

  it('rounds to 3 decimals', () => {
    expect(fitScale(3, 2)).toBe(0.667);
  });
});

describe('toggleDevice', () => {
  it('adds a disabled device', () => {
    expect(toggleDevice(['iphone-se'], 'laptop')).toEqual(['iphone-se', 'laptop']);
  });

  it('removes an enabled device', () => {
    expect(toggleDevice(['iphone-se', 'laptop'], 'laptop')).toEqual(['iphone-se']);
  });

  it('keeps preset order regardless of click order', () => {
    expect(toggleDevice(['laptop'], 'iphone-se')).toEqual(['iphone-se', 'laptop']);
  });

  it('refuses to remove the last device', () => {
    expect(toggleDevice(['laptop'], 'laptop')).toEqual(['laptop']);
  });

  it('defaults are all valid preset ids', () => {
    for (const id of DEFAULT_DEVICE_IDS) {
      expect(DEVICE_PRESETS.some((d) => d.id === id)).toBe(true);
    }
  });
});
