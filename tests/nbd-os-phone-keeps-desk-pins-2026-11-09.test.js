/**
 * tests/nbd-os-phone-keeps-desk-pins-2026-11-09.test.js - NBD OS P0a
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md, section 8).
 *
 * The phone mount restored icons, dock, recent, windows and focus from the
 * saved OS session, but not the laptop's current desk or its taskbar pins. S
 * kept mount()'s defaults (desk 0, pins []), and the next save (any icon
 * move, page change or app open on the phone) wrote them back. So one phone
 * visit reset the laptop to desk 1 and emptied its pinned apps.
 *
 * Runs the REAL phone-mount restore lines and the REAL writeState() from
 * layouts/os.js in a vm, with the real normalizeState from os-wm-logic.js,
 * then checks the desktop restore still carries desk and pins too.
 *
 * Run: node tests/nbd-os-phone-keeps-desk-pins-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const OS = fs.readFileSync(path.join(ROOT, 'docs/pro/js/layouts/os.js'), 'utf8').replace(/\r\n/g, '\n');
const WM = require(path.join(ROOT, 'docs/pro/js/layouts/os-wm-logic.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}

// The phone mount's restore block: from its savedState() read to "S.page = 0;".
const pm = OS.indexOf('function mountPhone()');
const r0 = pm >= 0 ? OS.indexOf('var st = savedState();', pm) : -1;
const r1 = r0 >= 0 ? OS.indexOf('S.page = 0;', r0) : -1;
const RESTORE = r0 >= 0 && r1 > r0 ? OS.slice(r0, r1) : '';
// writeState(), verbatim.
const w0 = OS.indexOf('  function writeState(src) {');
const w1 = w0 >= 0 ? OS.indexOf('\n  }\n', w0) : -1;
const WRITE = w0 >= 0 && w1 > w0 ? OS.slice(w0, w1 + 4) : '';
ok('found the phone-mount restore block and writeState in os.js', !!RESTORE && !!WRITE);

const SAVED = {
  wins: [{ id: 'crm', x: 40, y: 40, w: 600, h: 400, z: 2, min: false, zone: '', desk: 3 }],
  focus: 'crm', icons: ['home', 'crm'], dock: ['home'], recent: ['crm'], desk: 3, pins: ['crm', 'schedule'],
};

function phoneVisitThenSave() {
  const saves = [];
  const ctx = {
    WM, JSON,
    // mount()'s defaults, as os.js sets them before mountPhone()
    S: { surface: 'phone', wins: [], focus: null, icons: [], dock: [], recent: [], desk: 0, pins: [] },
    savedState: () => WM.normalizeState(JSON.parse(JSON.stringify(SAVED)), ['home', 'crm', 'schedule']),
    safe: (fn) => fn(),
    W: { LayoutEngine: { saveUser: (p) => saves.push(JSON.parse(JSON.stringify(p))) } },
  };
  vm.createContext(ctx);
  vm.runInContext(WRITE + '\n' + RESTORE + '\nwriteState(S);', ctx);
  return saves.length ? saves[0].layoutState.os : null;
}

console.log('a phone visit, then a save, keeps the laptop session');
{
  const st = RESTORE && WRITE ? phoneVisitThenSave() : null;
  ok('the save happened', !!st);
  ok('the laptop\'s current desk survives (3, not reset to 0)', st && st.desk === 3, st && JSON.stringify({ desk: st.desk }));
  ok('the laptop\'s taskbar pins survive', st && JSON.stringify(st.pins) === JSON.stringify(['crm', 'schedule']), st && JSON.stringify(st.pins));
  ok('windows, icons, dock and recent still survive, as before', st && st.wins.length === 1 && st.wins[0].desk === 3
    && JSON.stringify(st.icons) === JSON.stringify(['home', 'crm']) && JSON.stringify(st.dock) === JSON.stringify(['home']));
}

console.log('the desktop restore is unchanged');
{
  ok('mountDesk still restores desk and pins from the saved session',
    /S\.icons = st\.icons; S\.dock = st\.dock; S\.recent = st\.recent; S\.desk = st\.desk; S\.pins = st\.pins;/.test(OS));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
