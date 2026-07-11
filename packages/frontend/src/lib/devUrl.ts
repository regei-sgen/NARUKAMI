// Dev-server URL detection over raw terminal output. Pure — unit-tested.
//
// A run like `npm run dev` prints its local URL (Vite: "Local: http://localhost:5173/",
// CRA/next/fastify variants differ but all print a loopback http(s) URL). We keep a
// small rolling window of ANSI-stripped output and surface the LAST loopback URL
// seen, so a server that restarts on another port updates the Open target.

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{2,5})?(?:\/[^\s'"`)\]]*)?/gi;

/** Max chars of trailing output we keep for matching (URLs never span more). */
export const DEV_URL_WINDOW = 4096;

/** Strip ANSI escapes so colored output can't split a URL match. Pure. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Append `chunk` to the rolling window and return the updated window.
 * Callers hold the window in a ref and pass it back each chunk.
 */
export function pushWindow(window: string, chunk: string): string {
  const next = window + stripAnsi(chunk);
  return next.length > DEV_URL_WINDOW ? next.slice(-DEV_URL_WINDOW) : next;
}

/**
 * The last loopback dev-server URL in the window, normalized for opening
 * (0.0.0.0 → localhost, trailing punctuation trimmed), or null.
 */
export function detectDevUrl(window: string): string | null {
  const matches = window.match(URL_RE);
  if (!matches || matches.length === 0) return null;
  let url = matches[matches.length - 1];
  url = url.replace(/[.,;:!?'"`)\]]+$/, '');
  url = url.replace('//0.0.0.0', '//localhost');
  return url;
}
