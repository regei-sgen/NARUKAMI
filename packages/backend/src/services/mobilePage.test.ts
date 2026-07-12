import { describe, it, expect } from 'vitest';
import { MOBILE_HTML } from './mobilePage';

describe('MOBILE_HTML', () => {
  it('is a complete self-contained HTML document', () => {
    expect(MOBILE_HTML.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(MOBILE_HTML).toContain('<title>NARUKAMI');
    expect(MOBILE_HTML.trimEnd().endsWith('</html>')).toBe(true);
    expect(MOBILE_HTML).toContain('<style>');
    expect(MOBILE_HTML).toContain('<script>');
  });

  it('references nothing external (no CDN script src / stylesheet link)', () => {
    expect(/<script[^>]+\bsrc=/i.test(MOBILE_HTML)).toBe(false);
    expect(/<link[^>]+\bhref=/i.test(MOBILE_HTML)).toBe(false);
  });

  it('carries the client logic (reads token/project, calls the API + run WS)', () => {
    expect(MOBILE_HTML).toContain("qs.get('token')");
    expect(MOBILE_HTML).toContain("qs.get('project')");
    expect(MOBILE_HTML).toContain('/api/projects/');
    expect(MOBILE_HTML).toContain('/ws/runs/');
  });

  it('has no unresolved template-literal interpolation or raw ESC bytes', () => {
    // The page is authored as a JS template literal; a leaked ${...} or a raw ESC
    // byte would mean the backslash-escaping in the source went wrong.
    expect(MOBILE_HTML).not.toContain('${');
    expect(MOBILE_HTML.includes(String.fromCharCode(27))).toBe(false); // no raw ESC (0x1b)
  });
});
