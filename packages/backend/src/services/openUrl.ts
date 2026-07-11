import { spawn } from 'node:child_process';

/**
 * Open a LOOPBACK dev-server URL in the user's default browser (the terminal
 * toolbar's "Open" button). Strictly validated: only http(s) on localhost /
 * 127.0.0.1 / [::1] — this can never be pointed at an external site or a
 * non-http scheme by a compromised page, and 0.0.0.0 is normalized to
 * localhost (listen-address, not a browsable host).
 */
export function validateDevUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
  const host = url.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
    return null;
  }
  return url.toString();
}

/** Launch the default browser, detached (fire-and-forget). Windows/macOS/Linux. */
export function openInBrowser(url: string): void {
  const [file, args] =
    process.platform === 'win32'
      ? // `start` is a cmd builtin; the empty "" is the window-title slot so the
        // URL isn't consumed as the title.
        ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(file as string, args as string[], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
