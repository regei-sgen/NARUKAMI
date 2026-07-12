// The URL a project's phone QR code encodes: the lightweight mobile page (/m)
// served on this machine's LAN address, carrying the project id + access token
// as query params (the mobile page reads them and uses the token for its API/WS
// calls). Kept pure so it can be unit-tested without a DOM.
export function mobileUrl(addr: string, port: number, projectId: string, token: string): string {
  return `http://${addr}:${port}/m?project=${encodeURIComponent(projectId)}&token=${encodeURIComponent(token)}`;
}
