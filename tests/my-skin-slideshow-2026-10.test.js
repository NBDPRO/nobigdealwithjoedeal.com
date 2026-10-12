/**
 * tests/my-skin-slideshow-2026-10.test.js — My Skin slideshows (slice B3):
 * the pure rules (interval plan with its automatic adjustments, shuffle bag,
 * load-mode stepping, the hidden-tab timer, preload lead, ordering), the
 * "use for all" snapshot, orphans, category sharing, and the page contract.
 *
 * Run: node tests/my-skin-slideshow-2026-10.test.js
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
const img = (id, theme) => ({ id: id, path: 'skins/u1/themes/' + (theme || 'pokemon') + '/' + id, v: 1, w: 10, h: 10, bytes: 5, type: 'image/webp' });
const res = (n, o) => Object.assign({ images: Array.from({ length: n }, (_, i) => img('lq3x9a1b2' + i)), interval: '5m', shuffle: false, fadeMs: 800 }, o || {});

console.log('\n1. slideshowPlan: settings and the automatic adjustments');
{
  const p = (r, c) => L.slideshowPlan(r, c || {});
  ok('one picture never rotates', p(res(1)).mode === 'static');
  ok('defaults: every 5 min, 0.8 s fade', p(res(3)).mode === 'timed' && p(res(3)).ms === 300000 && p(res(3)).fadeMs === 800);
  ok('every interval maps to its milliseconds', ['30s', '1m', '5m', '15m'].map((i) => p(res(2, { interval: i })).ms).join() === '30000,60000,300000,900000');
  ok('"load" steps only on a load / theme switch', p(res(3, { interval: 'load' })).mode === 'load');
  ok('"off" always shows the first picture', p(res(3, { interval: 'off' })).mode === 'static');
  const rm = p(res(3), { reducedMotion: true });
  ok('reduced motion: load mode, no fade, and says why', rm.mode === 'load' && rm.fadeMs === 0 && rm.reason === 'reduced-motion');
  ok('Data Saver: load mode', p(res(3), { saveData: true }).mode === 'load' && p(res(3), { saveData: true }).reason === 'data-saver');
  const ph = p(res(3, { interval: '30s' }), { narrow: true });
  ok('phones: a 30 s setting runs at 1 min and says so', ph.mode === 'timed' && ph.ms === 60000 && ph.reason === 'phone-minimum');
  ok('phones: 5 min is left alone', p(res(3), { narrow: true }).ms === 300000 && p(res(3), { narrow: true }).reason === null);
  ok('low battery pauses rotation', p(res(3), { lowBattery: true }).mode === 'static' && p(res(3), { lowBattery: true }).reason === 'low-battery');
  ok('automatic adjustments win over an own setting', p(res(3, { interval: '30s' }), { reducedMotion: true }).mode === 'load');
  ok('a per-theme fade of 0 stays 0; unknown interval falls back to 5 min',
    p(res(3, { fadeMs: 0 })).fadeMs === 0 && p(res(3, { interval: 'weird' })).ms === 300000);
}

console.log('\n2. shuffle bag, in-order, load stepping');
{
  let seq = 7; const rnd = () => { seq = (seq * 9301 + 49297) % 233280; return seq / 233280; };
  ok('makeBag is a permutation', L.makeBag(6, rnd, -1).slice().sort().join() === '0,1,2,3,4,5');
  let bad = 0;
  for (let k = 0; k < 400; k++) { const b = L.makeBag(4, rnd, k % 4); if (b[0] === k % 4) bad++; }
  ok('the last picture of a cycle never starts the next', bad === 0, bad + ' repeats');
  let st = null, order = [], idx;
  for (let i = 0; i < 12; i++) { const r = L.nextSlide(st, 3, true, rnd); st = r.state; order.push(r.idx); }
  let imm = 0; for (let i = 1; i < order.length; i++) if (order[i] === order[i - 1]) imm++;
  ok('shuffled: no immediate repeat across 4 cycles, every picture shown each cycle',
    imm === 0 && [0, 3, 6, 9].every((s) => order.slice(s, s + 3).slice().sort().join() === '0,1,2'), order.join());
  st = null; order = [];
  for (let i = 0; i < 7; i++) { const r = L.nextSlide(st, 3, false, rnd); st = r.state; order.push(r.idx); }
  ok('in order: the first picture first, then 1, 2, wrap', order.join() === '0,1,2,0,1,2,0');
  ok('one picture: always 0', L.nextSlide(null, 1, true, rnd).idx === 0);
  ok('load mode in order: first load shows picture 1, then steps and wraps',
    L.loadSlide(null, 3, false) === 0 && L.loadSlide(0, 3, false) === 1 && L.loadSlide(2, 3, false) === 0);
  let same = 0; for (let k = 0; k < 300; k++) if (L.loadSlide(k % 4, 4, true, rnd) === k % 4) same++;
  ok('load mode shuffled never repeats the last picture', same === 0);
}

console.log('\n3. timer across a hidden tab, preload lead, ordering');
{
  let t = L.timerStart(300000, 1000);
  ok('start: due at now + interval', t.dueAt === 301000 && t.remaining === 300000 && !t.paused);
  const h = L.timerHide(t, 61000);
  ok('hide keeps the time that was left', h.paused && h.remaining === 240000 && h.dueAt === null);
  const s = L.timerShow(h, 500000);
  ok('show resumes with exactly the remaining time', s.dueAt === 740000 && !s.paused);
  ok('hiding after it was due leaves 0, never negative', L.timerHide(t, 999999).remaining === 0);
  ok('preload: right away for 30 s, 5 s early otherwise', L.preloadDelay(30000) === 0 && L.preloadDelay(60000) === 55000 && L.preloadDelay(300000) === 295000);
  ok('moveItem reorders without mutating', (function () { const a = [1, 2, 3, 4]; const b = L.moveItem(a, 0, 2); return a.join() === '1,2,3,4' && b.join() === '2,3,1,4'; })());
  ok('moveItem out of range is a no-op', L.moveItem([1, 2], 0, 5).join() === '1,2' && L.moveItem([1, 2], -1, 0).join() === '1,2');
}

console.log('\n4. use for all, orphans, category sharing');
{
  const cfg = L.normalize({ enabled: true, perTheme: true, themes: { pokemon: { images: [img('lq3x9a1b2c')] } },
    allThemes: { imageRef: 'pokemon/lq3x9a1b2c', image: img('lq3x9a1b2c') } });
  const gone = L.normalize({ enabled: true, perTheme: true, themes: {}, allThemes: { imageRef: 'pokemon/lq3x9a1b2c', image: img('lq3x9a1b2c') } });
  ok('the all-themes entry keeps a snapshot, so a cleared host theme cannot strand it',
    L.resolveBackground(gone, 'batman').source === 'all' && L.resolveBackground(gone, 'batman').images[0].id === 'lq3x9a1b2c');
  ok('the snapshot keeps the object referenced (never deleted under it)', L.referencedPaths(gone)['skins/u1/themes/pokemon/lq3x9a1b2c'] === 1);
  ok('without a snapshot (an older doc) the host entry is used', L.resolveBackground(L.normalize({ enabled: true, perTheme: true,
    themes: { pokemon: { images: [img('lq3x9a1b2c')] } }, allThemes: { imageRef: 'pokemon/lq3x9a1b2c' } }), 'batman').source === 'all');
  ok('a theme with its own pictures still beats "all"', L.resolveBackground(cfg, 'pokemon').source === 'theme');
  const c2 = L.normalize({ themes: { pokemon: { images: [img('lq3x9a1b2c')] }, 'old-theme': { images: [img('lq3x9a1b2d', 'old-theme')] }, _custom: { images: [img('lq3x9a1b2e', '_custom')] } } });
  ok('orphans: ids the engine no longer has, never _custom', L.orphanThemeIds(c2, ['pokemon', 'batman']).join() === 'old-theme');
  ok('orphans: none when everything exists', L.orphanThemeIds(c2, ['pokemon', 'old-theme']).length === 0);
  const cats = { pokemon: 'popculture', batman: 'popculture', mario: 'popculture', zen: 'nature' };
  const c3 = L.normalize({ themes: { pokemon: { images: [img('lq3x9a1b2c')] }, mario: { images: [img('lq3x9a1b2d', 'mario')] } } });
  ok('category sharing targets the same category without a picture, never itself',
    L.categoryCopyTargets(c3, 'pokemon', cats).join() === 'batman' && L.categoryCopyTargets(c3, 'pokemon', { pokemon: 'x' }).length === 0);
}

console.log('\n5. page contract');
{
  const J = strip(read('docs/pro/js/my-skin.js'));
  ok('one slideshow timer, cleared by every theme change and stop', /function stopSlides\(\) \{ clearSlideTimers\(\)/.test(J) && /var seq = \+\+switchSeq/.test(J));
  ok('only the NEXT picture is fetched ahead', /function preloadUpcoming/.test(J) && /slide\.upcoming\.idx/.test(J) && !/images\.forEach\(function \(im\) \{ acquire/.test(J));
  ok('hidden tab pauses and resumes with the time left', /addEventListener\('visibilitychange', onVisibility\)/.test(J) && /L\(\)\.timerHide\(slide\.t/.test(J) && /L\(\)\.timerShow\(slide\.t/.test(J));
  ok('the editor open on this theme holds rotation', /function panelOpenOn/.test(J) && /panelOpenOn\(key\)\) \{ startSlideTimer/.test(J));
  ok('load-mode position lives in sessionStorage under nbd_myskin_pos_ (swept at sign-out)', /'nbd_myskin_pos_' \+ k/.test(J) && /'nbd_myskin_'/.test(J));
  ok('battery is read when the browser offers it, optional', /navigator\.getBattery/.test(J) && /b\.level < 0\.2/.test(J));
  ok('reduced-motion changes re-run the picker', /rm\.addEventListener\('change'/.test(J));
  ok('at most 6 pictures: add is refused past the cap with the toast', /Up to ' \+ L\(\)\.MAX_IMAGES_PER_THEME \+ ' pictures per theme/.test(J));
  ok('removing a picture deletes the object only when nothing else uses it', /removeThemeImage[\s\S]*?deleteUnreferenced\(gone\)/.test(J));
  ok('reorder: pointer drag by the handle and ArrowUp/ArrowDown on the item', /data-myskin-handle/.test(J) && /e\.key !== 'ArrowUp' && e\.key !== 'ArrowDown'/.test(J) && /touch-action: none/.test(read('docs/pro/css/my-skin.css')));
  ok('"use for all" and share-with-category are two-tap', /twoTap\('all'/.test(J) && /twoTap\('copy'/.test(J));
  ok('still no token URL, still no browser storage for settings', !/getDownloadURL/.test(J) && !/localStorage/.test(J));
  const D = read('docs/pro/dashboard.html');
  const ids = ['myskinStrip', 'myskinThemeShowDefault', 'myskinThemeInterval', 'myskinThemeOrder', 'myskinThemeFade', 'myskinShowNote',
    'myskinShowInterval', 'myskinShowOrder', 'myskinShowFade', 'myskinShowReset'];
  ok('the strip, the per-theme and the global slideshow controls are in the panel', ids.every((i) => D.includes('id="' + i + '"')), ids.filter((i) => !D.includes('id="' + i + '"')).join());
  ok('fade presets Off / 0.4 / 0.8 / 1.5 s', ['0', '400', '800', '1500'].every((v) => D.includes('data-myskin-fade-preset="' + v + '"')));
  ok('every interval option is offered', ['load', '30s', '1m', '5m', '15m', 'off'].every((v) => new RegExp('id="myskinShowInterval"[^>]*>[\\s\\S]*?value="' + v + '"').test(D)));
  const M = strip(read('docs/pro/js/my-skin-import.js'));
  ok('the grid lists removed themes with Move and Delete (two-tap)', /Removed themes/.test(M) && /data-orphan-delete/.test(M) && /Tap again to delete/.test(M));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
