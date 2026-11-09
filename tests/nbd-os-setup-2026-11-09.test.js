/**
 * tests/nbd-os-setup-2026-11-09.test.js - NBD OS P3 "Copy my setup"
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.5, §8 P3).
 *
 * Export: the member's home (each surface's widgets, sizes, desk cells, settings and
 * Smart Stack cards, wallpaper ids, the four modes) as JSON text to copy; never which
 * mode is on, a lead, a count, money or a URL. Import by paste: validated only through
 * os/home-logic.js normalize (the 24 cap, catalog ids, enum / id settings, unknown keys
 * dropped), shown as a preview, written on confirm through LayoutEngine.saveUser,
 * os-home only (patch-only). A surface the company locked keeps its home: the lock
 * wins. Hostile text is refused with a plain sentence and writes nothing.
 *
 * Run: node tests/nbd-os-setup-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, click, text, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const HL = req('docs/pro/js/os/home-logic.js');
const SU = req('docs/pro/js/os/setup-logic.js');
const R = req('docs/pro/js/layout-system.js');
const tick = () => new Promise((r) => setImmediate(r));
const SETUP_JS = read('docs/pro/js/os/setup.js');
const SETUP_CSS = read('docs/pro/css/os/setup.css');
const OS_JS = read('docs/pro/js/layouts/os.js');

const MINE = {
  v: 1,
  phone: [{ id: 'stack', s: 'l', items: ['upnext', 'daily'] }, { id: 'coach', s: 'm', cfg: { show: 'business' } }, { id: 'kpi', s: 's', cfg: { view: 'a1b2c3d4' } }, { id: 'kpi', s: 's', cfg: { view: '0f0f0f0f' } }],
  desk: [{ id: 'glance', s: 'l', x: 2, y: 0, w: 2, h: 2 }, { id: 'money', s: 's', x: 0, y: 0, w: 1, h: 1 }],
  wp: { phone: 'tod', desk: 'abcd1234' },
  acts: [{ id: 'canvass', name: 'Knocking', focus: { phase: 'leads' }, phone: [{ id: 'upnext', s: 'm' }] }],
  on: { phone: 'inhome', desk: null },
};

console.log('\n1. export: the setup as text, ids only');
{
  ok('setup-logic loads in Node (with home-logic)', !!SU && typeof SU.parse === 'function' && typeof SU.exportText === 'function');
  const seen = HL.resolveHome({ own: MINE });
  const txt = SU.exportText(seen, MINE);
  const obj = JSON.parse(txt);
  ok('the text is { nbd: "nbd-os-setup", v: 1, home }', obj.nbd === 'nbd-os-setup' && obj.v === 1 && !!obj.home);
  ok('it carries the widgets, sizes, cells, settings and stack cards as saved', J(obj.home.phone) === J(HL.normalize(MINE).phone) && J(obj.home.desk) === J(HL.normalize(MINE).desk));
  ok('…the wallpaper ids and the modes', J(obj.home.wp) === J(MINE.wp) && Array.isArray(obj.home.acts) && obj.home.acts.length === 4 && obj.home.acts[0].name === 'Knocking');
  ok('…not which mode is on', !('on' in obj.home));
  ok('…and nothing else: only the os-home fields', Object.keys(obj.home).every((k) => ['v', 'phone', 'desk', 'wp', 'acts'].indexOf(k) !== -1), Object.keys(obj.home));
  const co = HL.resolveHome({ own: null, company: { 'os-phone': [{ id: 'upnext', s: 'l' }] }, locked: true });
  const coTxt = JSON.parse(SU.exportText(co, null));
  ok('a member on the company home exports what they see (ids only), no own wallpaper or modes', J(coTxt.home.phone) === J([{ id: 'upnext', s: 'l' }]) && !coTxt.home.wp && !coTxt.home.acts, J(coTxt));
}

console.log('\n2. round trip: export, paste, the same home');
{
  const seen = HL.resolveHome({ own: MINE });
  const p = SU.parse(SU.exportText(seen, MINE));
  ok('the exported text parses', p.ok === true, J(p));
  const next = SU.merge({ v: 1, phone: [{ id: 'glance', s: 'm' }], on: { phone: 'storm', desk: null } }, p.home, { phone: false, desk: false });
  const want = HL.keep(MINE);
  ok('pasted onto another account: the same phone, desk, wallpaper and modes', J(next.phone) === J(want.phone) && J(next.desk) === J(want.desk) && J(next.wp) === J(want.wp) && J(next.acts) === J(want.acts), J(next));
  ok('…and that account keeps its own mode on', J(next.on) === J({ phone: 'storm', desk: null }));
  ok('pasting your own setup back changes nothing', SU.same(SU.merge(MINE, p.home, {}), MINE));
  const back = SU.parse(SU.exportText(HL.resolveHome({ own: next }), next));
  ok('export, paste, export again: the same text', back.ok && J(back.home) === J(p.home));
  ok('a pasted surface the setup does not have keeps the member\'s own', (() => {
    const only = SU.parse(J({ nbd: 'nbd-os-setup', v: 1, home: { desk: [{ id: 'coach', s: 'l' }] } }));
    const n = SU.merge(MINE, only.home, {});
    return only.ok && J(n.phone) === J(HL.keep(MINE).phone) && n.desk[0].id === 'coach';
  })());
  ok('an empty surface is a choice, kept as empty', (() => { const e = SU.parse(J({ nbd: 'nbd-os-setup', v: 1, home: { phone: [] } })); return e.ok && J(e.home.phone) === '[]'; })());
  ok('the preview says what it holds, in words', J(SU.summary(p.home, {})) === J([
    'Phone: 5 widgets (Smart Stack, Coach, Saved view (2))',
    'Laptop: 2 widgets (Money, At a Glance)',
    'Wallpaper: phone Time of day, laptop a My Skin picture',
    'Modes: Knocking, In a home, Storm day, Office',
    'A Saved view tile counts only a view your team has saved; any other shows no number.',
  ]), J(SU.summary(p.home, {})));
}

console.log('\n3. hostile or broken text is refused, and nothing in it survives');
{
  const bad = [
    ['empty', ''], ['spaces', '   '], ['not text', 42], ['not JSON', '{nbd:'], ['an array', '[]'], ['a string', '"hi"'],
    ['no marker', J({ v: 1, home: { phone: [{ id: 'glance', s: 'm' }] } })],
    ['another format', J({ nbd: 'other', v: 1, home: { phone: [{ id: 'glance', s: 'm' }] } })],
    ['a future version', J({ nbd: 'nbd-os-setup', v: 2, home: { phone: [{ id: 'glance', s: 'm' }] } })],
    ['home not an object', J({ nbd: 'nbd-os-setup', v: 1, home: [] })],
    ['nothing usable', J({ nbd: 'nbd-os-setup', v: 1, home: { phone: [{ id: 'evil' }], desk: 'x', wp: 'x', acts: {} } })],
    ['only unknown widgets', J({ nbd: 'nbd-os-setup', v: 1, home: { phone: [{ id: '<script>' }, { id: '__proto__' }, { id: 'constructor' }] } })],
    ['prototype keys', '{"nbd":"nbd-os-setup","v":1,"home":{"__proto__":{"phone":[{"id":"glance","s":"m"}]}}}'],
    ['too long', J({ nbd: 'nbd-os-setup', v: 1, home: { phone: [{ id: 'glance', s: 'm' }] }, pad: 'x'.repeat(SU.MAX_TEXT) })],
  ];
  const fails = bad.filter(([, t]) => { const r = SU.parse(t); return r.ok !== false || typeof r.error !== 'string' || !r.error; });
  ok('each is refused with a sentence (' + bad.length + ' cases)', !fails.length, fails.map((f) => f[0]).join(', '));
  ok('no prototype was touched', ({}).phone === undefined && Object.prototype.phone === undefined);
  const hostile = {
    nbd: 'nbd-os-setup', v: 1, extra: 'dropped',
    home: {
      v: 9, evil: '<img src=x onerror=alert(1)>', on: { phone: 'storm' },
      phone: [
        { id: 'glance', s: 'xl', onclick: 'alert(1)', cfg: { x: 1 } },
        { id: 'coach', s: 'm', cfg: { show: '<b>', html: '<i>' } },
        { id: 'kpi', s: 'm', cfg: { view: 'Hot Hail', name: 'Pat Customer', filters: { rep: ['u1'] } } },
        { id: 'stack', s: 'l', items: ['glance', 'kpi', 'evil', 'stack', 'daily', 'coach', 'money', 'storm'] },
        { id: 'nope' }, null, 'glance', 7,
      ].concat(Array.from({ length: 60 }, () => ({ id: 'upnext', s: 'm' }))),
      desk: [{ id: 'money', s: 'm', x: -4, y: 9999, w: 99, h: 99, href: 'https://evil.example' }],
      wp: { phone: 'https://evil.example/x.png', desk: '../../etc', extra: 1 },
      acts: [{ id: 'inhome', name: 'Pat Customer 555-0101 <b>hi</b>\u0000\u0007 and more text than fits', focus: { privacy: true, script: 'x' }, phone: [{ id: 'evil' }] }, { id: 'zzz', name: 'x' }],
    },
  };
  const r = SU.parse(J(hostile));
  ok('a hostile but well-formed setup parses only what home-logic keeps', r.ok === true, J(r));
  // a mode's name is the member's own label (escaped wherever it is shown): checked on its own below
  const s = J(Object.assign({}, r.home, { acts: r.home.acts.map((a) => Object.assign({}, a, { name: '' })) }));
  ok('…no unknown key, handler, markup or URL survives', !/evil|onclick|href|https?:|<|>|extra|Hot Hail|filters|html|script|\.\.\//.test(s), s.slice(0, 300));
  ok('…unknown widgets dropped, sizes fixed, the 24 cap holds (a stack counting its cards)', HL.weight(r.home.phone) <= 24 && r.home.phone[0].s === 'm' && r.home.phone.every((it) => HL.CATALOG[it.id]), J(r.home.phone.slice(0, 4)));
  ok('…a Saved view keeps no name or filter (not an id: no setting at all)', !r.home.phone.find((it) => it.id === 'kpi').cfg);
  ok('…a stack keeps known cards only, never itself or a Saved view, 4 at most', J(r.home.phone.find((it) => it.id === 'stack').items) === J(['glance', 'daily', 'coach', 'money']));
  ok('…a desk cell is clamped onto the board', r.home.desk[0].x >= 0 && r.home.desk[0].x <= 3 && r.home.desk[0].y <= HL.DESK_MAX_Y);
  ok('…wallpaper that is not an id is dropped', !r.home.wp);
  ok('…mode names cut to 24 and control characters gone (escaped where shown)', r.home.acts[1].name.length <= 24 && !/[\u0000-\u001f]/.test(r.home.acts[1].name) && r.home.acts.length === 4 && !r.home.acts.some((a) => a.id === 'zzz'), J(r.home.acts[1]));
  ok('…and which mode is on is never taken from a paste', !('on' in r.home) && !('on' in SU.merge({}, r.home, {})));
  const max = J(HL.normalize(r.home));
  ok('…what it writes fits the os-home budget and the registry keeps it', max.length < 12000 && !!(R && R.normalizeUser({ layoutState: { 'os-home': SU.merge({}, r.home, {}) } }).layoutState['os-home']), max.length);
}

console.log('\n4. the company lock wins');
{
  const p = SU.parse(SU.exportText(HL.resolveHome({ own: MINE }), MINE));
  const own = { v: 1, desk: [{ id: 'coach', s: 'l', x: 0, y: 0, w: 2, h: 2 }] };
  const next = SU.merge(own, p.home, { phone: true, desk: false });
  ok('a locked surface keeps the member\'s own list (here: none, so the company home stays)', !('phone' in next), J(next));
  ok('…the unlocked surface, wallpaper and modes are pasted', J(next.desk) === J(HL.keep(MINE).desk) && J(next.wp) === J(MINE.wp) && next.acts.length === 4);
  const both = SU.merge(own, p.home, { phone: true, desk: true });
  ok('both locked: neither surface changes', J(both.desk) === J(HL.keep(own).desk) && !('phone' in both));
  ok('…and the preview says so', /Phone: your company set this home, so it stays as it is\./.test(J(SU.summary(p.home, { phone: true }))));
  ok('the resolved home a locked member sees is still the company\'s after the paste', (() => {
    const co = { 'os-phone': [{ id: 'upnext', s: 'l' }] };
    const r2 = HL.resolveHome({ own: SU.merge(null, p.home, { phone: true }), company: co, locked: true });
    return r2.src.phone === 'company-lock' && J(r2.phone) === J([{ id: 'upnext', s: 'l' }]);
  })());
}

(async () => {
  console.log('\n5. on the real layout: the edit bar, the preview, one save on confirm');
  {
    const T = makeWin({ surface: 'phone', loader: true, system: true, home: MINE });
    let copiedText = null;
    T.W.navigator.clipboard = { writeText: (t) => { copiedText = t; return Promise.resolve(); } };
    T.W._impl.mount({ surface: 'phone' });
    for (let i = 0; i < 4; i++) await tick();
    const reg = T.W.controls.find((c) => c.id === 'os-setup');
    ok('a Control Center tile "Copy my setup"', !!reg && reg.label === 'Copy my setup');
    reg.run();
    for (let i = 0; i < 4; i++) await tick();
    let d = T.document.querySelector('dialog.os-su');
    ok('it opens the ossetup bundle\'s native <dialog>', !!d && T.W.ScriptLoader.calls.indexOf('ossetup') !== -1 && J(T.W.ScriptLoader.bundles.ossetup) === J(['css/os/setup.css?v=1', 'js/os/setup-logic.js?v=1', 'js/os/setup.js?v=1']), T.W.ScriptLoader.calls);
    const out = d && d.querySelector('#osSuOut');
    const shown = out ? text(out) : '';
    ok('Copy shows the member\'s setup as text (readonly)', out && out.hasAttribute('readonly') && JSON.parse(shown).nbd === 'nbd-os-setup' && J(JSON.parse(shown).home.phone) === J(HL.keep(MINE).phone), shown.slice(0, 120));
    click(T.dom, d.querySelector('[data-ossu="copy"]'));
    await tick(); await tick();
    ok('Copy text puts it on the clipboard and says so', copiedText === shown && /Copied/.test(text(d.querySelector('[data-ossu-copied]'))));
    const saves0 = (T.W._saves || []).length;
    // a hostile paste: refused, nothing written
    d.querySelector('#osSuIn').value = '{"nbd":"nbd-os-setup","v":1,"home":{"phone":[{"id":"<img src=x onerror=alert(1)>"}]}}';
    click(T.dom, d.querySelector('[data-ossu="check"]'));
    ok('a hostile paste: an alert in words, no Use button, nothing saved', !!d.querySelector('.os-su-err[role="alert"]') && !d.querySelector('[data-ossu="use"]') && !d.querySelector('img') && (T.W._saves || []).length === saves0, d.querySelector('[data-ossu-preview]').innerHTML);
    // a teammate's setup
    const theirs = { v: 1, phone: [{ id: 'glance', s: 'l' }, { id: 'shortcuts', s: 's' }], desk: [{ id: 'upnext', s: 'l' }], wp: { phone: 'none', desk: 'none' } };
    d.querySelector('#osSuIn').value = SU.exportText(HL.resolveHome({ own: theirs }), theirs);
    click(T.dom, d.querySelector('[data-ossu="check"]'));
    const pv = d.querySelector('[data-ossu-preview]');
    ok('Check: a preview of what it holds, then Use this setup / Cancel', /Phone: 2 widgets \(At a Glance, Shortcuts\)/.test(text(pv)) && /Laptop: 1 widget \(Up Next\)/.test(text(pv)) && !!pv.querySelector('[data-ossu="use"]') && !!pv.querySelector('[data-ossu="cancel"]'), text(pv));
    ok('…nothing is written before Use this setup', (T.W._saves || []).length === saves0);
    click(T.dom, pv.querySelector('[data-ossu="cancel"]'));
    ok('Cancel clears the preview and writes nothing', !pv.querySelector('[data-ossu="use"]') && (T.W._saves || []).length === saves0);
    click(T.dom, d.querySelector('[data-ossu="check"]'));
    click(T.dom, d.querySelector('[data-ossu="use"]'));
    await tick();
    const w = (T.W._saves || []).slice(saves0);
    ok('Use this setup: one saveUser, os-home only (patch-only)', w.length === 1 && J(Object.keys(w[0])) === J(['layoutState']) && J(Object.keys(w[0].layoutState)) === J(['os-home']), J(w));
    const k = w[0] && w[0].layoutState['os-home'];
    ok('…the teammate\'s phone, desk and wallpaper, the member\'s own modes and mode kept', k && J(k.phone) === J(HL.keep(theirs).phone) && J(k.desk) === J(HL.keep(theirs).desk) && J(k.wp) === J(theirs.wp) && J(k.acts) === J(HL.keep(MINE).acts) && J(k.on) === J(MINE.on), J(k));
    ok('…the dialog closed, the home repainted, a toast says so', !T.document.querySelector('dialog.os-su') && T.W.toasts.some((t) => /Setup applied/.test(t.msg)), J(T.W.toasts));
    // pasting the same again: nothing to change, no write
    reg.run(); for (let i = 0; i < 3; i++) await tick();
    d = T.document.querySelector('dialog.os-su');
    d.querySelector('#osSuIn').value = SU.exportText(HL.resolveHome({ own: theirs }), theirs);
    click(T.dom, d.querySelector('[data-ossu="check"]'));
    ok('the same setup again: "already your setup", no Use button', /already your setup/.test(text(d.querySelector('[data-ossu-preview]'))) && !d.querySelector('[data-ossu="use"]'));
    click(T.dom, d.querySelector('[data-ossu="close"]'));
    ok('Close closes it', !T.document.querySelector('dialog.os-su'));
    // the phone edit bar carries the button too
    T.W.controls.find((c) => c.id === 'os-home-edit').run();
    const eb = T.document.getElementById('osPhone').querySelector('[data-osp="homesetup"]');
    ok('the phone edit bar has Copy setup', !!eb && text(eb) === 'Copy setup' && eb.getAttribute('aria-haspopup') === 'dialog');
    click(T.dom, eb);
    for (let i = 0; i < 3; i++) await tick();
    ok('…which opens the same sheet', !!T.document.querySelector('dialog.os-su'));
    click(T.dom, T.document.querySelector('dialog.os-su [data-ossu="close"]'));
  }

  {
    const T = makeWin({ surface: 'desk', loader: true, home: MINE });
    T.W._impl.mount({ surface: 'desktop' });
    for (let i = 0; i < 4; i++) await tick();
    click(T.dom, T.document.querySelector('[data-osdo="homeedit"]'));
    const db = T.document.querySelector('[data-osdo="homesetup"]');
    ok('the laptop\'s Edit Home tools have Copy my setup', !!db && text(db) === 'Copy my setup');
    click(T.dom, db);
    for (let i = 0; i < 3; i++) await tick();
    ok('…which opens the sheet', !!T.document.querySelector('dialog.os-su'));
  }

  console.log('\n6. a locked member: the paste keeps the company home');
  {
    const co = { defaultWidgets: { 'os-phone': [{ id: 'upnext', s: 'l' }] }, homeLocked: true };   // the phone published and locked, the laptop not
    const T = makeWin({ surface: 'phone', loader: true, system: true, company: co, claims: { role: 'sales_rep', companyId: 'c1' }, home: { v: 1, desk: [{ id: 'coach', s: 'm' }] } });
    T.W._impl.mount({ surface: 'phone' });
    for (let i = 0; i < 4; i++) await tick();
    T.W.controls.find((c) => c.id === 'os-setup').run();
    for (let i = 0; i < 4; i++) await tick();
    const d = T.document.querySelector('dialog.os-su');
    const theirs = { v: 1, phone: [{ id: 'glance', s: 'l' }], desk: [{ id: 'upnext', s: 'l' }], wp: { phone: 'none', desk: null } };
    d.querySelector('#osSuIn').value = SU.exportText(HL.resolveHome({ own: theirs }), theirs);
    click(T.dom, d.querySelector('[data-ossu="check"]'));
    ok('the preview says the company home stays', /Phone: your company set this home, so it stays as it is\./.test(text(d.querySelector('[data-ossu-preview]'))), text(d.querySelector('[data-ossu-preview]')));
    const n0 = (T.W._saves || []).length;
    click(T.dom, d.querySelector('[data-ossu="use"]'));
    await tick();
    const k = (T.W._saves || []).slice(n0)[0].layoutState['os-home'];
    ok('the write keeps no phone list (the locked surface), takes the laptop and wallpaper', !('phone' in k) && J(k.desk.map((x) => x.id)) === J(['upnext']) && k.wp.phone === 'none', J(k));
    const shown = T.document.getElementById('osPhone').querySelectorAll('.os-hw');
    ok('the phone still shows the company home', shown.length === 1 && shown[0].getAttribute('data-oshw') === 'upnext-1');
  }

  console.log('\n7. hygiene');
  {
    const code = noComments(SETUP_JS);
    ok('setup.js escapes every value (no raw concatenation)', /function esc\(/.test(code) && !/' \+ (?!esc\(|String\(|\(|')[a-zA-Z_.]+(?:\[[^\]]+\])? \+ '/.test(code));
    ok('no Firestore, fetch or timers of its own; the write is the layout\'s', !/\b(getDoc|getDocs|setDoc|updateDoc|onSnapshot|fetch|setInterval|setTimeout|saveUser|import\s*\()\b/.test(code + noComments(read('docs/pro/js/os/setup-logic.js'))));
    ok('no style attributes, no inline handlers, no el.style', !/style\s*=|\son[a-z]+\s*=|\.style\./.test(code));
    ok('setup.css: no text under 11px, no motion, no new hues', !/font-size:\s*(?:[0-9]|10)px/.test(SETUP_CSS) && !/transition|animation/.test(SETUP_CSS) && !/#[0-9a-f]{3,6}\b/i.test(SETUP_CSS));
    ok('the layout registers ossetup with same-origin js/os + css/os files only', /var SETUP_FILES = \['css\/os\/setup\.css\?v=1', 'js\/os\/setup-logic\.js\?v=1', 'js\/os\/setup\.js\?v=1'\];/.test(OS_JS));
    ok('the write goes through saveUser with the os-home key only (flushHome)', /function applySetup\(next\)[\s\S]{0,200}S\.homeNext = next;[\s\S]{0,40}flushHome\(\);/.test(OS_JS));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
