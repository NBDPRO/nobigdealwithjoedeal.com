/**
 * tests/nbd-os-home-key-2026-11-09.test.js - NBD OS P0b step 2
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md, sections 3.5 and 8).
 *
 * The home screen's arrangement gets its own key, layoutState['os-home'] =
 * { v:1, phone:[{id,s,cfg?}], desk:[{id,s,cfg?}] }, under its own 12,000-char
 * budget (a separate key, so a full home can never push the OS windows over
 * the budget and drop them). docs/pro/js/os/home-logic.js normalises it:
 *   - at most 12 items per surface; known widget ids only; s is 's'|'m'|'l'
 *     (one the widget offers, else its default size)
 *   - cfg: enum values the widget declares, 64 chars of JSON at most
 *   - garbage in, a clean default out; a new user gets
 *     phone [glance m, upnext m, shortcuts s] and the same on the desk
 * and the max-fill state still fits the budget; normalise is a round trip.
 *
 * Run: node tests/nbd-os-home-key-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'docs/pro/js/os/home-logic.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);

let H = null;
try { H = require(FILE); } catch (e) { H = null; }
ok('docs/pro/js/os/home-logic.js exists and require()s in Node', !!H && typeof H.normalize === 'function', fs.existsSync(FILE) ? 'loaded but no normalize' : 'missing');
if (!H) { console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); }
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));

console.log('\n1. the key and its catalog');
{
  ok('the key is os-home, a valid layoutState key', H.KEY === 'os-home' && R.isId(H.KEY));
  ok('caps: 12 items per surface, cfg 64 chars, sizes s/m/l', H.MAX_ITEMS === 12 && H.MAX_CFG === 64 && J(H.SIZES) === J(['s', 'm', 'l']));
  ok('the P0 catalog: At a Glance, Up Next, Shortcuts (P0b), then Coach (P0c)', J(H.ids().slice(0, 4)) === J(['glance', 'upnext', 'shortcuts', 'coach']));
  ok('every widget declares a read cost of 0', H.ids().every((id) => H.CATALOG[id].reads === 0));
  ok('every widget has a title, sizes from s/m/l and a default among them', H.ids().every((id) => {
    const c = H.CATALOG[id];
    return typeof c.title === 'string' && c.title && c.sizes.length && c.sizes.every((s) => H.SIZES.indexOf(s) !== -1) && c.sizes.indexOf(c.def) !== -1;
  }));
  ok('the Shortcuts clock is an enum option (on/off)', J(H.CATALOG.shortcuts.config) === J({ clock: ['on', 'off'] }));
}

console.log('\n2. a new user\'s home');
{
  const want = [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }, { id: 'shortcuts', s: 's' }];
  const d = H.defaults();
  ok('defaults(): phone glance m, upnext m, shortcuts s', J(d.phone) === J(want), J(d.phone));
  ok('defaults(): the desk the same', J(d.desk) === J(want), J(d.desk));
  ok('defaults() is v:1 and a fresh copy each time', d.v === 1 && H.defaults() !== d && (H.defaults().phone.push({}), J(H.defaults().phone) === J(want)));
  ok('nothing saved (undefined / null) -> the defaults', J(H.normalize(undefined)) === J(d) && J(H.normalize(null)) === J(d));
}

console.log('\n3. garbage in, a clean default out');
{
  const d = H.defaults();
  const junk = [42, 'os', [], true, () => 1, { phone: 'x', desk: 7 }, { phone: [null, 5, 'glance', { id: 'nope' }, { id: '__proto__' }, { id: 'constructor' }], desk: [{}] }];
  junk.forEach((j, i) => ok('junk #' + i + ' normalises to the defaults', J(H.normalize(j)) === J(d), J(H.normalize(j))));
  ok('a surface that is junk gets its default while the other keeps its own',
    J(H.normalize({ phone: [{ id: 'upnext', s: 'l' }], desk: 'junk' })) === J({ v: 1, phone: [{ id: 'upnext', s: 'l' }], desk: d.desk }));
  ok('an empty list is the member\'s choice, kept (not refilled)', J(H.normalize({ phone: [], desk: [] })) === J({ v: 1, phone: [], desk: [] }));
  const mixed = H.normalize({ phone: [{ id: 'glance', s: 'xl' }, { id: 'evil', s: 's' }, { id: 'upnext', s: 'l', extra: '<script>' }, { id: 'shortcuts', s: 'm', cfg: { clock: 'on', x: 1 } }] });
  ok('an unknown size falls back to the widget\'s default; unknown ids and extra fields are dropped',
    J(mixed.phone) === J([{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'l' }, { id: 'shortcuts', s: 'm', cfg: { clock: 'on' } }]), J(mixed.phone));
  ok('cfg keeps only declared keys with declared values',
    J(H.normalize({ desk: [{ id: 'shortcuts', s: 's', cfg: { clock: 'maybe' } }, { id: 'shortcuts', s: 's', cfg: 'on' }, { id: 'glance', s: 's', cfg: { clock: 'on' } }] }).desk)
      === J([{ id: 'shortcuts', s: 's' }, { id: 'shortcuts', s: 's' }, { id: 'glance', s: 's' }]));
  ok('cfg over 64 chars of JSON is dropped whole', H.cleanCfg('shortcuts', { clock: 'on' }) && J(H.cleanCfg('shortcuts', { clock: 'on' })).length <= 64
    && H.cleanCfg('nope', { clock: 'on' }) === null && H.cleanCfg('shortcuts', null) === null);
  const many = []; for (let i = 0; i < 40; i++) many.push({ id: H.ids()[i % 3], s: 'l' });
  ok('at most 12 items per surface', H.normalize({ phone: many, desk: many }).phone.length === 12 && H.normalize({ phone: many, desk: many }).desk.length === 12);
  ok('the output never shares objects with the input', (() => { const inp = { phone: [{ id: 'glance', s: 's' }] }; const o = H.normalize(inp); o.phone[0].s = 'l'; return inp.phone[0].s === 's'; })());
}

console.log('\n4. max-fill fits the 12,000-char budget');
{
  // the largest item: the longest id, the largest size and the largest valid cfg
  const longestId = H.ids().reduce((a, b) => (b.length > a.length ? b : a));
  const cfgIds = H.ids().filter((id) => H.CATALOG[id].config);
  let worst = { id: longestId, s: 'm' };
  cfgIds.forEach((id) => {
    const conf = H.CATALOG[id].config; const cfg = {};
    Object.keys(conf).forEach((k) => { cfg[k] = conf[k].reduce((a, b) => (String(b).length > String(a).length ? b : a)); });
    const it = { id, s: 'm', cfg: H.cleanCfg(id, cfg) || undefined };
    if (J(it).length > J(worst).length) worst = it;
  });
  const fill = []; for (let i = 0; i < 30; i++) fill.push(worst);
  const st = H.normalize({ v: 1, phone: fill, desk: fill });
  const len = J(st).length;
  ok('the max-fill state serialises under 12,000 chars (' + len + ')', len <= R.MAX_STATE_JSON && len < 12000, len);
  ok('the theoretical bound holds too (12 x 2 items of the 64-char cfg cap)', 2 * H.MAX_ITEMS * (J({ id: 'x'.repeat(32), s: 'm', cfg: {} }).length + H.MAX_CFG) + 40 < 12000);
  ok('LayoutRegistry keeps the max-fill key (its per-key budget)', !!R.normalizeUser({ layoutState: { 'os-home': st } }).layoutState['os-home']);
}

console.log('\n5. round trip');
{
  const samples = [undefined, H.defaults(), { phone: [{ id: 'upnext', s: 'l' }, { id: 'shortcuts', s: 's', cfg: { clock: 'off' } }], desk: [] },
    { v: 9, phone: [{ id: 'glance', s: 'zz' }, 'x'], desk: [{ id: 'shortcuts', cfg: { clock: 'on' } }] }];
  samples.forEach((s, i) => {
    const a = H.normalize(s);
    const b = H.normalize(JSON.parse(J(a)));
    ok('sample #' + i + ': normalise -> JSON -> normalise is unchanged', J(a) === J(b), J(a) + ' vs ' + J(b));
    const viaReg = R.normalizeUser({ layoutState: { 'os-home': a } }).layoutState['os-home'];
    ok('sample #' + i + ': it survives LayoutRegistry.normalizeUser unchanged', J(H.normalize(viaReg)) === J(a));
  });
}

console.log('\n6. the module shape (lazy, pure, UMD like os-wm-logic.js)');
{
  const src = fs.readFileSync(FILE, 'utf8');
  ok('UMD: module.exports and window.NBDOSHomeLogic', /module\.exports = api/.test(src) && /root\.NBDOSHomeLogic = api/.test(src));
  ok('pure: no DOM, storage, network or Firestore', !/document\.|localStorage|fetch\(|getDoc|setDoc|onSnapshot|XMLHttpRequest/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  const html = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
  ok('no <script> tag for it on the dashboard (it loads lazily with the OS layout)', !/os\/home-logic\.js/.test(html));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
