/**
 * tests/ds-workout-installable-2026-11-16.test.js
 *
 * Daily Success and the Workout Coach each install as their own home-screen app (Jo, 2026-11-16):
 *
 *   1. Two manifests (docs/pro/daily-success.webmanifest, docs/pro/workout.webmanifest), each with its own id, scope, start_url
 *      and icons, none of them NBD Pro's: Android tells installed apps apart by id, so a shared one would install as NBD Pro.
 *      The icons are real PNGs of the stated size (every chunk walked, lengths and CRCs checked: the 2026-09 apple-touch-icon
 *      passed every existence check while half of it decoded black).
 *   2. /pro/workout is a standalone page: the same coach files, at the SAME ?v= as the Daily Success page (one copy of the coach,
 *      one offline cache entry per file), with the page helpers it needs loaded BEFORE the coach. No inline script, no on*= handlers.
 *   3. The helpers behave as app.js's do: todayKey() is the LOCAL date; dsSettingsChanged() stamps the key and pushes.
 *   4. The header status line, and the page asking for its own offline shell.
 *   5. The service worker keeps an offline shell for /pro/workout, and firebase.json gives it the tracker's headers.
 *   6. The default-theme tokens mirrored into workout-app.css equal the Daily Success values.
 *   7. Daily Success has a sign-in item in its header menu, shown only while signed out (an installed iPhone app starts signed
 *      out with its own empty storage, and the tracker had no sign-in link of its own).
 *
 *   8. Signing in from either app comes back to it: the links carry a NAME (?redirect=workout), and the login page looks it up in a
 *      fixed list (docs/pro/js/login-return.js). Anything else, a URL included, is ignored.
 *
 *   9. The Workout app asks "Workout done. Tick the floor?" at Finish and stores the answer on the workout (it has no floors or day
 *      pages of its own); Daily Success applies it (tests/coach-exercise-log-copy-2026-11-17.test.js).
 *
 *  10. The Workout app wears the Daily Success theme: the same storage keys in the same order, the ten built-in skins' tokens mirrored
 *      value for value, the accent laid over the skin as accent-ui.js does it, and anything unknown shown as the default skin.
 *
 * Structure and behaviour, not file text (tests/lib/src-kit.js): tags and attributes, CSS declarations, the scripts run in a vm.
 *
 * Run: node tests/ds-workout-installable-2026-11-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const kit = require('./lib/src-kit');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const page = (rel) => kit.parseTags(kit.read(rel));
const pathOf = (src) => String(src).split('?')[0];

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
const png = (file) => (kit.exists(file) ? pngInfo(file) : { err: 'missing' });

const APPS = [
  { name: 'Daily Success', manifest: 'docs/pro/daily-success.webmanifest', id: '/pro/daily-success', prefix: 'ds', page: 'docs/pro/daily-success/index.html' },
  { name: 'Workout', manifest: 'docs/pro/workout.webmanifest', id: '/pro/workout', prefix: 'workout', page: 'docs/pro/workout/index.html' },
];
const PRO = json('docs/pro/manifest.json');
const dsDoc = page('docs/pro/daily-success/index.html');
const wDoc = page('docs/pro/workout/index.html');

console.log('\n1. Manifests, icons and the tags that link them');
const ids = new Set();
for (const a of APPS) {
  const m = json(a.manifest);
  ids.add(m.id);
  ok(a.name + ': id, start_url and scope are its own path', m.id === a.id && m.start_url === a.id && m.scope === a.id, JSON.stringify([m.id, m.start_url, m.scope]));
  ok(a.name + ': not NBD Pro\'s start page or scope', m.start_url !== PRO.start_url && m.scope !== PRO.scope);
  ok(a.name + ': opens standalone, with a short name that fits under an icon', m.display === 'standalone' && typeof m.short_name === 'string' && m.short_name.length > 0 && m.short_name.length <= 13);
  const purposes = m.icons.map((i) => i.purpose + ':' + i.sizes).sort().join(',');
  ok(a.name + ': 192 and 512 icons, "any" and "maskable"', purposes === 'any:192x192,any:512x512,maskable:192x192,maskable:512x512', purposes);
  const proIcons = new Set(PRO.icons.map((p) => p.src));
  ok(a.name + ': every icon is its own (none of NBD Pro\'s)', m.icons.every((i) => i.src.indexOf('/pro/img/' + a.prefix + '-icon') === 0 && !proIcons.has(i.src)));
  for (const i of m.icons) {
    const info = png('docs' + i.src);
    const size = Number(i.sizes.split('x')[0]);
    ok(a.name + ': ' + i.src + ' is a sound ' + i.sizes + ' PNG', !info.err && info.w === size && info.h === size, info.err || (info.w + 'x' + info.h));
    // a maskable icon is cropped to a circle or squircle by the launcher: it must be a full, opaque tile
    if (i.purpose === 'maskable') ok(a.name + ': ' + i.src + ' has no transparency', !info.err && !info.alpha);
  }
  const doc = a.prefix === 'ds' ? dsDoc : wDoc;
  const manifests = doc.$$('link[rel=manifest]');
  ok(a.name + ': the page links its manifest, once', manifests.length === 1 && manifests[0].attr('href') === '/' + a.manifest.slice('docs/'.length), manifests.map((l) => l.attr('href')).join(' '));
  const touch = doc.$$('link[rel=apple-touch-icon]');
  const t = png('docs/pro/img/' + a.prefix + '-apple-touch-icon.png');
  ok(a.name + ': the page uses its own 180px iPhone icon, opaque (iOS paints transparent pixels black)',
    touch.length === 1 && touch[0].attr('href') === '/pro/img/' + a.prefix + '-apple-touch-icon.png' && !t.err && t.w === 180 && t.h === 180 && !t.alpha, t.err);
  const capable = doc.$('meta[name=apple-mobile-web-app-capable]'), title = doc.$('meta[name=apple-mobile-web-app-title]');
  ok(a.name + ': the page can run full-screen from an iPhone home screen, under its own name', !!capable && capable.attr('content') === 'yes' && !!title && (title.attr('content') || '').length > 0);
}
ok('the two apps and NBD Pro are three different installs', ids.size === 2 && !ids.has(PRO.id) && !ids.has(PRO.start_url));

console.log('\n2. The standalone Workout page');
const wScripts = wDoc.$$('script'), dScripts = new Set(dsDoc.$$('script').map((s) => s.attr('src')).filter(Boolean));
const wSrcs = wScripts.map((s) => s.attr('src'));
ok('no inline script and no on*= handler (CSP)', wScripts.length > 0 && wSrcs.every(Boolean) && wDoc.all.every((el) => Object.keys(el.attrs).every((k) => k.toLowerCase().indexOf('on') !== 0)));
const shared = wSrcs.filter((s) => s.indexOf('/pro/workout/') !== 0);
const skew = shared.filter((s) => !dScripts.has(s));
ok('every shared script is loaded at the same ?v= as on the Daily Success page', shared.length >= 8 && skew.length === 0, 'differs: ' + skew.join(', '));
const coachCss = (doc) => doc.$$('link[rel=stylesheet]').map((l) => l.attr('href')).filter((h) => pathOf(h) === '/pro/daily-success/css/workout-coach.css');
ok('the coach stylesheet too', coachCss(wDoc).length === 1 && coachCss(wDoc)[0] === coachCss(dsDoc)[0], coachCss(wDoc)[0] + ' vs ' + coachCss(dsDoc)[0]);
const at = (file) => wSrcs.findIndex((s) => pathOf(s).split('/').pop() === file);
const coach = at('workout-coach.js');
ok('the page helpers and the coach rules load before the coach screen',
  coach > -1 && ['workout-shell.js', 'workout-coach-logic.js', 'exercise-notes-logic.js', 'volume-range-logic.js', 'weekly-targets-logic.js', 'toast.js'].every((f) => at(f) > -1 && at(f) < coach));
ok('the app screen loads after the coach, and the sync module is on the page', at('workout-app.js') > coach && at('ds-firebase-sync.js') > -1 && at('ds-sync-logic.js') > -1);
const sheets = wDoc.$$('link[rel=stylesheet]').map((l) => l.attr('href')).filter((h) => h.charAt(0) === '/');
ok('every script and stylesheet the page names exists', wSrcs.concat(sheets).every((s) => kit.exists('docs' + pathOf(s))));
const card = wDoc.byId('wcCard'), signIn = wDoc.byId('waSignIn');
ok('a card placeholder for the coach to draw into, and a sign-in link that starts hidden', !!card && !!signIn && signIn.tag === 'a' && signIn.attr('href') === '/pro/login?redirect=workout' && signIn.has('hidden'));
ok('none of the Daily Success page code is loaded', at('app.js') === -1);

console.log('\n3. Page helpers (workout-shell.js) match app.js');
function frozenDate(now) { return class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }; }
{
  // 9:30 pm local on Nov 16: the UTC date is already the 17th in every US timezone.
  const late = new Date(2026, 10, 16, 21, 30).getTime();
  const store = new Map(); let pushes = 0; const toasts = [];
  const win = { showToast: (m, t) => { toasts.push(t); }, NBDDsCloud: { pushSettings: () => { pushes++; } } };
  kit.loadInVm(['docs/pro/workout/js/workout-shell.js'], { window: win, localStorage: { setItem: (k, v) => store.set(k, String(v)), getItem: (k) => (store.has(k) ? store.get(k) : null) }, Date: frozenDate(late) });
  ok('todayKey() is the local date late in the evening', win.todayKey() === '2026-11-16', win.todayKey());
  const appCtx = { Date: frozenDate(late) };
  vm.runInNewContext(kit.sliceFn(kit.read('docs/pro/daily-success/js/app.js'), 'todayKey') + '\nout = todayKey();', appCtx);
  ok('and equals app.js todayKey() for the same moment', appCtx.out === win.todayKey(), appCtx.out);
  win.dsSettingsChanged('nbd_ds_coach');
  ok('dsSettingsChanged stamps <key>_at and pushes the settings', store.get('nbd_ds_coach_at') === String(late) && pushes === 1);
  win.toast('a'); win.toastErr('b');
  ok('toast / toastErr go to showToast as success / error', toasts.join(',') === 'success,error');
  ok('savePages reports nothing written, and there is no day-page writer', win.savePages() === false && typeof win.collectPage === 'undefined' && typeof win.renderPage === 'undefined');
}

console.log('\n4. The header status and the offline request (workout-app.js)');
{
  const posted = [];
  const win = { addEventListener: () => {} };
  const doc = { readyState: 'complete', addEventListener: () => {}, getElementById: () => null, visibilityState: 'visible' };
  const nav = { onLine: true, serviceWorker: { controller: { postMessage: (m) => posted.push(m) }, addEventListener: () => {} } };
  kit.loadInVm(['docs/pro/workout/js/workout-app.js'], { window: win, document: doc, navigator: nav, setTimeout: (f) => { f(); return 0; } });
  const st = win.NBDWorkoutApp.statusOf;
  ok('signed out: saved on this phone, and the sign-in link shows', st({ signedIn: false, online: true, cloud: 'idle' }).signIn === true);
  const unknown = st({ signedIn: null, online: true, cloud: 'idle' });
  ok('not known yet: says nothing and offers no sign-in', unknown.text === '' && !unknown.signIn);
  ok('signed in and synced: backed up', st({ signedIn: true, online: true, cloud: 'synced' }).cls === 'ok');
  const bad = st({ signedIn: true, online: true, cloud: 'failed' });
  ok('a failed sync says so and offers Retry', bad.retry === true && bad.cls === 'err');
  const off = st({ signedIn: true, online: false, cloud: 'synced' });
  ok('offline never claims backed up', off.cls !== 'ok' && off.text !== st({ signedIn: true, online: true, cloud: 'synced' }).text);
  ok('the page asks the worker for its own offline shell, by key', posted.length === 1 && posted[0].type === 'CACHE_APP_SHELL' && JSON.stringify(posted[0].keys) === '["/pro/__app-shell__/workout"]', JSON.stringify(posted));
}

console.log('\n5. Offline shell and hosting');
{
  const self = { addEventListener: () => {}, location: { origin: 'https://example.test' }, navigator: { onLine: true }, registration: {}, clients: {} };
  const ctx = kit.loadInVm(['docs/pro/sw.js'], { self, caches: {}, fetch: () => Promise.reject(new Error('no network in this test')), URL, Response: function () {}, indexedDB: {} }, { expose: ['APP_SHELLS', 'NO_CACHE_HTML'] });
  const shells = ctx.__exposed.APP_SHELLS, noCache = ctx.__exposed.NO_CACHE_HTML;
  const s = shells.find((x) => x.key === '/pro/__app-shell__/workout');
  ok('sw.js keeps a shell for /pro/workout, stored only when the page asks', !!s && s.src === '/pro/workout' && s.onRequestOnly === true && ['/pro/workout', '/pro/workout.html', '/pro/workout/'].every((p) => s.paths.indexOf(p) > -1));
  const titleOf = (doc) => '<title>' + (doc.$('title') ? doc.$('title').text : '');
  ok('its marker is the start of the Workout page\'s title and not of the Daily Success page\'s', !!s && !!s.marker && titleOf(wDoc).indexOf(s.marker) === 0 && titleOf(dsDoc).indexOf(s.marker) !== 0, s && s.marker);
  const ds = shells.find((x) => x.key === '/pro/__app-shell__/daily-success');
  ok('and the tracker\'s own marker does not match the Workout page', !!ds && titleOf(wDoc).indexOf(ds.marker) !== 0);
  ok('the online page is never kept in the asset caches', noCache.has('/pro/workout.html'));
}
const hs = [].concat(json('firebase.json').hosting).flatMap((h) => h.headers || []);
const rulesFor = (src) => hs.filter((h) => h.source === src).map((h) => JSON.stringify(h.headers)).sort().join('|');
ok('/pro/workout gets the same headers as /pro/daily-success (CSP, no-store)', rulesFor('/pro/workout') !== '' && rulesFor('/pro/workout') === rulesFor('/pro/daily-success'));
ok('/pro/workout/** likewise (CSP, noindex)', rulesFor('/pro/workout/**') !== '' && rulesFor('/pro/workout/**') === rulesFor('/pro/daily-success/**'));
const listed = hs.filter((h) => h.source.indexOf('/pro/@(') === 0 && h.headers.some((x) => x.key === 'X-Robots-Tag' && x.value === 'noindex, nofollow'))
  .flatMap((h) => h.source.slice('/pro/@('.length, h.source.lastIndexOf(')')).split('|'));
ok('/pro/workout is noindex', new Set(listed).has('workout') && new Set(listed).has('daily-success'));
for (const a of APPS) {
  const src = '/' + a.manifest.slice('docs/'.length);
  const r = hs.find((h) => h.source === src);
  ok(src + ' is served as application/manifest+json', !!r && r.headers.some((x) => x.key === 'Content-Type' && x.value === 'application/manifest+json'));
}

console.log('\n6. Default-theme tokens mirrored into workout-app.css');
{
  const SEL = '[data-theme="default"]';
  const mine = kit.cssRule(kit.read('docs/pro/workout/workout-app.css'), SEL) || {};
  const theirs = kit.cssRule(dsDoc.$$('style').map((s) => s.html).join('\n'), SEL) || {};
  const names = ['--ac', '--bg', '--bar', '--paper', '--ink', '--rule', '--muted', '--ac-text', '--on-dark', '--ghost', '--input-bg', '--ph'];
  const off = names.filter((n) => !mine[n] || mine[n] !== theirs[n]);
  ok('every mirrored token equals the Daily Success value', off.length === 0, off.map((n) => n + ' ' + mine[n] + ' vs ' + theirs[n]).join('; '));
}

console.log('\n7. Daily Success: the sign-in item in the header menu');
{
  const menu = dsDoc.byId('dsMenu'), item = dsDoc.byId('dsSignIn');
  ok('a menu item that links to /pro/login and starts hidden', !!item && item.tag === 'a' && item.attr('role') === 'menuitem' && item.attr('href') === '/pro/login?redirect=daily-success' && item.has('hidden') && item.classes.indexOf('ds-mi') > -1);
  const order = menu ? menu.$$('.ds-mi').map((e) => e.attr('id') || e.attr('data-action') || e.tag) : [];
  // third: the first two items keep their places (the menu's keyboard contract counts on them), Delete stays last
  ok('it sits in the header menu after Save now, with Delete still last', order.indexOf('dsSignIn') === 2 && order[1] === 'save-now' && order[order.length - 1] === 'trigger-del', order.join(' '));
  const hiddenRule = kit.cssRule(kit.read('docs/pro/daily-success/css/flow-batch-3.css'), '.ds-mi[hidden]');
  ok('a hidden menu item is really hidden (.ds-mi sets display:flex, which beats the hidden attribute)', !!hiddenRule && hiddenRule.display === 'none');

  const wl = {}, dl = {}, asked = [];
  const link = { hidden: true };
  const menuEl = { hidden: true, contains: () => false };
  const btnEl = { setAttribute: () => {}, focus: () => {} };
  const doc = {
    addEventListener: (n, f) => { (dl[n] = dl[n] || []).push(f); },
    getElementById: (id) => ({ dsSignIn: link, dsMenu: menuEl, dsMenuBtn: btnEl }[id] || null),
    querySelectorAll: (sel) => { asked.push(sel); return []; },
    activeElement: null,
  };
  kit.loadInVm(['docs/pro/daily-success/js/menu-ui.js'], { window: { addEventListener: (n, f) => { wl[n] = f; } }, document: doc, setTimeout: () => 0, clearTimeout: () => {} });
  dl.click.forEach((f) => f({ target: { closest: (sel) => (sel === '[data-action="menu-toggle"]' ? {} : null) } }));
  ok('opening the menu only considers items that are not hidden (focus never lands on a hidden one)', menuEl.hidden === false && asked.length > 0 && asked.every((sel) => sel === '#dsMenu .ds-mi:not([hidden])'), asked.join(' | '));
  const fire = (detail) => wl['nbd-ds-sync']({ detail });
  fire({ cloud: 'syncing' });
  ok('stays hidden until the sign-in state is known', link.hidden === true);
  fire({ cloud: 'idle', signedIn: false });
  ok('signed out: the item shows', link.hidden === false);
  fire({ cloud: 'failed' });
  ok('an event that does not say who is signed in leaves it as it was', link.hidden === false);
  fire({ cloud: 'synced', signedIn: true });
  ok('signed in: the item is hidden again', link.hidden === true);
}

console.log('\n8. Signing in comes back to the app');
{
  const win = {};
  kit.loadInVm(['docs/pro/js/login-return.js'], { window: win, URLSearchParams });
  const dest = win.NBDLoginReturn.dest;
  ok('?redirect=workout and ?redirect=daily-success go back to those apps', dest('?redirect=workout') === '/pro/workout' && dest('?redirect=daily-success') === '/pro/daily-success');
  // each app's own sign-in link is one the login page honours, and it leads back to that app's start page
  for (const a of APPS) {
    const link = (a.prefix === 'ds' ? dsDoc.byId('dsSignIn') : wDoc.byId('waSignIn')).attr('href');
    ok(a.name + ': its sign-in link returns to its own start_url', link.indexOf('/pro/login?') === 0 && dest(link.slice('/pro/login'.length)) === json(a.manifest).start_url, link);
  }
  const hostile = ['?redirect=https://evil.example', '?redirect=//evil.example', '?redirect=/pro/workout', '?redirect=%2Fpro%2Fworkout', '?redirect=javascript:alert(1)',
    '?redirect=constructor', '?redirect=__proto__', '?redirect=toString', '?redirect=Workout', '?redirect=workout%20', '?redirect=', '?next=workout', '', null, undefined];
  const leaked = hostile.filter((q) => dest(q) !== null);
  ok('an address, a path, a prototype key or any other value is ignored (the query is a name, never an address)', leaked.length === 0, leaked.join(' '));
  ok('redirect=pricing is not this list\'s business (login.js keeps handling it)', dest('?redirect=pricing') === null);
  ok('other query values do not get in the way', dest('?plan=team&redirect=workout') === '/pro/workout');
  const login = page('docs/pro/login.html');
  const order = login.$$('script').map((s) => pathOf(s.attr('src') || '').split('/').pop());
  ok('the login page loads the list before its sign-in module', order.indexOf('login-return.js') > -1 && order.indexOf('login-return.js') < order.indexOf('login.js'), order.join(' '));
  const mod = kit.read('docs/pro/js/pages/login.js');
  const pricingAt = mod.indexOf("params.get('redirect') === 'pricing'"), useAt = mod.indexOf('window.NBDLoginReturn.dest(window.location.search)');
  ok('the sign-in module asks it, after the pricing return and before the dashboard fallback', pricingAt > -1 && useAt > pricingAt && useAt < mod.indexOf("return '/pro/dashboard.html'"));
}

console.log('\n9. The Workout app asks about the floor at Finish');
{
  ok('the floor rules load before the app screen, at the Daily Success version', at('floor-tick-logic.js') > -1 && at('floor-tick-logic.js') < at('workout-app.js') && dScripts.has(wSrcs[at('floor-tick-logic.js')]));
  const mkEl = (tag) => ({ tag, id: '', className: '', hidden: false, textContent: '', children: [], dataset: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; } });
  // textContent = '' empties an element, as in a browser
  const el = (tag) => { const e = mkEl(tag); let text = ''; Object.defineProperty(e, 'textContent', { get: () => text, set: (v) => { text = String(v); if (v === '') e.children.length = 0; } }); return e; };
  function app(o) {
    o = o || {};
    const byId = {}, winL = {}, docL = {}, timers = [], answers = [], errs = [];
    const body = el('body');
    body.appendChild = (c) => { body.children.push(c); if (c.id) byId[c.id] = c; return c; };
    const doc = { readyState: 'loading', visibilityState: 'visible', body, createElement: el, getElementById: (id) => byId[id] || null,
      addEventListener: (n, f) => { (docL[n] = docL[n] || []).push(f); } };
    const win = { addEventListener: (n, f) => { (winL[n] = winL[n] || []).push(f); }, toastErr: (m) => errs.push(m),
      NBDCoachUI: { refresh: () => {}, answerFloor: (id, ans) => { answers.push(id + ':' + ans); return !o.saveFails; } } };
    const store = o.config ? { nbd_user_config: JSON.stringify(o.config) } : {};
    kit.loadInVm(['docs/pro/daily-success/js/floor-tick-logic.js', 'docs/pro/workout/js/workout-app.js'], { window: win, document: doc, navigator: { onLine: true },
      localStorage: { getItem: (k) => (k in store ? store[k] : null) }, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: () => {} });
    const chip = () => byId.waTick || null;
    return { win, answers, errs, timers, chip,
      did: (detail) => winL['nbd-ds-did'].forEach((f) => f({ detail })),
      tap: (action) => docL.click.forEach((f) => f({ target: { closest: (sel) => (sel === '[data-wa-action]' ? { dataset: { waAction: action } } : null) } })),
      shown: () => !!chip() && chip().hidden === false,
      buttons: () => (chip() ? chip().children.filter((c) => c.tag === 'button').map((c) => c.dataset.waAction) : []) };
  }
  const a = app();
  a.did({ kind: 'workout', dk: '2026-11-17', id: 'w1' });
  ok('Finish raises the question, with Tick it and Not now', a.shown() && a.buttons().join() === 'tick-yes,tick-no' && a.chip().attrs.role === 'status', a.buttons().join());
  ok('nothing is stored until a button is tapped', a.answers.length === 0);
  a.tap('tick-yes');
  ok('Tick it stores yes on that workout', a.answers.join() === 'w1:yes');
  ok('and says Daily Success will tick it, with an Undo', a.shown() && a.buttons().join() === 'tick-no');
  a.tap('tick-no');
  ok('Undo stores no and closes the prompt', a.answers.join() === 'w1:yes,w1:no' && !a.shown());
  a.tap('tick-yes');
  ok('a tap with no question open stores nothing', a.answers.length === 2);

  const b = app();
  b.did({ kind: 'workout', dk: '2026-11-17', id: 'w2' });
  b.tap('tick-no');
  ok('Not now stores no and closes the prompt', b.answers.join() === 'w2:no' && !b.shown());

  const c = app();
  c.did({ kind: 'workout', dk: '2026-11-17', id: 'w3' });
  const idle = c.timers[c.timers.length - 1];
  idle.f();
  ok('left unanswered it closes by itself and stores nothing (Daily Success asks later)', idle.ms >= 10000 && !c.shown() && c.answers.length === 0);

  const quiet = (detail, o) => { const x = app(o); x.did(detail); return !x.shown() && x.answers.length === 0; };
  ok('an event that names no workout, or is about something else, asks nothing', quiet({ kind: 'workout', dk: '2026-11-17' }) && quiet({ kind: 'protein', dk: '2026-11-17', id: 'w1' }) && quiet(null));
  ok('Jo\'s own floors with none a workout ticks: not asked', quiet({ kind: 'workout', id: 'w1' }, { config: { floors: [{ id: 'a', label: 'Read 10 pages' }, { id: 'b', label: 'Sleep 7+ hrs' }] } }));
  const custom = app({ config: { floors: [{ id: 'a', label: 'Lift weights' }] } });
  custom.did({ kind: 'workout', id: 'w1' });
  ok('a custom workout floor is found by its words, as in Daily Success', custom.shown());
  const noFloors = app({ config: { floors: [] } });
  noFloors.did({ kind: 'workout', id: 'w1' });
  ok('no floors of his own: the default set has a workout floor, so it asks', noFloors.shown());

  const full = app({ saveFails: true });
  full.did({ kind: 'workout', id: 'w4' });
  full.tap('tick-yes');
  ok('an answer the phone could not store says so and does not claim it will be ticked', full.errs.length === 1 && !full.shown());
}

console.log('\n10. The Workout app wears the Daily Success theme');
{
  const dsCss = dsDoc.$$('style').map((s) => s.html).join('\n');
  const wCss = kit.read('docs/pro/workout/workout-app.css');
  const PROPS = ['--ac', '--ac-text', '--ac-on-dark', '--on-dark', '--gold', '--bg', '--bar', '--paper', '--ink', '--rule', '--muted', '--grn', '--blu', '--ghost', '--input-bg', '--ph'];
  // the skins Daily Success has a colour rule for: the default, plus every :root[data-theme="x"] block that sets the page colours
  const dsSkins = ['default'].concat(kit.cssRules(dsCss).filter((r) => r.decls['--bg'] && r.decls['--paper'] && r.decls['--ac-text'])
    .flatMap((r) => r.selectors).map((s) => (/^:root\[data-theme="([a-z]+)"\]$/.exec(s) || [])[1]).filter(Boolean));

  // the real script, with a small <html> element, storage and a card colour to judge the accent against
  function themed(store, paper) {
    const attrs = { 'data-theme': 'default' }, inline = {}, docL = {}, winL = {};
    const html = { getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); },
      style: { setProperty: (p, v) => { inline[p] = v; }, removeProperty: (p) => { delete inline[p]; } } };
    const win = { addEventListener: (n, f) => { winL[n] = f; } };
    const doc = { documentElement: html, visibilityState: 'visible', addEventListener: (n, f) => { docL[n] = f; } };
    kit.loadInVm(['docs/pro/daily-success/js/accent-logic.js', 'docs/pro/workout/js/workout-theme.js'], { window: win, document: doc,
      localStorage: { getItem: (k) => (k in store ? store[k] : null) }, getComputedStyle: () => ({ getPropertyValue: () => paper || '#12161c' }) });
    return { win, attrs, inline, store, back: () => docL.visibilitychange(), changed: (key) => winL.storage({ key }) };
  }
  const T = themed({}).win.NBDWorkoutTheme;
  const idFor = (store) => T.themeId((k) => (k in store ? store[k] : null));

  ok('it knows exactly the skins Daily Success has colours for', T.SKINS.slice().sort().join() === dsSkins.slice().sort().join() && T.SKINS.length === 10, T.SKINS.join() + ' vs ' + dsSkins.join());
  const off = [];
  T.SKINS.forEach((id) => {
    const sel = id === 'default' ? '[data-theme="default"]' : ':root[data-theme="' + id + '"]';
    const mine = kit.cssRule(wCss, sel) || {}, theirs = kit.cssRule(dsCss, sel) || {};
    PROPS.forEach((p) => { if (id === 'default' && !theirs[p] && !mine[p]) return; if (!mine[p] || mine[p] !== theirs[p]) off.push(id + ' ' + p + ' ' + mine[p] + ' vs ' + theirs[p]); });
  });
  ok('every skin\'s tokens equal the Daily Success values (16 tokens x 10 skins)', off.length === 0, off.slice(0, 6).join('; '));

  ok('nothing saved: the default skin', idFor({}) === 'default');
  ok('the theme Daily Success saved is the one worn', T.SKINS.every((id) => idFor({ nbd_pro_theme: id }) === id));
  ok('same order as Daily Success: nbd_pro_theme, then nbd-theme, then ds-theme', idFor({ nbd_pro_theme: 'ocean', 'nbd-theme': 'ember', 'ds-theme': 'paper' }) === 'ocean'
    && idFor({ 'nbd-theme': 'ember', 'ds-theme': 'paper' }) === 'ember' && idFor({ 'ds-theme': 'paper' }) === 'paper');
  ok('the dashboard\'s nbd-original is the default skin here, and does not fall through to an older key', idFor({ nbd_pro_theme: 'nbd-original', 'nbd-theme': 'ember' }) === 'default');
  ok('a custom theme or junk in storage shows as the default skin', ['custom-1730000000', 'LIGHT', ' light', '__proto__', 'constructor', '<b>'].every((v) => idFor({ nbd_pro_theme: v }) === 'default'));

  const a = themed({ nbd_pro_theme: 'forest' });
  ok('on load the page is given that theme, with no accent laid over it', a.attrs['data-theme'] === 'forest' && Object.keys(a.inline).length === 0);
  const dark = themed({ nbd_pro_theme: 'midnight', nbd_ds_accent: 'teal' }, '#12132b');
  const light = themed({ nbd_pro_theme: 'light', nbd_ds_accent: 'teal' }, '#ffffff');
  ok('an accent is laid over the skin: the fill, and a text tint picked by the card colour', dark.inline['--ac'] === '#0F766E' && light.inline['--ac'] === '#0F766E'
    && dark.inline['--ac-text'] === '#5FD6C8' && light.inline['--ac-text'] === '#0B5F58', JSON.stringify([dark.inline, light.inline]));
  ok('an accent that is not in the list is ignored', Object.keys(themed({ nbd_ds_accent: '#ff0000' }).inline).length === 0);
  delete light.store.nbd_ds_accent; light.store.nbd_pro_theme = 'paper';
  light.back();
  ok('coming back to the app picks up a changed theme and takes a cleared accent back off', light.attrs['data-theme'] === 'paper' && Object.keys(light.inline).length === 0);
  light.store.nbd_pro_theme = 'ocean'; light.changed('nbd_pro_theme');
  ok('a change made in another tab is followed at once', light.attrs['data-theme'] === 'ocean');
  light.store.nbd_pro_theme = 'ember'; light.changed('some_other_key');
  ok('an unrelated storage change is not a reason to repaint', light.attrs['data-theme'] === 'ocean');

  const head = wDoc.$('head');
  const inHead = (file) => head.$$('script').find((s) => pathOf(s.attr('src') || '').split('/').pop() === file) || null;
  const lastSheet = Math.max.apply(null, head.$$('link[rel=stylesheet]').map((l) => l.start));
  const acc = inHead('accent-logic.js'), th = inHead('workout-theme.js');
  ok('the theme is set in <head>, after the stylesheets and the accent list, so the first paint is already themed', !!acc && !!th && acc.start > lastSheet && th.start > acc.start && !th.has('defer') && !th.has('async') && dScripts.has(acc.attr('src')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
