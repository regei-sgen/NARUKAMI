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

// Rank a private IPv4 so the most likely *real* Wi-Fi/Ethernet address sorts
// first and virtual adapters (Docker/WSL on 172.x, VirtualBox 192.168.56.x,
// Hyper-V/ICS 192.168.137.x) and link-local fall to the back. Home/office Wi-Fi
// is almost always 192.168.x or 10.x, so those win.
export function lanAddressRank(addr: string): number {
  if (/^169\.254\./.test(addr)) return 5; // link-local — rarely reachable
  if (/^192\.168\.(?:56|137)\./.test(addr)) return 4; // VirtualBox / Hyper-V ICS
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(addr)) return 3; // often Docker / WSL
  if (/^10\./.test(addr)) return 1;
  if (/^192\.168\./.test(addr)) return 0;
  return 2;
}

// Order candidate LAN addresses best-guess first (stable within a rank so the OS
// interface order breaks ties).
export function orderLanAddresses(addrs: string[]): string[] {
  return [...new Set(addrs)]
    .map((a, i) => ({ a, i, r: lanAddressRank(a) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((e) => e.a);
}

// This machine's non-internal private IPv4 addresses — the candidate LAN IPs the
// phone would connect to, best guess first (see orderLanAddresses).
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
  return orderLanAddresses(out);
}

// Decide which interface the server binds. When phone sharing is ON we MUST
// listen on all interfaces (0.0.0.0) so a phone on the LAN can reach us — this
// overrides whatever host the caller passed. (The Electron shell always passes
// 127.0.0.1; without this override the LAN bind never happens and the phone gets
// "site cannot be reached" even though the QR shows up.) Sharing OFF keeps the
// old behaviour: the caller's host, else loopback.
export function resolveBindHost(shareEnabled: boolean, optsHost?: string): string {
  if (shareEnabled) return '0.0.0.0';
  return optsHost ?? '127.0.0.1';
}

// Should a request with this Host/Origin be accepted on a LAN-reachable endpoint?
// Loopback is always fine; a private-LAN address is fine only while sharing is on.
export function hostAllowed(value: string | undefined | null): boolean {
  const h = hostnameOf(value);
  if (isLoopbackHostname(h)) return true;
  return enabled && isPrivateLanHostname(h);
}
