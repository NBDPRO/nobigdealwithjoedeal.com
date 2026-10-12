/**
 * tests/my-skin-ambient-2026-10.test.js — ambient accent (design idea 01,
 * slice B5): the accent follows the picture on screen, tuned to read on the
 * page, with a tint option and a per-theme lock. Pure rules + contract.
 *
 * Run: node tests/my-skin-ambient-2026-10.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const L = require(path.join(ROOT, 'docs/pro/js/my-skin-logic.js'));

// A 32x32 RGBA sample filled by a function (i -> [r,g,b]).
function sample(fn) {
  const a = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 1024; i++) { const c = fn(i); a[i * 4] = c[0]; a[i * 4 + 1] = c[1]; a[i * 4 + 2] = c[2]; a[i * 4 + 3] = 255; }
  return a;
}
const hex = (s) => ({ r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16) });

console.log('\n1. accentFromSample');
{
  const red = L.accentFromSample(sample(() => [200, 30, 40]));
  ok('a red picture gives a red accent', /^#[0-9a-f]{6}$/.test(red) && hex(red).r > hex(red).g + 60 && hex(red).r > hex(red).b + 60, red);
  const mixed = L.accentFromSample(sample((i) => (i % 8 === 0 ? [30, 60, 220] : [40, 40, 40])));
  ok('a grey picture with a little blue gives blue (the vivid colour, not the grey)', hex(mixed).b > hex(mixed).r + 60, mixed);
  const majority = L.accentFromSample(sample((i) => (i < 700 ? [20, 180, 60] : [220, 40, 40])));
  ok('the heaviest hue wins', hex(majority).g > hex(majority).r, majority);
  ok('a greyscale picture has no accent', L.accentFromSample(sample((i) => { const v = i % 255; return [v, v, v]; })) === null);
  ok('an all-black or all-white picture has none', L.accentFromSample(sample(() => [0, 0, 0])) === null && L.accentFromSample(sample(() => [255, 255, 255])) === null);
  ok('empty or missing data is null, never a throw', L.accentFromSample(null) === null && L.accentFromSample([]) === null);
  const dull = L.accentFromSample(sample(() => [90, 80, 85]));
  ok('a nearly grey picture does not invent a vivid colour', dull === null || (function () { const c = L.rgbToHsl(hex(dull).r, hex(dull).g, hex(dull).b); return c[1] >= 0.55; })());
  const lightness = (h) => L.rgbToHsl(hex(h).r, hex(h).g, hex(h).b)[2];
  const yl = lightness(L.accentFromSample(sample(() => [250, 240, 30]))), pl = lightness(L.accentFromSample(sample(() => [60, 0, 120])));
  ok('the accent is nudged into a usable lightness (a bright yellow down, a deep purple up)', yl <= 0.62 + 0.01 && pl >= 0.42 - 0.01, yl + ' / ' + pl);
}

console.log('\n2. tuneAccent: reads on the page or is refused');
{
  const dark = '#0a0c0f', light = '#f6f4ef';
  const good = L.tuneAccent('#38e1ff', dark);
  ok('an accent that already passes is returned untouched', good && good.accent === '#38e1ff' && good.tuned === false && /^#/.test(good.fg));
  const dim = L.tuneAccent('#14202a', dark);
  ok('a too-dark accent on a dark page is lightened until it passes the check', dim && dim.tuned === true && L.accentCheck(dim.accent, dark).ok, JSON.stringify(dim));
  const pale = L.tuneAccent('#f3efe0', light);
  ok('a too-pale accent on a light page is darkened until it passes', pale && pale.tuned === true && L.accentCheck(pale.accent, light).ok, JSON.stringify(pale));
  ok('hue is kept while tuning', (function () { const a = L.rgbToHsl(...Object.values(hex('#14202a'))), b = L.rgbToHsl(...Object.values(hex(dim.accent))); return Math.abs(a[0] - b[0]) < 0.03; })());
  ok('bad input is null', L.tuneAccent('red', dark) === null && L.tuneAccent('#38e1ff', 'blue') === null && L.tuneAccent(null, dark) === null);
  ok('every tuned result passes accentCheck against its page (60 colours x 2 pages)', (function () {
    let bad = 0;
    for (let h = 0; h < 360; h += 12) for (const bg of [dark, light]) {
      const c = L.hslToHex(h / 360, 0.7, 0.5);
      const t = L.tuneAccent(c, bg);
      if (t && !L.accentCheck(t.accent, bg).ok) bad++;
    }
    return bad === 0;
  })());
}

console.log('\n3. tintOk');
{
  ok('a faint tint over a dark surface with light text passes', L.tintOk('#181c22', '#e5b800', '#e8eaf0', 0.09));
  ok('a tint that would sink the text contrast is refused', !L.tintOk('#d9d9d9', '#ff0000', '#555555', 0.5));
  ok('bad colours refuse', !L.tintOk('x', '#e5b800', '#ffffff') && !L.tintOk('#181c22', null, '#ffffff'));
}

console.log('\n4. data model');
{
  const n = L.normalize({ ambient: { follow: true, tint: 'yes' }, themes: { pokemon: { images: [{ id: 'lq3x9a1b2c', path: 'skins/u1/themes/pokemon/lq3x9a1b2c', v: 1, accent: '#E5B800' }], ambientLock: true } } });
  ok('ambient: only literal true switches a toggle on; both off by default', n.ambient.follow === true && n.ambient.tint === false && L.normalize({}).ambient.follow === false && L.normalize({}).ambient.tint === false);
  ok('the per-image accent is stored (lower-cased) and a junk one dropped', n.themes.pokemon.images[0].accent === '#e5b800'
    && L.normalize({ themes: { a: { images: [{ id: 'lq3x9a1b2c', path: 'skins/u1/themes/a/lq3x9a1b2c', accent: 'red' }] } } }).themes.a.images[0].accent === null);
  ok('the per-theme lock', n.themes.pokemon.ambientLock === true && L.normalize({ themes: { a: { images: [{ id: 'lq3x9a1b2c', path: 'skins/u1/themes/a/lq3x9a1b2c' }] } } }).themes.a.ambientLock === false);
}

console.log('\n5. page contract');
{
  const J = strip(read('docs/pro/js/my-skin.js'));
  const W = strip(read('docs/pro/js/my-skin-encode-worker.js'));
  ok('the accent is sampled at upload, in the page and in the worker', /accent: L\(\)\.accentFromSample\(d\)/.test(J) && /accent: L\.accentFromSample\(d\)/.test(W));
  ok('stored per image (single upload, import, company panel)', /accent: st\.accent \|\| null/.test(J) && /accent: st\.accent \|\| null/.test(strip(read('docs/pro/js/my-skin-import.js'))) && /accent: s\.accent \|\| null/.test(strip(read('docs/pro/js/my-skin-company.js'))));
  ok('the user\'s own accent colour always wins over the picture\'s', /var useAcc = own \|\| \(amb && cfg\.ambient\.follow \? amb\.accent : null\)/.test(J));
  ok('the picture\'s accent goes through accentCheck before it is painted (and tuning)', /L\(\)\.tuneAccent\(layerPic\.img\.accent, pageBg\(\)\)/.test(J) && /L\(\)\.accentCheck\(useAcc, pageBg\(\)\)/.test(J));
  ok('locked themes and hidden pictures never lend an accent', /slot && slot\.ambientLock\) return null/.test(J) && /cfg\.hidePictures\) return null/.test(J));
  ok('the tint class needs the contrast check', /tintAllowed\(amb\.accent\)/.test(J) && /L\(\)\.tintOk\(/.test(J));
  ok('the accent changes with each slideshow crossfade (paint runs on every commit)', /layerPic = \{ source: rr\.source[\s\S]*?paint\(\);/.test(J));
  const D = read('docs/pro/dashboard.html');
  ok('the three controls are in the panel', ['myskinAmbFollow', 'myskinAmbTint', 'myskinAmbLock'].every((i) => D.includes('id="' + i + '"')));
  const C = strip(read('docs/pro/css/my-skin.css'));
  ok('the tint rule is gated on the html class and --myskin-tint has a :where(:root) default',
    /:root\.my-skin-tint :is\(/.test(C) && /--myskin-tint:\s*#[0-9a-f]{6}/i.test((C.match(/:where\(:root\)\s*\{([^}]*)\}/) || [])[1] || ''));
  ok('both off by default: nothing changes for anyone who has not asked', L.normalize({ enabled: true }).ambient.follow === false);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
