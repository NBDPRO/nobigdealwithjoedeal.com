/**
 * tests/nbd-os-visits-2026-11-07.test.js - Record visit, Recent visits and
 * Unfiled visits as NBD OS apps (Joe's pick, 2026-11-07), instead of the
 * floating round record button, whose bottom-left corner is the NBD OS
 * taskbar's Start button.
 *
 * Runs the real VISITS section of docs/pro/js/layouts/os.js against stubs
 * (what each surface draws, the unfiled badge and item, Start-menu search,
 * which delegate each item carries, what a tap does), then checks the wiring:
 * both click handlers route visit taps first, nothing opens a window, the
 * count follows the recorder, and the round button stays Classic/Bento only.
 *
 * Run: node tests/nbd-os-visits-2026-11-07.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const OS = read('docs/pro/js/layouts/os.js');
const CSS = read('docs/pro/css/layouts/os.css');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}

// ── the real VISITS section, run against stubs ─────────────────────────────
const i = OS.indexOf('  // ═══ VISITS');
const j = OS.indexOf('  function mount(ctx) {', i);
const body = i >= 0 && j > i ? OS.slice(i, j) : '';
ok('control: found the VISITS section', /function visitItems/.test(body) && /function onVisitTap/.test(body));

function load(unfiled) {
  const calls = [];
  const store = { nbd_vr_unfiled: unfiled == null ? null : String(unfiled) };
  const W = {
    localStorage: { getItem: (k) => store[k] == null ? null : store[k] },
    NBDVisitRecorderLauncher: { openUnfiled: () => calls.push('openUnfiled') },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safe = (fn) => { try { return fn(); } catch (e) { return undefined; } };
  const setStart = (open) => { calls.push('setStart:' + open); S.startOpen = !!open; };
  let S = null;
  // eslint-disable-next-line no-new-func -- runs this repo's own source, not input
  const api = new Function('W', 'esc', 'safe', 'setStart', 'phonePaint', 'startListHtml', 'on', 'getS',
    'var S = getS();\n' + body + '\nreturn { visitItems: visitItems, visitTaskHtml: visitTaskHtml, visitStartRows: visitStartRows, visitBarHtml: visitBarHtml, visitPhoneRowHtml: visitPhoneRowHtml, onVisitTap: function (el) { S = getS(); return onVisitTap(el); } };')(
    W, esc, safe, setStart, () => calls.push('phonePaint'), () => '', () => {}, () => S);
  return { api, calls, store, setS: (x) => { S = x; } };
}
const el = (attrs) => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null) });

console.log('what each surface draws');
{
  const { api } = load(0);
  const it = api.visitItems('');
  ok('nothing unfiled: Record visit, Recent visits (no Unfiled item)', it.map((x) => x.kind).join() === 'record,recent', JSON.stringify(it));
  const t = api.visitTaskHtml();
  ok('taskbar: Record visit, no badge at zero', /<span class="os-task-label">Record visit<\/span>/.test(t) && !/os-visit-badge/.test(t) && /aria-label="Record visit"/.test(t), t);
  ok('...a plain button (type="button"), not a window app (no data-osapp / data-ostask)', /^<button type="button"/.test(t) && !/data-osapp|data-ostask/.test(t));
}
{
  const { api } = load(2);
  const it = api.visitItems('');
  ok('2 unfiled: the Unfiled visits (2) item is added last', it.map((x) => x.kind).join() === 'record,recent,unfiled' && it[2].label === 'Unfiled visits (2)', JSON.stringify(it));
  const t = api.visitTaskHtml();
  ok('taskbar: the count rides on Record as a badge, and screen readers hear it',
    /<span class="os-visit-badge ui-num" aria-hidden="true">2<\/span>/.test(t) && /aria-label="Record visit, 2 unfiled"/.test(t), t);
  ok('taskbar Record goes through the launcher delegate, source fab',
    /data-osvisit="record" data-nbd-record-visit="" data-source="fab"/.test(t));
  const rows = api.visitStartRows('');
  ok('Start menu: a Visits group, then the three items', /os-start-group[^>]*>Visits</.test(rows) && (rows.match(/class="os-start-app os-visit-app"/g) || []).length === 3, rows);
  ok('Start menu: Recent carries the Recent delegate only; Unfiled carries neither',
    /data-osvisit="recent" data-nbd-recent-visits=""(?! data-nbd-record)/.test(rows) && /data-osvisit="unfiled">/.test(rows) && !/data-osvisit="unfiled"[^>]*data-nbd-/.test(rows));
  ok('Start search "unf" keeps only Unfiled', (api.visitStartRows('unf').match(/os-visit-app/g) || []).length === 1 && /Unfiled visits \(2\)/.test(api.visitStartRows('unf')));
  ok('Start search "visit" keeps all three', (api.visitStartRows('visit').match(/os-visit-app/g) || []).length === 3);
  ok('Start search "pipeline" drops the whole group (no orphan heading)', api.visitStartRows('pipeline') === '');
  const bar = api.visitBarHtml();
  ok('phone bar: Record with its badge, via the delegate', /class="os-bar-btn os-bar-rec" data-osvisit="record" data-nbd-record-visit=""/.test(bar) && /os-visit-badge[^>]*>2</.test(bar) && /<span class="os-bar-label">Record<\/span>/.test(bar), bar);
  const row = api.visitPhoneRowHtml();
  ok('phone home screen: a Visits row of three app icons, Record first', /role="group" aria-label="Visits"/.test(row) && (row.match(/os-p-icon os-visit-icon/g) || []).length === 3 && row.indexOf('is-rec') < row.indexOf('Recent visits'), row);
  ok('no visit item opens a window (no data-osp / data-osapp)', !/data-osp=|data-osapp=/.test(bar + row + rows));
}
{
  const { api, store } = load(null);
  ok('no count stored yet reads as zero', api.visitItems('').length === 2);
  store.nbd_vr_unfiled = 'junk';
  ok('a junk count reads as zero', api.visitItems('').length === 2);
}

console.log('what a tap does');
{
  const L = load(1);
  L.setS({ startOpen: true });
  L.api.onVisitTap(el({ 'data-osvisit': 'unfiled' }));
  ok('Unfiled closes the Start menu and opens the Unfiled sheet', L.calls.join() === 'setStart:false,openUnfiled', L.calls.join());
  const M = load(1);
  M.setS({ startOpen: true });
  M.api.onVisitTap(el({ 'data-osvisit': 'record' }));
  ok('Record closes the Start menu and leaves the start to the launcher delegate', M.calls.join() === 'setStart:false', M.calls.join());
  const N = load(1);
  N.setS({ startOpen: false });
  N.api.onVisitTap(el({ 'data-osvisit': 'recent' }));
  ok('Recent with the Start menu shut does nothing itself (the delegate opens the sheet)', N.calls.length === 0, N.calls.join());
}

console.log('wiring');
{
  ok('the taskbar has a slot right after Overview, filled at mount', /aria-label="Overview: every window on this desk">▦<\/button>' \+\n\s*'<div class="os-visit-slot"><\/div>'/.test(OS) && /S\.visitTaskEl\.innerHTML = visitTaskHtml\(\);/.test(OS));
  ok('the Start list puts the Visits group first', /return visits \+ list\.map\(/.test(OS) && /if \(!list\.length && !visits\)/.test(OS));
  ok('...and the apps start on a fresh row under an Apps heading', /if \(visits && list\.length\) visits \+= '<li class="os-start-group ui-eyebrow" aria-hidden="true">Apps<\/li>';/.test(OS));
  const desk = OS.slice(OS.indexOf('function onDeskClick'), OS.indexOf('function onDeskClick') + 400);
  ok('desk clicks route a visit tap before windows, overview or pins', desk.indexOf('if (vz) { onVisitTap(vz); return; }') !== -1 && desk.indexOf('if (vz) { onVisitTap(vz); return; }') < desk.indexOf('S.overview'));
  // 450, not 300 (2026-11-08): the gesture-swallow guard now opens the function, before the visit branch.
  const ph = OS.slice(OS.indexOf('function onPhoneClick'), OS.indexOf('function onPhoneClick') + 450);
  ok('phone clicks route a visit tap before the app handlers', ph.indexOf('if (vz) { onVisitTap(vz); return; }') !== -1 && ph.indexOf('if (vz) { onVisitTap(vz); return; }') < ph.indexOf("closest('[data-osp]')"));
  ok('the phone bar has Record right after Home, not while rearranging the dock', /<span class="os-bar-label">Home<\/span><\/button>' \+\n\s*\(S\.editing \? '' : visitBarHtml\(\)\) \+/.test(OS));
  // P3 (2026-11-09): Pocket's phone icon may share the row (.os-p-toprow)
  ok('the home screen has the Visits row above the pages, not while rearranging',
    /if \(!S\.editing\) h \+= (?:'<div class="os-p-toprow">' \+ )?visitPhoneRowHtml\(\)(?: \+ pocketIconHtml\(\) \+ '<\/div>')?;\n\s*h \+= '<div class="os-p-pages"/.test(OS));
  ok('mount watches the count; unmount stops the retry', /watchViews\(\);\n\s*watchVisits\(\);/.test(OS) && /clearTimeout\(st\.visitT\)/.test(OS));
  ok('the count follows another tab (storage) and the recorder\'s counters event', /on\(W, 'storage'/.test(body) && /R\.subscribe\(function \(k\) \{ if \(k === 'counters'\) paintVisits\(\); \}\)/.test(body) && /S\.unbind\.push\(off\)/.test(body));
  ok('every value in the markup is escaped or a number', !/\+ it\.label \+|\+ it\.icon \+/.test(body));
  const L = read('docs/pro/js/visit-recorder-launcher.js');
  ok('the round record button / Home bar stays Classic and Bento only (not NBD OS)', /var BAR_LAYOUTS = \{ classic: 1, bento: 1 \};/.test(L));
  ok('the launcher delegate still starts Record and opens Recent', /closest\('\[data-nbd-recent-visits\]'\)/.test(L) && /closest\('\[data-nbd-record-visit\]'\)/.test(L));
  ok('recorder sources: fab is an allowed source (the rules list)', /d\.source in \['fab', 'appointment', 'customer', 'deeplink'\]/.test(read('firestore.rules')));
}

console.log('css');
{
  const glyph = (/\.os-rec-glyph \{([^}]*)\}/.exec(CSS) || [])[1] || '';
  ok('the Record glyph is the round button in small, from theme tokens', /var\(--red\)/.test(glyph) && /var\(--orange\)/.test(glyph) && !/#[0-9a-f]{3,8}\b/i.test(glyph), glyph);
  const visits = CSS.slice(CSS.indexOf('/* ── visits (2026-11-07)'));
  ok('no hex colours in the visits styles', visits.length > 100 && !/#[0-9a-f]{3,8}\b/i.test(visits));
  ok('the Start group heading spans both columns', /\.os-start-group \{ grid-column: 1 \/ -1;/.test(CSS));
  ok('the phone Visits row uses the home screen\'s 4-column grid', /\.os-p-visits \{[^}]*grid-template-columns: repeat\(4, 1fr\)/.test(CSS));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
