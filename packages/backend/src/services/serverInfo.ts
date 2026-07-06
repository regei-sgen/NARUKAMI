// The backend's own reachable base URL, captured after `app.listen` resolves the
// real bound port (which is random in the packaged desktop app). The MCP bridge
// that lets one Claude session drive another terminal needs this to call back
// into the local API. Set once at startup; read when launching a Claude run.

let baseUrl: string | null = null;

export function setBaseUrl(url: string): void {
  baseUrl = url;
}

/** e.g. "http://127.0.0.1:4000" — or null before the server has bound. */
export function getBaseUrl(): string | null {
  return baseUrl;
}
