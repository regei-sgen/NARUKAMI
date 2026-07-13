// Pure header-rewrite logic for the Browser view, split out of main.ts so it can
// be exercised without booting Electron. See stripFramingHeaders() in main.ts
// for why the Browser view needs to remove these framing controls.

/**
 * Rewrite a response's headers so a SUBFRAME can embed a site that would
 * otherwise refuse framing. Drops `X-Frame-Options` entirely and peels only the
 * `frame-ancestors` directive out of any `Content-Security-Policy` (leaving the
 * site's other CSP protections intact). Returns the new header map, or `null`
 * to signal "leave the response untouched" (non-subframe resources, or no
 * headers) — the caller passes that straight through.
 */
export function rewriteFramingHeaders(
  resourceType: string,
  responseHeaders: Record<string, string | string[]> | undefined,
): Record<string, string[]> | null {
  if (resourceType !== 'subFrame' || !responseHeaders) return null;
  const next: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(responseHeaders)) {
    const value = Array.isArray(raw) ? raw : [raw];
    const lk = key.toLowerCase();
    if (lk === 'x-frame-options') continue; // drop entirely
    if (lk === 'content-security-policy') {
      const cleaned = value
        .map((v) =>
          v
            .split(';')
            .map((d) => d.trim())
            .filter((d) => d && !/^frame-ancestors\b/i.test(d))
            .join('; '),
        )
        .filter((v) => v.length > 0);
      if (cleaned.length) next[key] = cleaned;
      continue;
    }
    next[key] = value;
  }
  return next;
}
