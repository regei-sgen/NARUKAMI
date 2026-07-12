import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { firefox, webkit, type BrowserType } from 'playwright';
import { deviceProfile } from './playwrightRenderCore';

// These tests launch the REAL Gecko/WebKit engines and prove the screenshot
// pipeline produces genuine JPEG frames. They're skipped automatically on
// machines where the browsers aren't downloaded, so the suite stays portable.
function installed(bt: BrowserType): boolean {
  try {
    const p = bt.executablePath();
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}
const hasFirefox = installed(firefox);
const hasWebkit = installed(webkit);

// JPEG frames start with the SOI marker 0xFFD8.
function isJpeg(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

async function renderOnce(engine: BrowserType, engineId: string) {
  const profile = deviceProfile(engineId, 390, 700);
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: profile.deviceScaleFactor,
      isMobile: profile.isMobile,
      hasTouch: profile.hasTouch,
      userAgent: profile.userAgent,
    });
    const page = await context.newPage();
    await page.setContent('<h1 style="color:rebeccapurple">real render</h1>');
    const reportedUa = await page.evaluate(() => navigator.userAgent);
    const shot = await page.screenshot({ type: 'jpeg', quality: 55 });
    await context.close();
    return { shot, reportedUa };
  } finally {
    await browser.close();
  }
}

describe.skipIf(!hasFirefox)('real Firefox (Gecko) render', () => {
  it('launches and screenshots a real Gecko page as JPEG', async () => {
    const { shot, reportedUa } = await renderOnce(firefox, 'firefox');
    expect(isJpeg(shot)).toBe(true);
    expect(reportedUa).toContain('Firefox'); // genuine Gecko, not spoofed Chromium
  }, 60_000);
});

describe.skipIf(!hasWebkit)('real WebKit render', () => {
  it('launches and screenshots a real WebKit page as JPEG', async () => {
    const { shot, reportedUa } = await renderOnce(webkit, 'safari');
    expect(isJpeg(shot)).toBe(true);
    // WebKit reports an AppleWebKit/Safari UA (its real default), not Chrome.
    expect(reportedUa).toMatch(/AppleWebKit|Safari/);
  }, 60_000);

  it('emulates iPhone Safari (iOS UA + touch) on the real WebKit engine', async () => {
    const { reportedUa } = await renderOnce(webkit, 'safari-ios');
    expect(reportedUa).toContain('iPhone');
  }, 60_000);
});
