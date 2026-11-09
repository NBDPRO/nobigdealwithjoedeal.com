/**
 * tests/nbd-os-pocket-2026-11-09.test.js - NBD OS P3, Pocket: the pure half
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md section 6 #9, i3's scratchpad).
 *
 *   - the shortcut (layouts/os-wm-logic.js pocketKey): Alt+` by key position only, never
 *     with Ctrl / Cmd / Shift, never on repeat or mid-IME, never inside a field
 *   - no other CRM handler binds Backquote (the shortcut collides with nothing)
 *   - os/pocket-logic.js: device-only notes, per user, bounded (count and length), cleaned;
 *     add / remove / restore never drop a note silently
 *   - lazy and writer-free: no <script> tag, no needs path; Pocket's files hold no
 *     Firestore, callable or network call
 *
 * Run: node tests/nbd-os-pocket-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n') : '');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
function G(fn) { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } }
const J = (v) => JSON.stringify(v);

const WM = require(path.join(ROOT, 'docs/pro/js/layouts/os-wm-logic.js'));
let PL = null;
try { PL = require(path.join(ROOT, 'docs/pro/js/os/pocket-logic.js')); } catch (e) { PL = null; }

console.log('\n1. the shortcut: Alt+` (layouts/os-wm-logic.js pocketKey)');
G(() => {
  ok('pocketKey is exported', typeof WM.pocketKey === 'function');
  const k = (o) => (typeof WM.pocketKey === 'function' ? WM.pocketKey(Object.assign({ code: 'Backquote', key: '`', altKey: true, target: { tagName: 'BUTTON' } }, o)) : null);
  ok('Alt+` on a button: yes', k({}) === true);
  ok('Alt+` on the page body: yes', k({ target: { tagName: 'BODY' } }) === true);
  ok('by key position: macOS Option+` (a dead key) still matches', k({ key: 'Dead' }) === true);
  ok('by key position: a layout whose key there is not ` still matches', k({ key: '²' }) === true);
  ok('no Alt: no', k({ altKey: false }) === false);
  ok('Ctrl+Alt+`: no (a chord of its own)', k({ ctrlKey: true }) === false);
  ok('Cmd+Alt+`: no', k({ metaKey: true }) === false);
  ok('Shift+Alt+`: no', k({ shiftKey: true }) === false);
  ok('auto-repeat (key held): no', k({ repeat: true }) === false);
  ok('mid-IME composition: no', k({ isComposing: true }) === false);
  ok('another handler already took it: no', k({ defaultPrevented: true }) === false);
  ok('another key with Alt: no', k({ code: 'KeyA', key: 'a' }) === false);
  ok('inside an INPUT: no', k({ target: { tagName: 'INPUT' } }) === false);
  ok('inside a TEXTAREA: no', k({ target: { tagName: 'TEXTAREA' } }) === false);
  ok('inside a SELECT: no', k({ target: { tagName: 'SELECT' } }) === false);
  ok('inside contentEditable: no', k({ target: { tagName: 'DIV', isContentEditable: true } }) === false);
  ok('no event: no', typeof WM.pocketKey === 'function' && WM.pocketKey(null) === false);
});

console.log('\n2. it collides with nothing the CRM already binds');
G(() => {
  const files = ['docs/pro/js/command-palette.js', 'docs/pro/js/command-palette-scopes.js', 'docs/pro/js/command-runner.js', 'docs/pro/js/os/system.js',
    'docs/pro/js/layouts/os.js', 'docs/pro/js/global-search.js', 'docs/pro/js/shortcuts-help.js', 'docs/pro/js/ui.js', 'docs/pro/js/dashboard-bootstrap.module.js',
    'docs/pro/js/overlay-a11y.js', 'docs/pro/js/nbd-whisper.js', 'docs/pro/js/quick-capture.js'];
  files.forEach((f) => {
    const src = noComments(read(f));
    ok(f + ' binds no Backquote / ` key', !/Backquote|key\s*===?\s*['"]`['"]/.test(src));
  });
  ok('the CRM\'s documented shortcuts (shortcuts-help.js) list no Alt+`', !/Alt\+`/.test(read('docs/pro/js/shortcuts-help.js')));
});

console.log('\n3. device-only notes (os/pocket-logic.js)');
G(() => {
  ok('os/pocket-logic.js loads as a module', !!PL);
  if (!PL) return;
  ok('bounds: 20 notes, 2,000 characters each', PL.MAX_NOTES === 20 && PL.MAX_LEN === 2000, J([PL.MAX_NOTES, PL.MAX_LEN]));
  ok('a key per user', PL.key('u1') === 'nbd_os_pocket:u1' && PL.key('u2') !== PL.key('u1'));
  ok('the draft has its own key per user', PL.draftKey('u1') === 'nbd_os_pocket_draft:u1');
  ok('no user (signed out): no key, so nothing is stored', PL.key('') === null && PL.key(null) === null && PL.draftKey(undefined) === null);
  ok('a uid that is not an id: no key', PL.key('a/b') === null && PL.key('x'.repeat(200)) === null && PL.key('<b>') === null);

  const now = Date.UTC(2026, 10, 9, 18, 0);
  ok('normalize: junk is an empty list', J(PL.normalize(null)) === '[]' && J(PL.normalize('not json')) === '[]' && J(PL.normalize({ a: 1 })) === '[]');
  const n = PL.normalize(JSON.stringify([
    { id: 'a1', text: '  first \u0007 note  ', at: now - 5000 },
    { id: 'b2', text: 'newer', at: now },
    { id: 'b2', text: 'dupe id', at: now - 1 },
    { id: 'BAD ID', text: 'x', at: now },
    { id: 'c3', text: '   ', at: now },
    { id: 'd4', text: 'no time' },
    { id: 'e5', text: 'y'.repeat(5000), at: now - 9000 },
    'string', null,
  ]));
  ok('normalize keeps valid notes, newest first', J(n.map((x) => x.id)) === J(['b2', 'a1', 'e5']), J(n.map((x) => x.id)));
  ok('normalize trims and strips control characters', n[1].text === 'first  note', J(n[1].text));
  ok('normalize clips a note at 2,000 characters', n[2].text.length === 2000);
  ok('normalize drops a repeated id, a bad id, an empty note and a note with no time', n.length === 3);
  ok('normalize keeps line breaks', PL.normalize([{ id: 'a', text: 'one\r\ntwo', at: now }])[0].text === 'one\ntwo');
  const many = []; for (let i = 0; i < 30; i++) many.push({ id: 'n' + i, text: 't' + i, at: now - i * 1000 });
  ok('normalize caps the list at 20', PL.normalize(many).length === 20 && PL.normalize(many)[0].id === 'n0');

  const a = PL.add([], '  Gate code 4471  ', now);
  ok('add: a note with an id, its text and its time', a.note && a.note.text === 'Gate code 4471' && a.note.at === now && /^[a-z0-9]{1,24}$/.test(a.note.id) && a.list.length === 1, J(a));
  const b = PL.add(a.list, 'second', now);
  ok('add: the same millisecond still gets a new id, newest first', b.note.id !== a.note.id && b.list.length === 2, J(b.list));
  ok('add: an empty note is refused, the list unchanged', PL.add(a.list, '   ', now).error === 'empty' && PL.add(a.list, '   ', now).list.length === 1);
  const full = PL.normalize(many);
  const f = PL.add(full, 'one more', now + 1);
  ok('add: a full Pocket refuses (never drops the oldest)', f.error === 'full' && f.list.length === 20 && f.list.every((x) => x.text !== 'one more') && f.list.some((x) => x.id === 'n19'), J(f.error));

  const r = PL.remove(b.list, a.note.id);
  ok('remove: gives back the note and leaves the rest', r.removed && r.removed.id === a.note.id && r.list.length === 1 && r.list[0].id === b.note.id, J(r));
  ok('remove: an unknown id changes nothing', PL.remove(b.list, 'zz').removed === null && PL.remove(b.list, 'zz').list.length === 2);
  const back = PL.restore(r.list, r.removed);
  ok('restore: undo puts it back in its place', back.list.length === 2 && back.list[1].id === a.note.id, J(back));
  ok('restore: into a full Pocket it refuses (nothing dropped)', PL.restore(full, { id: 'zz', text: 'z', at: now }).error === 'full' && PL.restore(full, { id: 'zz', text: 'z', at: now }).list.length === 20);

  ok('when: under a minute is "just now"', PL.when(now - 20000, now) === 'just now');
  ok('when: minutes', PL.when(now - 7 * 60000, now) === '7 min ago');
  ok('when: an earlier hour today is a clock time', /^\d{1,2}:\d{2} (AM|PM)$/.test(PL.when(now - 3 * 3600000, now)), PL.when(now - 3 * 3600000, now));
  ok('when: another day names the day', /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/.test(PL.when(now - 3 * 86400000, now)), PL.when(now - 3 * 86400000, now));
  ok('when: no time is empty, never a made-up one', PL.when(0, now) === '' && PL.when(NaN, now) === '');
});

console.log('\n4. lazy and writer-free');
G(() => {
  const dash = read('docs/pro/dashboard.html');
  ok('no <script> tag for Pocket on the dashboard', !/<script[^>]*pocket/i.test(dash));
  const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
  const os = R.get('os');
  ok('no needs path for Pocket (needs is full)', os.needs.script.every((p) => !/pocket/.test(p)) && (os.needs.css || []).every((p) => !/pocket/.test(p)));
  const OS = read('docs/pro/js/layouts/os.js');
  ok('layouts/os.js registers the ospocket bundle at runtime: css, logic, then the sheet',
    /POCKET_FILES = \['css\/os\/pocket\.css\?v=\d+', 'js\/os\/pocket-logic\.js\?v=\d+', 'js\/os\/pocket\.js\?v=\d+'\]/.test(OS));
  ['docs/pro/js/os/pocket.js', 'docs/pro/js/os/pocket-logic.js'].forEach((f) => {
    const src = noComments(read(f));
    ok(f + ' exists', src.length > 0);
    ok(f + ' has no Firestore, callable or network call',
      !/\b(addDoc|setDoc|updateDoc|deleteDoc|writeBatch|runTransaction|getDocs?|onSnapshot|collection|httpsCallable|_httpsCallable|fetch|XMLHttpRequest|sendBeacon)\s*\(/.test(src) && !/\bimport\s*\(/.test(src));
    ok(f + ' writes no inline style or handler', !/style\s*=|\.style\.|cssText|\son[a-z]+\s*=/.test(src));
  });
  const css = read('docs/pro/css/os/pocket.css');
  ok('css/os/pocket.css exists', css.length > 0);
  ok('css: hidden under the lock screen', /html\.os-locked[^{]*\.os-pocket-wrap[^{]*\{[^}]*display:\s*none/.test(css));
  ok('css: no motion under prefers-reduced-motion', /@media \(prefers-reduced-motion: reduce\)[^]*?\.os-pocket[^{]*\{[^}]*animation:\s*none/.test(css));
  ok('css: no motion under data-motion="reduce"', /:root\[data-motion="reduce"\][^{]*\.os-pocket[^{]*\{[^}]*animation:\s*none/.test(css));
  ok('css: 44px targets', /\.os-pocket-btn[^{]*\{[^}]*min-height:\s*44px/.test(css) && /\.os-pocket-x[^{]*\{[^}]*min-height:\s*44px/.test(css));
  const sizes = (css.match(/font-size:\s*(\d+(?:\.\d+)?)px/g) || []).map((s) => parseFloat(s.replace(/[^\d.]/g, '')));
  ok('css: no literal font size under 11px', sizes.every((x) => x >= 11), J(sizes));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
