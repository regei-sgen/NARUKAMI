// Browser view (responsive preview) helpers. Pure — unit-tested.
//
// The Browser view renders a URL in several device-sized iframes side by side.
// Presets use CSS pixels (device-independent), matching Chrome DevTools device
// mode, so the embedded page's media queries fire exactly as they would on the
// real device.

export interface DevicePreset {
  id: string; // stable key — persisted in UiSettings.browserDevices
  label: string;
  width: number; // CSS px
  height: number;
  kind: 'phone' | 'tablet' | 'laptop' | 'desktop';
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, kind: 'phone' },
  { id: 'iphone-14-pro', label: 'iPhone 14 Pro', width: 393, height: 852, kind: 'phone' },
  { id: 'pixel-7', label: 'Pixel 7', width: 412, height: 915, kind: 'phone' },
  { id: 'ipad-mini', label: 'iPad Mini', width: 768, height: 1024, kind: 'tablet' },
  { id: 'ipad-pro', label: 'iPad Pro', width: 1024, height: 1366, kind: 'tablet' },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800, kind: 'laptop' },
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900, kind: 'desktop' },
  { id: 'full-hd', label: 'Full HD', width: 1920, height: 1080, kind: 'desktop' },
];

// Small phone (the canonical narrow-viewport stress test), modern phone,
// tablet portrait, laptop — the classic breakpoint spread without immediately
// overflowing a typical window. The rest start disabled.
export const DEFAULT_DEVICE_IDS = ['iphone-se', 'iphone-14-pro', 'ipad-mini', 'laptop'];

/**
 * Normalize address-bar input into a loadable URL: trim, prepend http:// when
 * no scheme is given ('localhost:5173' → 'http://localhost:5173'), and reject
 * anything `new URL` can't parse. Null means "nothing to load".
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

/** Loopback targets embed reliably; anything else is best-effort (may refuse framing). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
  } catch {
    return false;
  }
}

const LOOPBACK_ALIASES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Rewrite a loopback preview URL's host to match the app's own host. `localhost`
 * and `127.0.0.1` are DIFFERENT sites for SameSite cookies, so a `localhost`
 * dev server framed by the packaged app (origin `http://127.0.0.1:<port>`) gets
 * its Lax session cookies blocked — logins silently break inside the preview.
 * Aligning the hosts makes app + frame same-site in both dev and packaged.
 */
export function alignLoopbackHost(url: string, appHost: string): string {
  try {
    const u = new URL(url);
    const host = appHost === '::1' ? '[::1]' : appHost;
    if (u.hostname !== host && LOOPBACK_ALIASES.has(u.hostname) && LOOPBACK_ALIASES.has(host)) {
      u.hostname = host;
      return u.toString();
    }
  } catch {
    // fall through — return the input unchanged
  }
  return url;
}

/**
 * Scale factor fitting a device height into the available strip height,
 * rounded to 3 decimals to avoid sub-pixel style churn. Never upscales; floors
 * at 0.1 so huge presets stay legible; degenerate (pre-measure) sizes → 1.
 */
export function fitScale(deviceHeight: number, availHeight: number): number {
  if (deviceHeight <= 0 || availHeight <= 0) return 1;
  const k = Math.min(1, Math.max(0.1, availHeight / deviceHeight));
  return Math.round(k * 1000) / 1000;
}

/**
 * Toggle a preset id in the enabled list. Output is always in DEVICE_PRESETS
 * order (frames render smallest → largest regardless of click order), and the
 * last enabled device can't be removed — the view never goes empty.
 */
export function toggleDevice(enabled: string[], id: string): string[] {
  const set = new Set(enabled);
  if (set.has(id)) {
    if (set.size === 1) return enabled;
    set.delete(id);
  } else {
    set.add(id);
  }
  return DEVICE_PRESETS.filter((d) => set.has(d.id)).map((d) => d.id);
}
