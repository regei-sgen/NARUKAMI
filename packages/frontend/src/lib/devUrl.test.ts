import { describe, expect, it } from 'vitest';
import { detectDevUrl, pushWindow, stripAnsi, DEV_URL_WINDOW } from './devUrl';

describe('detectDevUrl', () => {
  it('finds a Vite-style local URL', () => {
    const w = pushWindow('', '  ➜  Local:   http://localhost:5173/\r\n');
    expect(detectDevUrl(w)).toBe('http://localhost:5173/');
  });

  it('sees through ANSI color codes splitting the line', () => {
    const w = pushWindow('', '\x1b[32m➜\x1b[39m Local: \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n');
    expect(detectDevUrl(w)).toBe('http://localhost:5173/');
  });

  it('takes the LAST url when the port changes on restart', () => {
    let w = pushWindow('', 'Local: http://localhost:3000/\n');
    w = pushWindow(w, 'Port 3000 in use, trying another...\nLocal: http://localhost:3001/\n');
    expect(detectDevUrl(w)).toBe('http://localhost:3001/');
  });

  it('normalizes 0.0.0.0 to localhost and trims trailing punctuation', () => {
    expect(detectDevUrl('listening on http://0.0.0.0:8080.')).toBe('http://localhost:8080');
    expect(detectDevUrl('(see http://127.0.0.1:4000)')).toBe('http://127.0.0.1:4000');
  });

  it('ignores non-loopback URLs', () => {
    expect(detectDevUrl('docs at https://vitejs.dev/config/')).toBeNull();
  });

  it('matches a URL that straddles two chunks', () => {
    let w = pushWindow('', 'Local: http://local');
    w = pushWindow(w, 'host:5173/');
    expect(detectDevUrl(w)).toBe('http://localhost:5173/');
  });

  it('caps the rolling window', () => {
    const w = pushWindow('x'.repeat(DEV_URL_WINDOW + 500), 'y');
    expect(w.length).toBe(DEV_URL_WINDOW);
  });

  it('stripAnsi removes OSC title sequences too', () => {
    expect(stripAnsi('\x1b]0;npm run dev\x07hello')).toBe('hello');
  });
});
