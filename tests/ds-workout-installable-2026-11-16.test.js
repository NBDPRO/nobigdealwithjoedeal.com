/**
 * tests/ds-workout-installable-2026-11-16.test.js
 *
 * Daily Success and the Workout Coach each install as their own home-screen app (Jo, 2026-11-16):
 *
 *   1. Two manifests (docs/pro/daily-success.webmanifest, docs/pro/workout.webmanifest), each with its own id, scope, start_url
 *      and icons, none of them NBD Pro's: Android tells installed apps apart by id, so a shared one would install as NBD Pro.
 *   2. The icons are real PNGs of the stated size (every chunk walked, lengths and CRCs checked: the 2026-09 apple-touch-icon
 *      passed every existence check while half of it decoded black).
 *   3. /pro/workout is a standalone page: the same coach files, at the SAME ?v= as the Daily Success page (one copy of the coach,
 *      one offline cache entry per file), with the page helpers it needs loaded BEFORE the coach. No inline script, no on*= handlers.
 *   4. The helpers behave as app.js's do: todayKey() is the LOCAL date; dsSettingsChanged() stamps the key and pushes.
 *   5. The service worker keeps an offline shell for /pro/workout, and firebase.json gives it the tracker's headers.
 *
 * Run: node tests/ds-workout-installable-2026-11-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// Walks a PNG: signature, every chunk's length and CRC, IHDR size, IEND last, and the pixel data inflates to the right length.
function pngInfo(file) {
  const b = fs.readFileSync(path.join(ROOT, file));
  if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return { err: 'bad signature' };
  let off = 8, w = 0, h = 0, depth = 0, colour = 0, last = '';
  const idat = [];
  while (off < b.length) {
    if (off + 12 > b.length) return { err: 'truncated chunk header' };
    const len = b.readUInt32BE(off), type = b.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > b.length) return { err: 'chunk ' + type + ' runs past the file' };
    const crc = b.readUInt32BE(off + 8 + len);
    if ((zlib.crc32(b.subarray(off + 4, off + 8 + len)) >>> 0) !== crc) return { err: 'bad CRC on ' + type };
    if (type === 'IHDR') { w = b.readUInt32BE(off + 8); h = b.readUInt32BE(off + 12); depth = b[off + 16]; colour = b[off + 17]; }
    if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    last = type; off += 12 + len;
  }
  if (last !== 'IEND') return { err: 'no IEND' };
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return { err: 'pixel data does not inflate' }; }
  const want = h * (1 + Math.ceil(w * channels * depth / 8));
  if (raw.length !== want) return { err: 'pixel data is ' + raw.length + ' bytes, expected ' + want };
  return { w, h, alpha: colour === 6 || colour === 4 };
}

const APPS = [
  { name: 'Daily Success', manifest: 'docs/pro/daily-success.webmanifest', id: '/pro/daily-success', prefix: 'ds', page: 'docs/pro/daily-success/index.html' },
  { name: 'Workout', manifest: 'docs/pro/workout.webmanifest', id: '/pro/workout', prefix: 'workout', page: 'docs/pro/workout/index.html' },
];
const PRO = JSON.parse(read('docs/pro/manifest.json'));

console.log('\n1. Manifests');
const ids = new Set();
for (const a of APPS) {
  const m = JSON.parse(read(a.manifest));
  ids.add(m.id);
  ok(a.name + ': id, start_url and scope are its own path', m.id === a.id && m.start_url === a.id && m.scope === a.id, JSON.stringify([m.id, m.start_url, m.scope]));
  ok(a.name + ': not NBD Pro\'s start page or scope', m.start_url !== PRO.start_url && m.scope !== PRO.scope);
  ok(a.name + ': opens standalone, with a short name that fits under an icon', m.display === 'standalone' && typeof m.short_name === 'string' && m.short_name.length > 0 && m.short_name.length <= 13);
  const purposes = m.icons.map((i) => i.purpose + ':' + i.sizes).sort().join(',');
  ok(a.name + ': 192 and 512 icons, "any" and "maskable"', purposes === 'any:192x192,any:512x512,maskable:192x192,maskable:512x512', purposes);
  ok(a.name + ': every icon is its own (none of NBD Pro\'s)', m.icons.every((i) => i.src.indexOf('/pro/img/' + a.prefix + '-icon') === 0 && !PRO.icons.some((p) => p.src === i.src)));
  for (const i of m.icons) {
    const file = 'docs' + i.src;
    const info = exists(file) ? pngInfo(file) : { err: 'missing' };
    const size = Number(i.sizes.split('x')[0]);
    ok(a.name + ': ' + i.src + ' is a sound ' + i.sizes + ' PNG', !info.err && info.w === size && info.h === size, info.err || (info.w + 'x' + info.h));
    // a maskable icon is cropped to a circle or squircle by the launcher: it must be a full, opaque tile
    if (i.purpose === 'maskable') ok(a.name + ': ' + i.src + ' has no transparency', !info.err && !info.alpha);
  }
  const page = read(a.page);
  ok(a.name + ': the page links its manifest, once', (page.match(/<link rel="manifest"/g) || []).length === 1 && page.indexOf('<link rel="manifest" href="/' + a.manifest.replace('docs/', '') + '">') > -1);
  const touch = 'docs/pro/img/' + a.prefix + '-apple-touch-icon.png';
  const t = exists(touch) ? pngInfo(touch) : { err: 'missing' };
  ok(a.name + ': the page uses its own 180px iPhone icon, opaque (iOS paints transparent pixels black)', page.indexOf('<link rel="apple-touch-icon" href="/pro/img/' + a.prefix + '-apple-touch-icon.png">') > -1 && !t.err && t.w === 180 && t.h === 180 && !t.alpha, t.err);
  ok(a.name + ': the page can run full-screen from an iPhone home screen', /<meta name="apple-mobile-web-app-capable" content="yes">/.test(page) && /<meta name="apple-mobile-web-app-title" content="[^"]+">/.test(page));
}
ok('the two apps and NBD Pro are three different installs', ids.size === 2 && !ids.has(PRO.id) && !ids.has(PRO.start_url));

console.log('\n2. The standalone Workout page');
const WP = read('docs/pro/workout/index.html');
const DS = read('docs/pro/daily-success/index.html');
const srcs = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
const wSrcs = srcs(WP), dSrcs = srcs(DS);
ok('no inline script and no on*= handler (CSP)', !/<script\b(?![^>]*\bsrc=)[^>]*>/.test(WP) && !/\son[a-z]+\s*=/i.test(WP));
const shared = wSrcs.filter((s) => s.indexOf('/pro/workout/') !== 0);
const skew = shared.filter((s) => dSrcs.indexOf(s) === -1);
ok('every shared script is loaded at the same ?v= as on the Daily Success page', shared.length >= 8 && skew.length === 0, 'differs: ' + skew.join(', '));
const css = (html) => (html.match(/href="(\/pro\/daily-success\/css\/workout-coach\.css[^"]*)"/) || [])[1];
ok('the coach stylesheet too', !!css(WP) && css(WP) === css(DS), css(WP) + ' vs ' + css(DS));
const at = (re) => wSrcs.findIndex((s) => re.test(s));
const coach = at(/\/workout-coach\.js/);
ok('the page helpers and the coach rules load before the coach screen',
  coach > -1 && [/\/workout-shell\.js/, /\/workout-coach-logic\.js/, /\/exercise-notes-logic\.js/, /\/volume-range-logic\.js/, /\/weekly-targets-logic\.js/, /\/toast\.js/].every((re) => at(re) > -1 && at(re) < coach));
ok('the app screen loads after the coach, and the sync module is on the page', at(/\/workout-app\.js/) > coach && at(/\/ds-firebase-sync\.js/) > -1 && at(/\/ds-sync-logic\.js/) > -1);
ok('every script and stylesheet the page names exists', wSrcs.concat([...WP.matchAll(/<link rel="stylesheet" href="(\/pro\/[^"?]+)/g)].map((m) => m[1])).every((s) => exists('docs' + s.split('?')[0])));
ok('a card placeholder for the coach to draw into, and a sign-in link that starts hidden', /<div id="wcCard"/.test(WP) && /<a class="wa-link" id="waSignIn" href="\/pro\/login" hidden>/.test(WP));
ok('none of the Daily Success page code is loaded', !wSrcs.some((s) => /\/daily-success\/js\/app\.js/.test(s)));

console.log('\n3. Page helpers (workout-shell.js) match app.js');
function shell(now) {
  const store = new Map(); let pushes = 0;
  const win = { showToast: (m, t) => { win._toast = [m, t]; }, NBDDsCloud: { pushSettings: () => { pushes++; } } };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  vm.runInNewContext(read('docs/pro/workout/js/workout-shell.js'), { window: win, localStorage: { setItem: (k, v) => store.set(k, String(v)), getItem: (k) => (store.has(k) ? store.get(k) : null) }, Date: FakeDate });
  return { win, store, pushes: () => pushes };
}
{
  // 9:30 pm local on Nov 16: the UTC date is already the 17th in every US timezone.
  const late = new Date(2026, 10, 16, 21, 30).getTime();
  const s = shell(late);
  ok('todayKey() is the local date late in the evening', s.win.todayKey() === '2026-11-16', s.win.todayKey());
  const APP = read('docs/pro/daily-success/js/app.js');
  const m = APP.match(/^function todayKey\(\)\{.*$/m);   // app.js keeps it on one line
  let same = false;
  if (m) { const ctx = { Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(late); } } }; vm.runInNewContext(m[0] + '\nout=todayKey();', ctx); same = ctx.out === s.win.todayKey(); }
  ok('and equals app.js todayKey() for the same moment', same);
  s.win.dsSettingsChanged('nbd_ds_coach');
  ok('dsSettingsChanged stamps <key>_at and pushes the settings', s.store.get('nbd_ds_coach_at') === String(late) && s.pushes() === 1);
  s.win.toast('a'); const t1 = s.win._toast; s.win.toastErr('b');
  ok('toast / toastErr go to showToast as success / error', t1[1] === 'success' && s.win._toast[1] === 'error');
  ok('savePages reports nothing written, and there is no day-page writer', s.win.savePages() === false && typeof s.win.collectPage === 'undefined' && typeof s.win.renderPage === 'undefined');
}

console.log('\n4. The header status (workout-app.js)');
{
  const listeners = {};
  const doc = { readyState: 'loading', addEventListener: () => {}, getElementById: () => null };
  const win = { addEventListener: (n, f) => { listeners[n] = f; } };
  vm.runInNewContext(read('docs/pro/workout/js/workout-app.js'), { window: win, document: doc, navigator: { onLine: true }, setTimeout: () => 0 });
  const st = win.NBDWorkoutApp.statusOf;
  ok('signed out: saved on this phone, and the sign-in link shows', st({ signedIn: false, online: true, cloud: 'idle' }).signIn === true);
  ok('not known yet: says nothing and offers no sign-in', st({ signedIn: null, online: true, cloud: 'idle' }).text === '' && !st({ signedIn: null, online: true, cloud: 'idle' }).signIn);
  ok('signed in and synced: backed up', st({ signedIn: true, online: true, cloud: 'synced' }).cls === 'ok');
  ok('a failed sync says so and offers Retry', st({ signedIn: true, online: true, cloud: 'failed' }).retry === true && st({ signedIn: true, online: true, cloud: 'failed' }).cls === 'err');
  ok('offline never claims backed up', !/backed up/i.test(st({ signedIn: true, online: false, cloud: 'synced' }).text));
}

console.log('\n5. Offline shell and hosting');
const SW = read('docs/pro/sw.js');
const entry = SW.match(/\{ key: '\/pro\/__app-shell__\/workout'[^\n]*\}/);
ok('sw.js keeps a shell for /pro/workout, stored only when the page asks', !!entry && /src: '\/pro\/workout'/.test(entry[0]) && /onRequestOnly: true/.test(entry[0]) && /'\/pro\/workout', '\/pro\/workout\.html', '\/pro\/workout\/'/.test(entry[0]));
const marker = entry && (entry[0].match(/marker: '([^']+)'/) || [])[1];
ok('its marker is in the Workout page and not in the Daily Success page', !!marker && WP.indexOf(marker) > -1 && DS.indexOf(marker) === -1, String(marker));
ok('the online page is never kept in the asset caches', /'\/pro\/workout\.html',/.test(SW));
ok('the page asks for the same shell key', read('docs/pro/workout/js/workout-app.js').indexOf("'/pro/__app-shell__/workout'") > -1);
const fb = JSON.parse(read('firebase.json'));
const hs = [].concat(fb.hosting).flatMap((h) => h.headers || []);
const rulesFor = (src) => hs.filter((h) => h.source === src).map((h) => JSON.stringify(h.headers)).sort().join('|');
ok('/pro/workout gets the same headers as /pro/daily-success (CSP, no-store)', rulesFor('/pro/workout') !== '' && rulesFor('/pro/workout') === rulesFor('/pro/daily-success'));
ok('/pro/workout/** likewise (CSP, noindex)', rulesFor('/pro/workout/**') !== '' && rulesFor('/pro/workout/**') === rulesFor('/pro/daily-success/**'));
const noindex = hs.find((h) => /^\/pro\/@\(/.test(h.source) && h.headers.some((x) => x.key === 'X-Robots-Tag'));
ok('/pro/workout is noindex', !!noindex && /\|workout\|/.test(noindex.source));
for (const a of APPS) {
  const src = '/' + a.manifest.replace('docs/', '');
  const r = hs.find((h) => h.source === src);
  ok(src + ' is served as application/manifest+json', !!r && r.headers.some((x) => x.key === 'Content-Type' && x.value === 'application/manifest+json'));
}

console.log('\n6. Default-theme tokens mirrored into workout-app.css');
{
  const tok = (css, name) => { const m = css.match(/\[data-theme="default"\]\{[^}]*\}/g) || []; let v = null; m.forEach((b) => { const x = b.match(new RegExp(name + ':([^;}]+)')); if (x) v = x[1].trim(); }); return v; };
  const WCSS = read('docs/pro/workout/workout-app.css');
  const names = ['--ac', '--bg', '--bar', '--paper', '--ink', '--rule', '--muted', '--ac-text', '--on-dark', '--ghost', '--input-bg', '--ph'];
  const off = names.filter((n) => tok(WCSS, n) == null || tok(WCSS, n) !== tok(DS, n));
  ok('every mirrored token equals the Daily Success value', off.length === 0, off.map((n) => n + ' ' + tok(WCSS, n) + ' vs ' + tok(DS, n)).join('; '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
