import os from 'node:os';

// "Phone access" (LAN sharing) state. By default the whole app is loopback-only
// (127.0.0.1) and every non-localhost request is rejected — see auth.ts / ws.ts.
// When the user opts in, the server is started bound to 0.0.0.0 and this flag is
// turned on, which relaxes the host/origin checks to ALSO accept private-LAN
// addresses (never public ones) for the token-gated API + WebSocket endpoints.
// The token in the QR code is still required. The persisted on/off lives in
// AppSetting under the key 'phoneAccess'; this module holds the resolved runtime
// state (set once at startup, since changing it requires re-binding → a restart).
export const SHARE_SETTING_KEY = 'phoneAccess';

let enabled = false;
let boundPort = 0;

export function setShareEnabled(v: boolean): void {
  enabled = v;
}
export function isShareEnabled(): boolean {
  return enabled;
}
export function setSharePort(port: number): void {
  boundPort = port;
}
export function getSharePort(): number {
  return boundPort;
}

// The hostname portion of a Host header (`host:port`) or an Origin (`scheme://host:port`),
// lowercased, with any port and IPv6 brackets stripped. null when unparseable.
export function hostnameOf(value: string | undefined | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      return new URL(v).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
      return null;
    }
  }
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    return end > 0 ? v.slice(1, end).toLowerCase() : null;
  }
  const name = v.split(':')[0];
  return name ? name.toLowerCase() : null;
}

export function isLoopbackHostname(h: string | null): boolean {
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

// Private / link-local addresses only: RFC1918 IPv4 (10/8, 172.16-31/12,
// 192.168/16), 169.254/16 link-local, and IPv6 unique-local/link-local
// (fc00::/7, fe80::/10). Public addresses are never accepted, even when sharing
// is on — this keeps exposure to the local network.
export function isPrivateLanHostname(h: string | null): boolean {
  if (!h) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if ([m[1], m[2], m[3], m[4]].some((p) => Number(p) > 255)) return false;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

// This machine's non-internal private IPv4 addresses — the candidate LAN IPs the
// phone would connect to. First entry is the best guess for the QR code.
export function lanAddresses(): string[] {
  const out: string[] = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal && isPrivateLanHostname(ni.address)) {
        out.push(ni.address);
      }
    }
  }
  return [...new Set(out)];
}

// Should a request with this Host/Origin be accepted on a LAN-reachable endpoint?
// Loopback is always fine; a private-LAN address is fine only while sharing is on.
export function hostAllowed(value: string | undefined | null): boolean {
  const h = hostnameOf(value);
  if (isLoopbackHostname(h)) return true;
  return enabled && isPrivateLanHostname(h);
}
