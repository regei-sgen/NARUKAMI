// Render build/icon-src.html to build/icon.png (and the frontend favicon) using
// the Electron that already ships with this repo — no image toolchain to install.
//
//   npm run icon -w desktop
//
// electron-builder turns build/icon.png into the .ico for the taskbar, tray and
// installer, so this is the single source of truth for the app mark.
import { app, BrowserWindow, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repoRoot = path.join(desktop, '..', '..');
const SRC = path.join(desktop, 'build', 'icon-src.html');

/**
 * size -> output file. Only the 1024 master is emitted: electron-builder derives
 * every .ico size from it. The web favicon is hand-kept as SVG
 * (packages/frontend/public/favicon.svg) so it stays scalable and maskable.
 */
const TARGETS = [{ size: 1024, out: path.join(desktop, 'build', 'icon.png') }];

/**
 * Render the source once at its native 1024, then derive every other size from
 * that single capture. Loading the page per size raced the compositor and the
 * second load failed with ERR_FAILED; one capture is also the only way the
 * favicon is guaranteed to be pixel-identical to the app icon.
 */
async function renderMaster() {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    // MUST stay transparent. capturePage() composites the page onto the window
    // background, so an opaque backgroundColor here bakes a solid square into
    // the PNG's alpha — which is exactly how the icon ended up as a black box.
    transparent: true,
    backgroundColor: '#00000000',
  });
  await win.loadFile(SRC);
  // One frame is not always enough for the filters/gradients to composite.
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  win.destroy();
  return img;
}

function emit(master, size, out) {
  const img = size === 1024 ? master : master.resize({ width: size, height: size, quality: 'best' });
  fs.writeFileSync(out, img.toPNG());
  console.log(`[icon] ${path.relative(repoRoot, out)}  ${size}x${size}  ${fs.statSync(out).size} bytes`);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`[icon] missing source: ${SRC}`);
    app.exit(1);
    return;
  }
  try {
    const master = await renderMaster();
    for (const t of TARGETS) emit(master, t.size, t.out);
    // Small-size proofs: the whole risk with a glassy mark is that it turns to
    // mush in the tray/title bar, so always emit these to eyeball.
    const previewDir = process.env.ICON_PREVIEW_DIR;
    if (previewDir) {
      fs.mkdirSync(previewDir, { recursive: true });
      for (const s of [16, 24, 32, 48, 64]) {
        emit(master, s, path.join(previewDir, `icon-${s}.png`));
      }
    }
    console.log('[icon] done');
    app.exit(0);
  } catch (err) {
    console.error('[icon] failed:', err);
    app.exit(1);
  }
});
