/**
 * tests/nbd-os-peek-2026-11-09.test.js - NBD OS P2: the pre-flight peek
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #6).
 *
 *   - home-logic peekAppt: the next timed appointment, only within 30 min of its start
 *     (and 15 min into it), never an all-day one
 *   - Up Next (and a Smart Stack showing it) carries a Peek button only then; the
 *     30 s tick shows and hides it with no data event
 *   - lazy: a tap registers and loads the runtime ScriptLoader bundle osp2peek
 *     (css/os/peek.css, os/peek-logic.js, os/peek.js); no needs.script path, no
 *     <script> tag, nothing loads on paint
 *   - the sheet (a native <dialog>): the appointment, its address, the lead's notes and
 *     its promises due, all from memory, escaped
 *   - the lead brief (functions/lead-brief.js, a paid capped callable) is called ONLY
 *     on the "Get the brief" tap, never on paint, open or tick (spy), once per lead
 *   - the sample account has a canned, honest leadBrief answer (demo-sdk)
 *   - no style attributes, no inline handlers, 44px targets, tokens only, no motion
 *
 * Run: node tests/nbd-os-peek-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, byKey, text, click, key, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const flush = () => new Promise((r) => setImmediate(r));
async function G(fn) { try { await fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } }

const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
let PL = null;
try { PL = require(path.join(ROOT, 'docs/pro/js/os/peek-logic.js')); } catch (e) { PL = null; }
const HOME_JS = read('docs/pro/js/os/home.js');
const PK_JS = read('docs/pro/js/os/peek.js');
const PKL_JS = read('docs/pro/js/os/peek-logic.js');
const PK_CSS = read('docs/pro/css/os/peek.css');

const NOW = H.NOW;   // Mon Nov 9 2026, 1:05 PM local
const MIN = 60000;
function plan(startMs, o) {
  return Object.assign({
    total: 3,
    appointments: [{ key: 'appt:1', name: 'Pat <b>Customer</b>', title: 'Inspection', leadId: 'L1', address: '12 Oak St, Cincinnati, OH 45202', timeLabel: '1:25 PM', sortMs: startMs, allDay: false }],
    promises: [{ key: 'pr:L1', leadId: 'L1', name: 'Pat Customer', promiseTasks: [{ text: 'Send the <i>gutter</i> quote', overdue: true }, { text: 'Call back with the carrier answer', overdue: false }] },
      { key: 'pr:L9', leadId: 'L9', name: 'Someone Else', promiseTasks: [{ text: 'Not this lead', overdue: true }] }],
    calls: [], promised: [], estimates: [], money: [], stalled: [],
  }, o || {});
}
const LEADS = [
  { id: 'L1', firstName: 'Pat', lastName: '<b>Customer</b>', address: '12 Oak St, Cincinnati, OH 45202', userId: 'u1', notes: 'Dog in the yard. <script>x</script> Wants the north slope looked at first.' },
  { id: 'L9', firstName: 'Someone', lastName: 'Else', userId: 'u1' },
];

function win(o) {
  o = o || {};
  const T = makeWin(Object.assign({ surface: 'phone', plan: plan(NOW + 20 * MIN), leads: LEADS, uid: 'u1',
    home: { phone: [{ id: o.id || 'upnext', s: o.size || 'm', items: o.items }], desk: [] } }, o.win || {}));
  const W = T.W;
  W.bundleLoads = [];
  W.ScriptLoader = {
    bundles: {},
    loadBundle(name) {
      W.bundleLoads.push(name);
      if (o.noFiles) return Promise.resolve();
      (this.bundles[name] || []).forEach((src) => {
        if (/\.css/.test(src)) return;
        vm.runInContext(read('docs/pro/' + src.replace(/\?.*$/, '')), W, { filename: src });
      });
      return Promise.resolve();
    },
  };
  W.briefCalls = [];
  W._functions = { fake: true };
  W._httpsCallable = function (fns, name) {
    return function (payload) {
      W.briefCalls.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
      if (o.briefFails) return Promise.reject(Object.assign(new Error('nope'), { code: 'functions/internal' }));
      return Promise.resolve({ data: { oneLine: 'Pat wants <b>speed</b>.', bullets: ['Owes nothing', '<img src=x>'], source: 'ai', generatedAtMs: NOW - 5 * MIN, cached: true } });
    };
  };
  W._impl.mount({ surface: 'phone' });
  return T;
}
const phone = (T) => T.document.getElementById('osPhone');
const dialog = (T) => T.document.querySelector('dialog.os-pk');
const setNow = (T, ms) => { const B = T.W.Date; T.W.Date = class extends B { constructor(...a) { if (a.length) super(...a); else super(ms); } static now() { return ms; } }; };

(async () => {
  console.log('\n1. home-logic peekAppt: within 30 min of the next appointment');
  await G(async () => {
    ok('peekAppt is exported', typeof HL.peekAppt === 'function');
    if (typeof HL.peekAppt !== 'function') return;
    const p = HL.peekAppt(plan(NOW + 20 * MIN), NOW);
    ok('20 min ahead -> the appointment: key, lead, name, time, minutes', !!p && p.key === 'appt:1' && p.leadId === 'L1' && p.time === '1:25 PM' && p.min === 20, J(p));
    ok('exactly 30 min ahead -> yes', !!HL.peekAppt(plan(NOW + 30 * MIN), NOW));
    ok('31 min ahead -> no', HL.peekAppt(plan(NOW + 31 * MIN), NOW) === null);
    ok('55 min ahead -> no (the Smart Stack focuses it from 60, the Peek waits for 30)', HL.peekAppt(plan(NOW + 55 * MIN), NOW) === null);
    ok('started 10 min ago -> still yes (under way)', !!HL.peekAppt(plan(NOW - 10 * MIN), NOW) && HL.peekAppt(plan(NOW - 10 * MIN), NOW).min === -10);
    ok('started 16 min ago -> no', HL.peekAppt(plan(NOW - 16 * MIN), NOW) === null);
    const two = plan(NOW + 25 * MIN);
    two.appointments.push({ key: 'appt:0', name: 'Earlier', leadId: 'L9', timeLabel: '1:15 PM', sortMs: NOW + 10 * MIN, allDay: false });
    ok('the NEXT one wins when two are close', HL.peekAppt(two, NOW).key === 'appt:0');
    const allDay = plan(NOW, { appointments: [{ key: 'job:x', name: 'All day job', allDay: true, sortMs: null }] });
    ok('an all-day job never gets a peek', HL.peekAppt(allDay, NOW) === null);
    ok('no plan / junk -> null', HL.peekAppt(null, NOW) === null && HL.peekAppt({ appointments: 'x' }, NOW) === null && HL.peekAppt(plan(NOW), NaN) === null);
  });

  console.log('\n2. peek-logic facts: memory only, the lead\'s own notes and promises');
  await G(async () => {
    ok('os/peek-logic.js exists and is require()-able', !!PL && typeof PL.facts === 'function');
    if (!PL) return;
    const f = PL.facts({ plan: plan(NOW + 20 * MIN), leads: LEADS, key: 'appt:1' });
    ok('appointment, time, title, address', f && f.name === 'Pat <b>Customer</b>' && f.time === '1:25 PM' && f.title === 'Inspection' && f.address === '12 Oak St, Cincinnati, OH 45202', J(f));
    ok('Directions is a maps link built from the address; Open customer is the customer page', f.mapsHref === 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('12 Oak St, Cincinnati, OH 45202') && f.custHref === '/pro/customer.html?id=L1');
    ok('the notes are the lead\'s own notes field', /Dog in the yard/.test(f.notes) && f.linked === true);
    ok('promises: only this lead\'s, overdue marked', J(f.promises) === J(['Send the <i>gutter</i> quote · overdue', 'Call back with the carrier answer']), J(f.promises));
    const g = PL.facts({ plan: plan(NOW + 20 * MIN, { appointments: [{ key: 'appt:2', name: 'Walk-in', address: '', timeLabel: '2 PM', sortMs: NOW }] }), leads: LEADS, key: 'appt:2' });
    ok('an appointment with no linked lead: linked false, no notes, no promises, no customer link', g && g.linked === false && g.notes === '' && g.promises.length === 0 && g.custHref === '' && g.mapsHref === '', J(g));
    ok('a key not on the plan -> null', PL.facts({ plan: plan(NOW), leads: LEADS, key: 'nope' }) === null);
    const long = PL.facts({ plan: plan(NOW), leads: [{ id: 'L1', notes: 'x'.repeat(900) }], key: 'appt:1' });
    ok('long notes are cut at 600 and marked', long.notes.length === 600 && long.notesCut === true);
    ok('brief(): the callable\'s answer made safe; junk -> null', PL.brief(null) === null && PL.brief({ oneLine: '' }) === null &&
      J(PL.brief({ oneLine: ' Hi ', bullets: ['a', 3, ''], source: 'ai', generatedAtMs: 5 })) === J({ oneLine: 'Hi', bullets: ['a'], source: 'AI summary', cached: false, at: 5 }));
    ok('a sample answer is labelled a sample', PL.brief({ oneLine: 'x', source: 'sample' }).source === 'Sample brief');
  });

  console.log('\n3. the Peek button on Up Next: only inside the window, the tick follows the clock');
  await G(async () => {
    const T = win();
    await flush();
    const w = byKey(phone(T), 'upnext-1');
    const b = w && w.querySelector('[data-oshw-peek]');
    ok('20 min before: Up Next shows one Peek button for appt:1', !!b && b.getAttribute('data-oshw-peek') === 'appt:1' && /Peek/.test(text(b)), w && w.innerHTML.slice(0, 300));
    ok('...labelled with the name and time (escaped)', b && b.getAttribute('aria-label') === 'Peek at Pat <b>Customer</b>, 1:25 PM' && !w.querySelector('b'));
    ok('...a 44px button (os-hw-btn)', b && /\bos-hw-btn\b/.test(b.className) && /\.os-hw-btn \{[^}]*min-height: 44px/.test(read('docs/pro/css/os/home.css')));
    ok('painting it loaded nothing and called nothing', T.W.bundleLoads.length === 0 && T.W.briefCalls.length === 0 && T.reads.length === 0, J([T.W.bundleLoads, T.reads]));
    const Tf = win({ win: { plan: plan(NOW + 55 * MIN) } });
    await flush();
    ok('CONTROL 55 min before: no Peek button', !byKey(phone(Tf), 'upnext-1').querySelector('[data-oshw-peek]'));
    setNow(Tf, NOW + 26 * MIN);
    Tf.fire(30000);
    ok('the tick 29 min before repaints Up Next with the button (no data event)', !!byKey(phone(Tf), 'upnext-1').querySelector('[data-oshw-peek]'));
    setNow(Tf, NOW + 71 * MIN);
    Tf.fire(30000);
    ok('the tick 16 min after the start takes it away again', !byKey(phone(Tf), 'upnext-1').querySelector('[data-oshw-peek]'));
    ok('ticking loaded nothing and called nothing', Tf.W.bundleLoads.length === 0 && Tf.W.briefCalls.length === 0);
    // inside a Smart Stack: its Up Next card carries it too
    const Ts = win({ id: 'stack', size: 'l', items: ['upnext', 'coach'] });
    Ts.W.dispatchEvent({ type: 'nbd:data-refreshed' });
    await flush();
    const st = byKey(phone(Ts), 'stack-1');
    ok('a Smart Stack showing Up Next (its appt rule) shows the Peek button', !!st && !!st.querySelector('[data-oshw-peek="appt:1"]'), st && text(st));
    // the empty branch: an appointment still under way but the plan has no other rows
    const Te = win({ win: { plan: Object.assign(plan(NOW - 5 * MIN), { promises: [] }) } });
    await flush();
    ok('the button is there with the appointment row', !!byKey(phone(Te), 'upnext-1').querySelector('[data-oshw-peek]'));
  });

  console.log('\n4. lazy: the tap loads the osp2peek bundle and opens the sheet');
  await G(async () => {
    const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
    ok('no needs.script path for it', R.get('os').needs.script.every((p) => !/peek/.test(p)));
    ok('no <script> tag on the dashboard', !/peek/.test(read('docs/pro/dashboard.html').match(/<script[^>]*>/g).join('')));
    ok('home.js registers the bundle at runtime: css/os/peek.css, peek-logic.js, then peek.js',
      /PK_BUNDLE = \['css\/os\/peek\.css\?v=\d+', 'js\/os\/peek-logic\.js\?v=\d+', 'js\/os\/peek\.js\?v=\d+'\]/.test(HOME_JS));
    const T = win();
    await flush();
    const b = byKey(phone(T), 'upnext-1').querySelector('[data-oshw-peek]');
    click(T.dom, b);
    await flush(); await flush();
    ok('one tap: the bundle loads once', J(T.W.bundleLoads) === J(['osp2peek']), J(T.W.bundleLoads));
    const d = dialog(T);
    ok('a native <dialog> opens with showModal, labelled by its title', !!d && d.modal === true && d.getAttribute('aria-labelledby') === 'osPkTitle' && !!d.querySelector('#osPkTitle'));
    const t = text(d);
    ok('it shows the appointment: name, time, title, full address', /Pat <b>Customer<\/b>/.test(t) && /1:25 PM · Inspection/.test(t) && /12 Oak St, Cincinnati, OH 45202/.test(t), t);
    ok('...Directions (new tab) and Open customer', !!d.querySelector('a[target="_blank"][rel="noopener"]') && !!d.querySelector('a[href="/pro/customer.html?id=L1"]'));
    ok('...the last notes, escaped (no <script> node)', /Dog in the yard\. <script>x<\/script>/.test(t) && !d.querySelector('script') && !d.querySelector('b'));
    ok('...the promises due on this lead only, overdue marked', /Send the <i>gutter<\/i> quote · overdue/.test(t) && /Call back with the carrier answer/.test(t) && !/Not this lead/.test(t) && !d.querySelector('i'));
    ok('...and a "Get the brief" button, with nothing called yet', !!d.querySelector('[data-pk-brief]') && T.W.briefCalls.length === 0, J(T.W.briefCalls));
    ok('focus starts on Close', T.document.activeElement === d.querySelector('[data-pk-close]'));
    ok('opening it read nothing from Firestore', T.reads.length === 0, J(T.reads));
    key(T.dom, d, 'Escape');
    ok('Escape closes it and focus goes back to the Peek button', !dialog(T) && T.document.activeElement === byKey(phone(T), 'upnext-1').querySelector('[data-oshw-peek]'));
    click(T.dom, byKey(phone(T), 'upnext-1').querySelector('[data-oshw-peek]'));
    await flush(); await flush();
    ok('a second Peek loads nothing more', T.W.bundleLoads.length === 1 && !!dialog(T));
    const Tf = win({ noFiles: true });
    await flush();
    click(Tf.dom, byKey(phone(Tf), 'upnext-1').querySelector('[data-oshw-peek]'));
    await flush(); await flush();
    ok('the files never arrive: no dialog, no throw, no brief call', !dialog(Tf) && Tf.W.briefCalls.length === 0);
  });

  console.log('\n5. the lead brief: a paid callable, only on its own tap');
  await G(async () => {
    const T = win();
    await flush();
    click(T.dom, byKey(phone(T), 'upnext-1').querySelector('[data-oshw-peek]'));
    await flush(); await flush();
    for (let i = 0; i < 3; i++) { T.fire(30000); T.W.dispatchEvent({ type: 'nbd:data-refreshed' }); }
    await flush();
    ok('ticks and data events with the sheet open: still no brief call', T.W.briefCalls.length === 0);
    click(T.dom, dialog(T).querySelector('[data-pk-brief]'));
    await flush(); await flush();
    ok('the tap calls leadBrief once with { leadId } only (no refresh, no text)', J(T.W.briefCalls) === J([{ name: 'leadBrief', payload: { leadId: 'L1' } }]), J(T.W.briefCalls));
    const t = text(dialog(T));
    ok('the answer shows: one line, bullets, source and age, escaped', /Pat wants <b>speed<\/b>\./.test(t) && /Owes nothing/.test(t) && /<img src=x>/.test(t) && /AI summary · 5 min ago · saved/.test(t) && !dialog(T).querySelector('img') && !dialog(T).querySelector('b'), t);
    key(T.dom, dialog(T), 'Escape');
    click(T.dom, byKey(phone(T), 'upnext-1').querySelector('[data-oshw-peek]'));
    await flush(); await flush();
    ok('reopened: the brief is shown from this page\'s memory, no second call', T.W.briefCalls.length === 1 && /Pat wants/.test(text(dialog(T))));
    const Te = win({ briefFails: true });
    await flush();
    click(Te.dom, byKey(phone(Te), 'upnext-1').querySelector('[data-oshw-peek]'));
    await flush(); await flush();
    click(Te.dom, dialog(Te).querySelector('[data-pk-brief]'));
    await flush(); await flush();
    ok('a failed call says so plainly with Try again; the rest of the sheet stays', /Could not build the brief/.test(text(dialog(Te))) && !!dialog(Te).querySelector('[data-pk-brief]') && /Dog in the yard/.test(text(dialog(Te))));
    const code = noComments(PK_JS);
    ok('peek.js names leadBrief only inside getBrief, reached only from the [data-pk-brief] click', (code.match(/'leadBrief'/g) || []).length === 1 &&
      /t\.closest\('\[data-pk-brief\]'\)[^;]*getBrief\(/.test(code) && (code.match(/getBrief\(/g) || []).length === 2, (code.match(/getBrief\(/g) || []).length);
    ok('home.js never calls a callable', !/httpsCallable|leadBrief/.test(noComments(HOME_JS)));
    // no linked lead: no brief button at all
    const Tn = win({ win: { plan: plan(NOW, { appointments: [{ key: 'appt:2', name: 'Walk-in', timeLabel: '1:10 PM', sortMs: NOW + 5 * MIN }] }) } });
    await flush();
    click(Tn.dom, byKey(phone(Tn), 'upnext-1').querySelector('[data-oshw-peek]'));
    await flush(); await flush();
    ok('an appointment with no CRM customer: no brief button, says why', !dialog(Tn).querySelector('[data-pk-brief]') && /No customer in the CRM is linked/.test(text(dialog(Tn))));
  });

  console.log('\n6. the sample account: a canned, honest brief');
  await G(async () => {
    const fns = read('docs/pro/demo-sdk/firebase-functions.js');
    const canned = fns.slice(fns.indexOf('const CANNED = {'), fns.indexOf('\n};', fns.indexOf('const CANNED = {')));
    ok('leadBrief is in CANNED (so the demo never refuses it with a notice)', /^\s{2}leadBrief:/m.test(canned));
    const fn = fns.slice(fns.indexOf('function sampleLeadBrief'), fns.indexOf('\n}\n', fns.indexOf('function sampleLeadBrief')));
    ok('it answers from the sample lead\'s own fields, says "Sample brief", source sample', /rawGet\('leads\/' \+ id\)/.test(fn) && /Sample brief for/.test(fn) && /source: 'sample'/.test(fn));
    ok('it invents no number (no digits in its strings beyond the slice length)', !/['"`][^'"`]*\d[^'"`]*['"`]/.test(fn.replace(/slice\(0, 240\)/, '')));
    ok('no fetch from it', !/fetch\(/.test(fn));
  });

  console.log('\n7. hygiene');
  await G(async () => {
    const code = noComments(PK_JS + PKL_JS);
    ok('no style="" and no inline handlers', !/style\s*=/.test(PK_JS + PKL_JS + PK_CSS.replace(/\/\*[\s\S]*?\*\//g, '')) && !/\son[a-z]+=/i.test(code));
    ok('no el.style string injection', !/\.style\.(cssText|setProperty)|\.style\s*=/.test(code));
    ok('no CRM write (no updateDoc / setDoc / addDoc) and no fetch', !/updateDoc|setDoc|addDoc|writeBatch|deleteDoc|\bfetch\s*\(/.test(code));
    ok('44px targets in the sheet', /\.os-pk-btn \{[^}]*min-height: 44px/.test(PK_CSS) && /\.os-pk-close \{[^}]*min-height: 44px/.test(PK_CSS));
    ok('no text under 11px and no hex colours (tokens only)', !/font-size:\s*(?:[0-9]|10)(?:\.\d+)?px/.test(PK_CSS) && !/#[0-9a-fA-F]{3,8}\b/.test(PK_CSS));
    ok('no motion of its own', !/@keyframes|animation|transition/.test(PK_CSS));
    ok('every interpolation in peek.js goes through esc() (no raw f./v./x./a. fields in markup)', !/'\s*\+\s*(?:f|v|x|a|r)\.[a-zA-Z]+\s*\+\s*'/.test(code));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
