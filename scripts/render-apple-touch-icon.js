#!/usr/bin/env node
/**
 * scripts/render-apple-touch-icon.js — rebuild docs/assets/images/apple-touch-icon.png
 * from the full lettered home-solutions mark. Run it whenever that source SVG
 * changes; nothing else does.
 *
 * WHY (2026-09-13)
 * ────────────────
 * #1467 (2026-09-07) redrew the favicon and hand-exported this PNG. The export
 * was malformed: a valid signature and a valid 180x180 IHDR, but the IDAT
 * chunk's declared length was short and its CRC wrong, so Chromium and WebKit
 * decoded the first rows (a navy band) and painted the rest black. It was the
 * iOS home-screen icon for every homeowner page for six days, and every gate
 * passed because every gate checked existence, signature or dimensions. The
 * fix is to make the PNG a build product of the SVG instead of a hand export.
 * tests/favicon-contract.test.js now walks every chunk of this file.
 *
 * SOURCE FIX (2026-09-16)
 * ───────────────────────
 * This used to render from docs/favicon.svg. The 2026-09-14 brand-pack
 * refresh (#1570) repointed docs/favicon.svg at the pack's wordless
 * `-small.svg` tier (roofline only — "NBD" lettering was deliberately
 * deferred to 192px+ app icons; see brand/logo-pack-2026-09/README.md).
 * Nobody updated this script's source to match, so every apple-touch-icon
 * rebuild since then silently inherited the wordless mark — the one
 * "large" homeowner-brand asset that exists (180×180, iOS/Android home
 * screen) never showed "NBD" lettering anywhere, while Pro's equivalent
 * (docs/pro/img/nbd-icon-192.png, copied from the pack's lettered 192px
 * master) always did. Jo confirmed both marks are meant to carry "NBD"
 * lettering. Source is now the pack's full lettered SVG directly (same
 * viewBox, same white tile, same corner radius as the old source — no
 * other pipeline change needed).
 *
 * WHAT
 * ────
 * 1. Chromium (the Playwright install under tests/node_modules) draws the SVG
 *    onto a 180x180 canvas over the tile colour, so the SVG's transparent
 *    rounded corners become navy — full-bleed, because iOS applies its own
 *    mask (the intent recorded in #1467).
 * 2. The pixels are asserted fully opaque and re-encoded as 8-bit RGB,
 *    non-interlaced, one IDAT, correct lengths and CRCs (Node zlib only).
 * 3. The encoded bytes are re-validated structurally, decoded again by
 *    Chromium, and compared channel-for-channel with the SVG render. Any
 *    difference aborts before the file is written.
 *
 * MORE SIZES (2026-09-27)
 * ───────────────────────
 * The homeowner site gained a web-app manifest (docs/manifest.webmanifest) and
 * sized rel="icon" PNGs, because large-tile consumers (Brave's saved-site
 * tiles, Android's home screen) ignore apple-touch-icon and were falling back
 * to the wordless favicon.svg. Every homeowner icon larger than a tab is now
 * rendered here from the pack's lettered SVGs, through the same pipeline and
 * the same read-back check: 180 (apple-touch), 192 and 512 (purpose "any"),
 * and 512 maskable, drawn from home-solutions-maskable.svg (full-bleed tile,
 * mark scaled to 66% so it sits inside the 80% safe-zone circle). The 180px
 * output is byte-identical to what this script produced before the change.
 * scripts/normalize-favicons.js pins the <head> tags that point at them.
 *
 * Usage:  node scripts/render-apple-touch-icon.js
 * Needs:  tests/node_modules (cd tests && npm ci) — not run in CI.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PACK = path.join(ROOT, 'brand', 'logo-pack-2026-09', 'icons');
const IMAGES = path.join(ROOT, 'docs', 'assets', 'images');
const TARGETS = [
  { svg: path.join(PACK, 'home-solutions-icon.svg'), out: path.join(IMAGES, 'apple-touch-icon.png'), size: 180 },
  { svg: path.join(PACK, 'home-solutions-icon.svg'), out: path.join(IMAGES, 'home-icon-192.png'), size: 192 },
  { svg: path.join(PACK, 'home-solutions-icon.svg'), out: path.join(IMAGES, 'home-icon-512.png'), size: 512 },
  { svg: path.join(PACK, 'home-solutions-maskable.svg'), out: path.join(IMAGES, 'home-icon-maskable-512.png'), size: 512 },
];
const TILE = '#ffffff'; // the tile colour in the source SVG (2026-09-14 brand refresh: was '#1a3057')

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodeRGB(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); // filter byte 0
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function validate(b) {
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('bad signature');
  let off = 8, ihdr = null; const idat = [];
  for (;;) {
    const len = b.readUInt32BE(off), type = b.slice(off + 4, off + 8).toString('latin1');
    if (off + 12 + len > b.length) throw new Error('chunk overrun at byte ' + off);
    if (crc32(b.slice(off + 4, off + 8 + len)) !== b.readUInt32BE(off + 8 + len)) throw new Error('bad CRC on ' + type);
    if (type === 'IHDR') ihdr = { w: b.readUInt32BE(off + 8), h: b.readUInt32BE(off + 12) };
    if (type === 'IDAT') idat.push(b.slice(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (off !== b.length) throw new Error('bytes after IEND');
  if (zlib.inflateSync(Buffer.concat(idat)).length !== (ihdr.w * 3 + 1) * ihdr.h) throw new Error('IDAT size mismatch');
  return ihdr;
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require(require.resolve('playwright', { paths: [path.join(ROOT, 'tests')] })));
  } catch (e) {
    console.error('render-apple-touch-icon: Playwright not found under tests/node_modules — run `npm ci` in tests/ first.');
    return 1;
  }
  const browser = await chromium.launch();
  try {
    for (const t of TARGETS) await renderTarget(browser, t);
    return 0;
  } finally {
    await browser.close();
  }
}

async function renderTarget(browser, { svg: SVG, out: OUT, size: SIZE }) {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  try {
    const draw = async (src, bg) => {
      await page.setContent(`<!doctype html><html><body style="margin:0"><canvas id="c" width="${SIZE}" height="${SIZE}"></canvas></body></html>`);
      return page.evaluate(async ({ src, bg, SIZE }) => {
        const img = new Image(); img.src = src; await img.decode();
        const ctx = document.getElementById('c').getContext('2d');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        return { w: img.naturalWidth, h: img.naturalHeight, data: Array.from(ctx.getImageData(0, 0, SIZE, SIZE).data) };
      }, { src, bg, SIZE });
    };

    const svg = await draw('data:image/svg+xml;base64,' + fs.readFileSync(SVG).toString('base64'), TILE);
    const rgb = Buffer.alloc(SIZE * SIZE * 3);
    for (let i = 0, j = 0; i < svg.data.length; i += 4, j += 3) {
      if (svg.data[i + 3] !== 255) throw new Error('non-opaque pixel after flattening at ' + i / 4);
      rgb[j] = svg.data[i]; rgb[j + 1] = svg.data[i + 1]; rgb[j + 2] = svg.data[i + 2];
    }
    const png = encodeRGB(SIZE, SIZE, rgb);
    validate(png);

    // Decode what we are about to write over magenta: any dropped row shows up as a mismatch.
    const back = await draw('data:image/png;base64,' + png.toString('base64'), '#ff00ff');
    let diff = 0;
    for (let i = 0; i < back.data.length; i++) if (back.data[i] !== svg.data[i]) diff++;
    if (back.w !== SIZE || back.h !== SIZE || diff) throw new Error(`read-back mismatch on ${path.basename(OUT)}: ${back.w}x${back.h}, ${diff} channel(s) differ`);

    const before = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
    if (before && before.equals(png)) { console.log(`render-apple-touch-icon: ${path.relative(ROOT, OUT)} already matches ${path.basename(SVG)} (${png.length} bytes).`); return; }
    fs.writeFileSync(OUT, png);
    console.log(`render-apple-touch-icon: wrote ${path.relative(ROOT, OUT)} — ${SIZE}x${SIZE} RGB from ${path.basename(SVG)}, ${png.length} bytes, read-back identical to the SVG render.`);
  } finally {
    await page.close();
  }
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error('render-apple-touch-icon:', e.message); process.exit(1); });

module.exports = { encodeRGB, validate, crc32, TARGETS };
