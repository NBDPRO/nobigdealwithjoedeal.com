/**
 * tests/tracker-barcode-decoder-2026-10-20.test.js
 *
 * iPhone Safari has no BarcodeDetector, so "Find a food" loads a vendored
 * ZXing build on demand (docs/assets/vendor/zxing/). This proves, with the
 * REAL vendored file:
 *   - the file is the exact reviewed build (sha256 pin) and does nothing
 *     nasty (no eval / Function / fetch / XHR / WebAssembly / sockets),
 *   - it actually reads an EAN-13 and a UPC-A image rendered here from the
 *     barcode spec (positive control) and does not invent one from noise or a
 *     blank frame (negative controls),
 *   - the UI loads it lazily, only without a native detector, and releases the
 *     camera.
 * Synthetic images only; no network.
 *
 * Run: node tests/tracker-barcode-decoder-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'docs', 'assets', 'vendor', 'zxing');
const FILE = path.join(VENDOR, 'zxing-library-0.21.3.min.js');
const S = require(path.join(ROOT, 'docs', 'pro', 'daily-success', 'js', 'food-search-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

// ── 1. the vendored file is the reviewed one ───────────────────────────
console.log('\n1. the vendored build');
const bytes = fs.readFileSync(FILE);
const src = bytes.toString('utf8');
ok('byte-identical to the build that was reviewed (sha256 pin)',
  crypto.createHash('sha256').update(bytes).digest('hex') === 'd7cc8f69dd70bdcf3ac00c9ae572bf2acb9f4132ba379c72df842e4db918652d');
ok('no newline bytes, so git line-ending conversion can never alter it', !bytes.includes(10) && !bytes.includes(13));
ok('the licence travels with it, and VENDOR.txt records source + pin',
  fs.existsSync(path.join(VENDOR, 'LICENSE')) && /sha256:\s+d7cc8f69/.test(fs.readFileSync(path.join(VENDOR, 'VENDOR.txt'), 'utf8')) && /zxing-js\/library/.test(fs.readFileSync(path.join(VENDOR, 'VENDOR.txt'), 'utf8')));
ok('no eval, new Function, network, WebAssembly or sockets in it',
  !/\beval\(|new Function\(|\bfetch\(|XMLHttpRequest|WebAssembly|WebSocket|sendBeacon|importScripts/.test(src));
ok('under 400 KB (loaded only on demand)', bytes.length < 400 * 1024);

// ── 2. it really decodes ──────────────────────────────────────────────
console.log('\n2. decoding (real library, rendered barcodes)');
// The ZXing UMD wants a `self`/`globalThis`; load it in a vm sandbox like a page would.
const sandbox = { console }; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const Z = sandbox.ZXing;
ok('exposes the reader classes the UI uses', ['MultiFormatReader', 'BinaryBitmap', 'HybridBinarizer', 'HTMLCanvasElementLuminanceSource', 'RGBLuminanceSource'].every((k) => typeof Z[k] === 'function')
  && typeof Z.DecodeHintType === 'object' && typeof Z.BarcodeFormat === 'object');

// EAN-13 / UPC-A renderer, straight from the spec (L/G/R code tables + first-digit parity).
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((c) => c.replace(/[01]/g, (b) => (b === '0' ? '1' : '0')));
const G = R.map((c) => c.split('').reverse().join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
function ean13Modules(code) {
  const d = code.split('').map(Number), par = PARITY[d[0]];
  let m = '101';
  for (let i = 0; i < 6; i++) m += (par[i] === 'L' ? L : G)[d[i + 1]];
  m += '01010';
  for (let i = 0; i < 6; i++) m += R[d[i + 7]];
  return m + '101';
}
function render(modules, opts) {
  const o = Object.assign({ mod: 3, h: 90, quiet: 12, noise: 0 }, opts || {});
  const w = (modules.length + 2 * o.quiet) * o.mod, h = o.h + 20;
  const px = new Uint8ClampedArray(w * h).fill(255);
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] !== '1') continue;
    for (let y = 10; y < 10 + o.h; y++) for (let x = 0; x < o.mod; x++) px[y * w + (o.quiet + i) * o.mod + x] = 0;
  }
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  if (o.noise) for (let i = 0; i < px.length; i++) px[i] = Math.max(0, Math.min(255, px[i] + (rnd() - 0.5) * o.noise));
  return { px, w, h };
}
function decode(img, formats) {
  const reader = new Z.MultiFormatReader();
  reader.setHints(new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, formats || [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A]], [Z.DecodeHintType.TRY_HARDER, true]]));
  const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(img.px, img.w, img.h)));
  try { return reader.decodeWithState(bmp).getText(); } catch (e) { return null; }
}

const NUTELLA = '3017620422003';                       // valid EAN-13
ok('test barcode passes the app\'s own check digit', S.validBarcode(NUTELLA));
ok('POSITIVE CONTROL: a rendered EAN-13 reads back exactly', decode(render(ean13Modules(NUTELLA))) === NUTELLA, String(decode(render(ean13Modules(NUTELLA)))));
ok('...at a smaller module size and with sensor-style noise (a phone frame is never clean)',
  decode(render(ean13Modules(NUTELLA), { mod: 2, noise: 50 })) === NUTELLA);
ok('...and a US UPC-A (EAN-13 with a leading 0) reads as a valid 12/13-digit GTIN',
  (() => { const t = decode(render(ean13Modules('0012345678905'))); return /^0?012345678905$/.test(String(t)) && S.validBarcode(t); })());
const onlyQr = decode(render(ean13Modules(NUTELLA)), [Z.BarcodeFormat.QR_CODE]);
ok('NEGATIVE: the format hint is honoured (QR-only reader ignores a 1D barcode)', onlyQr === null);
ok('NEGATIVE: a blank white frame reads nothing', decode({ px: new Uint8ClampedArray(400 * 200).fill(255), w: 400, h: 200 }) === null);
ok('NEGATIVE: pure noise reads nothing', decode(render('0'.repeat(100), { noise: 200 })) === null);
const corrupt = ean13Modules(NUTELLA).split(''); for (let i = 20; i < 28; i++) corrupt[i] = corrupt[i] === '1' ? '0' : '1';
const garbled = decode(render(corrupt.join('')));
ok('NEGATIVE: a damaged barcode never returns a wrong-but-valid-looking number', garbled === null || garbled === NUTELLA || !S.validBarcode(garbled), String(garbled));

// ── 3. the UI uses it safely ──────────────────────────────────────────
console.log('\n3. the UI wiring');
const ui = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'daily-success', 'js', 'food-search-ui.js'), 'utf8').replace(/\r\n/g, '\n');
const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('the decoder path in the UI is the pinned vendored file', code.includes("'/assets/vendor/zxing/zxing-library-0.21.3.min.js'"));
ok('it is NOT in the page\'s script tags (loaded on demand only)', !/zxing/i.test(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'daily-success', 'index.html'), 'utf8')));
ok('native BarcodeDetector is preferred; the decoder is only the fallback', /if \(hasNativeDetector\(\)\) \{[\s\S]*?BarcodeDetector[\s\S]*?\}\s*const Z = await loadDecoder\(\)/.test(code));
ok('a failed or slow decoder download falls back to typing the digits', /decoder timeout/.test(code) && /DECODER_TIMEOUT_MS/.test(code) && /Could not start the scanner/.test(code) && /codeBox = true/.test(code));
ok('only a check-digit-valid number is ever looked up', (code.match(/S\(\)\.validBarcode\(/g) || []).length >= 3);
ok('decodeWithState (not decode) is used - decode() resets the hints that were just set', code.includes('reader.decodeWithState(bitmap)') && !code.includes('reader.decode(bitmap)'));
  ok('the camera stream is stopped on a hit, on Stop and on failure', /getTracks\(\)\.forEach/.test(code) && (code.match(/stopScan\(\)/g) || []).length >= 4);
ok('video is playsinline + muted (iOS refuses inline playback otherwise)', /playsinline/.test(code) && /muted = true/.test(code));
ok('frames are downscaled before decoding (a 4K phone frame would stall the page)', /Math\.min\(1, 720 \/ w\)/.test(code));
ok('no eval / inline handlers added', !/\beval\(|new Function|\bon[a-z]+\s*=\s*["']/.test(code));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
