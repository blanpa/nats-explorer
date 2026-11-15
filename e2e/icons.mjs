/**
 * Every icon of the application, rendered from go-server/build/logo.svg.
 *
 * They were rendered by hand so far, 22 files for three platforms, and a
 * changed logo meant finding out again which of them fill their canvas and
 * which leave a margin. This is the list:
 *
 *   bun run --filter e2e icons               # or: node e2e/icons.mjs
 *
 * PW_CHROME=/usr/bin/google-chrome uses a locally installed Chrome instead of
 * the Playwright-managed Chromium. The header mark and the favicon are inline
 * SVG (client/src/components/layout/Header.tsx, client/index.html) and are
 * changed there.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = resolve(ROOT, 'go-server', 'build');
const MSIX = resolve(BUILD, 'windows', 'msix', 'Assets');

// The drawing as it is in the file leaves a margin around the tile, which is
// what Linux and macOS expect of an application icon. Windows, the Store and
// the documentation site show the tile edge to edge.
const padded = readFileSync(resolve(BUILD, 'logo.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const bleed = padded.replace(/viewBox="[^"]*"/, 'viewBox="0 0 32 32"');
if (bleed === padded) throw new Error('logo.svg has no viewBox to replace');

const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : undefined);
const page = await browser.newPage({ deviceScaleFactor: 1 });

/** The drawing at `size` pixels, centred on a transparent canvas of width x height. */
async function png(svg, width, height = width, size = Math.min(width, height)) {
  await page.setViewportSize({ width, height });
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  await page.setContent(
    `<style>html,body{margin:0;height:100%;background:transparent}body{display:flex;align-items:center;justify-content:center}svg{display:block;flex:none}</style>${sized}`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } });
}

/** An .ico that holds the given PNGs as they are (Windows Vista and later read them). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(i => i.data)]);
}

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(path.slice(ROOT.length + 1));
};

// macOS (Wails makes the .icns from it) and Linux (.deb, AppImage, Flatpak).
write(resolve(BUILD, 'appicon.png'), await png(padded, 1024));
write(resolve(BUILD, 'linux', 'icon-512.png'), await png(padded, 512));

// The README, the documentation site and its favicon.
write(resolve(ROOT, 'docs', 'assets', 'images', 'logo.png'), await png(bleed, 1024));

// The Windows executable and installer.
const icoSizes = [16, 32, 48, 64, 128, 256];
write(resolve(BUILD, 'windows', 'icon.ico'), ico(await Promise.all(icoSizes.map(async size => ({ size, data: await png(bleed, size) })))));

// The Store package. A name without a qualifier in AppxManifest.xml resolves
// to these through resources.pri (scripts/build-msix.ps1).
for (const [scale, factor] of [
  [100, 1],
  [200, 2],
]) {
  write(resolve(MSIX, `Square150x150Logo.scale-${scale}.png`), await png(bleed, 150 * factor));
  write(resolve(MSIX, `Square44x44Logo.scale-${scale}.png`), await png(bleed, 44 * factor));
  write(resolve(MSIX, `StoreLogo.scale-${scale}.png`), await png(bleed, 50 * factor));
  write(resolve(MSIX, `Wide310x150Logo.scale-${scale}.png`), await png(bleed, 310 * factor, 150 * factor, 120 * factor));
}
// The taskbar and the start menu list; "unplated" is the one Windows shows
// without a backplate, and the tile is its own.
for (const size of [16, 24, 32, 48, 256]) {
  const data = await png(bleed, size);
  write(resolve(MSIX, `Square44x44Logo.targetsize-${size}.png`), data);
  write(resolve(MSIX, `Square44x44Logo.targetsize-${size}_altform-unplated.png`), data);
}

await browser.close();
