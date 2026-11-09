/**
 * tests/nbd-os-acts-dom-2026-11-09.test.js - NBD OS P2, Activities and Focus modes on the
 * real layout (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md section 6.3).
 *
 * The fake-DOM harness (tests/lib/nbd-os-home-harness.js) runs layouts/os.js, os/home.js
 * and the osacts bundle (os/acts-logic.js, os/acts.js) over a Today plan and _leads that
 * name several customers:
 *   - lazy: no <script> tag, no needs path; home.js registers the osacts bundle at runtime
 *   - "In a home" (privacy): no other customer's name, no $ amount and no Money / Closes /
 *     Shutdown widget reaches the DOM; the current appointment's customer does. Before the
 *     bundle lands, and if it fails, the widgets show no names at all (fail closed).
 *   - Do Not Disturb follows "In a home" (on entering, off on leaving, only if it turned it on)
 *   - switching is MANUAL only: a fresh storm alert, every timer and every event switch
 *     nothing; the storm toast OFFERS Storm day once, and only its button switches. The
 *     Control Center tile, the menu and Spotlight switch; rename is escaped text.
 *   - laptop: desks 1-4 are Leads / Inspect-Claim / Build / Collect; Up Next shows the
 *     desk's phase only, switching a workspace goes to its desk (its own windows)
 *   - a privacy mode's Notification Center shows only the time-sensitive groups
 *
 * Run: node tests/nbd-os-acts-dom-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, byKey, text, click, fire, noComments, NOW } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 500) : '')); }
}
const J = (v) => JSON.stringify(v);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
async function G(fn) { try { await fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } }

const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
const SL = require(path.join(ROOT, 'docs/pro/js/os/system-logic.js'));
const HOME_JS = read('docs/pro/js/os/home.js');
const OS_JS = read('docs/pro/js/layouts/os.js');
const ACTS_JS = read('docs/pro/js/os/acts.js');
const ACTS_CSS = read('docs/pro/css/os/acts.css');

const LEADS = [
  { id: 'L1', firstName: 'Pat', lastName: 'Customer', stage: 'inspected' },
  { id: 'L2', firstName: 'Ivy', lastName: 'Inbound', stage: 'new', createdAt: NOW - 20 * 60000 },
  { id: 'L3', firstName: 'Lee', lastName: 'Three', stage: 'permit_pulled', projectedValue: 18450 },
  { id: 'L4', firstName: 'Dee', lastName: 'Four', stage: 'final_payment', projectedValue: 9200 },
];
const ROLES = { new: 'new', inspected: 'active', permit_pulled: 'job', final_payment: 'won' };
function plan() {
  const p = H.plan();
  p.money = [{ key: 'inv:L4', name: 'Dee Four', leadId: 'L4', kind: 'invoice', invoiceId: 'I1', overdue: true }];
  p.total = 6;
  return p;
}
const OTHERS = ['Lee', 'Three', 'Dee', 'Four', 'onerror', 'Ivy', 'Inbound', '555-0102', '18450', '9200'];

/** A ScriptLoader that runs a bundle's js in the window (css skipped); `hold` keeps osacts pending, `fail` rejects it. */
function loader(T, opts) {
  const o = opts || {};
  const W = T.W;
  W.bundleLoads = [];
  W.ScriptLoader = {
    bundles: {},
    loadBundle(name) {
      W.bundleLoads.push(name);
      const run = () => (this.bundles[name] || []).forEach((src) => {
        if (/\.css(\?|$)/.test(src)) return;
        const f = 'docs/pro/' + String(src).replace(/\?.*$/, '');
        vm.runInContext(read(f), W, { filename: f });
      });
      if (name === 'osacts' && o.fail) return Promise.reject(new Error('offline'));
      if (name === 'osacts' && o.hold) return new Promise((res) => { W.releaseActs = () => { run(); res(); }; });
      run();
      return Promise.resolve();
    },
  };
}
function win(o) {
  const opts = Object.assign({ surface: 'phone', plan: plan(), leads: LEADS, stageRole: (k) => ROLES[k] || 'active', nav: ['storm'] }, o || {});
  const T = makeWin(opts);
  loader(T, opts);
  const W = T.W;
  W.cmd = [];
  W.NBDCommand = { open() {}, registerAction(a) { W.cmd = W.cmd.filter((x) => x.id !== a.id).concat([a]); }, unregisterAction(id) { W.cmd = W.cmd.filter((x) => x.id !== id); } };
  W.toastObjs = [];
  W.showToast = (m, k) => { W.toastObjs.push(typeof m === 'object' ? m : { message: String(m), type: k }); };
  if (opts.system) {
    W.controls = []; W.dnd = !!opts.dndOn; W.dndCalls = [];
    W.NBDOS = {
      registerControl(def) { W.controls = W.controls.filter((c) => c.id !== def.id).concat([def]); },
      unregisterControl(id) { W.controls = W.controls.filter((c) => c.id !== id); },
      settingsTab() {}, refresh() {}, isDnd: () => W.dnd, setDnd(on) { W.dnd = on === true; W.dndCalls.push(on === true); },
    };
  }
  W._impl.mount({ surface: opts.surface });
  return T;
}
const phoneEl = (T) => T.document.getElementById('osPhone');
const deskEl = (T) => T.document.getElementById('osDesk');
const lastOn = (T) => { const s = (T.W._saves || []).filter((x) => x.layoutState && x.layoutState['os-home']); return s.length ? s[s.length - 1].layoutState['os-home'].on || null : undefined; };
const htmlOf = (el) => { let h = ''; (function walk(n) { (n.children || []).forEach((c) => { if (c.attrs) { h += ' ' + Object.keys(c.attrs).map((k) => c.attrs[k]).join(' '); walk(c); } }); })(el); return h; };
const PRIV_HOME = {
  v: 1, phone: [{ id: 'glance', s: 'm' }],
  acts: [{ id: 'inhome', name: 'In a home', focus: { privacy: true }, phone: [
    { id: 'glance', s: 'm' }, { id: 'upnext', s: 'l' }, { id: 'needsyou', s: 'm' }, { id: 'money', s: 's' }, { id: 'closes', s: 'm' }, { id: 'shutdown', s: 'm' },
    { id: 'stack', s: 'm', items: ['upnext', 'closes'] }] }],
  on: { phone: 'inhome' },
};

(async () => {
  console.log('\n1. lazy: a runtime bundle, no boot cost');
  await G(async () => {
    const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
    ok('no needs.script path for it', R.get('os').needs.script.every((p) => !/acts/.test(p)));
    ok('no <script> tag on the dashboard', !/acts/.test(read('docs/pro/dashboard.html').match(/<script[^>]*>/g).join('')));
    ok('home.js registers the osacts bundle at runtime: css/os/acts.css, acts-logic.js, then acts.js',
      /ACTS_FILES = \['css\/os\/acts\.css\?v=\d+', 'js\/os\/acts-logic\.js\?v=\d+', 'js\/os\/acts\.js\?v=\d+'\]/.test(HOME_JS));
    const T = win({ home: { v: 1, phone: [{ id: 'glance', s: 'm' }] } });
    await flush();
    ok('no mode on and no storm alert: it is never loaded', T.W.bundleLoads.indexOf('osacts') === -1 && !T.W.NBDOSActs, J(T.W.bundleLoads));
    ok('...and no chip on the phone home', !phoneEl(T).querySelector('.os-act-chip'));
    ok('...but Spotlight already lists the modes (the layout registers them)', T.W.cmd.some((a) => a.label === 'Switch to In a home'), J(T.W.cmd.map((a) => a.label)));
    const M = win({ home: PRIV_HOME });
    await flush();
    ok('a mode on: the layout loads it once at mount', M.W.bundleLoads.filter((b) => b === 'osacts').length === 1 && !!M.W.NBDOSActs, J(M.W.bundleLoads));
  });

  console.log('\n2. "In a home": no other customer, no money');
  await G(async () => {
    const T = win({ home: PRIV_HOME });
    await flush();
    const ph = phoneEl(T);
    const t = text(ph);
    ok('the chip says the mode', /In a home/.test(text(ph.querySelector('.os-act-chip'))), text(ph.querySelector('.os-act-chip')));
    ok('the current appointment\'s customer is named', t.indexOf('Pat <b>Customer</b>') !== -1, t.slice(0, 400));
    ok('no other customer\'s name, phone or dollar figure reaches the DOM text', OTHERS.every((n) => t.indexOf(n) === -1), OTHERS.filter((n) => t.indexOf(n) !== -1).join());
    ok('...nor any attribute (labels, links)', OTHERS.every((n) => htmlOf(ph).indexOf(n) === -1), OTHERS.filter((n) => htmlOf(ph).indexOf(n) !== -1).join());
    ok('no $ anywhere on the home screen', t.indexOf('$') === -1);
    ok('Money, Closes this week and Shutdown are not painted', !byKey(ph, 'money-1') && !byKey(ph, 'closes-1') && !byKey(ph, 'shutdown-1'));
    ok('Up Next, Needs you and the stack are', !!byKey(ph, 'upnext-1') && !!byKey(ph, 'needsyou-1') && !!byKey(ph, 'stack-1'));
    ok('Up Next keeps the rest of the day as neutral rows', /A call to return/.test(text(byKey(ph, 'upnext-1'))) && /A follow-up/.test(text(byKey(ph, 'upnext-1'))), text(byKey(ph, 'upnext-1')));
    ok('the stack shows no Closes card (1 of 1)', /1 of 1/.test(text(byKey(ph, 'stack-1'))), text(byKey(ph, 'stack-1')));
    ok('Needs you has no money group', !/to collect/.test(text(byKey(ph, 'needsyou-1'))), text(byKey(ph, 'needsyou-1')));
    ok('the hidden widgets stay saved in the mode', HL.activeAct(HL.normalize(T.saved()), 'phone', 0).items.some((it) => it.id === 'money'));
    T.W.dispatchEvent({ type: 'nbd:data-refreshed' });
    ok('a repaint on an event keeps it so', OTHERS.every((n) => text(ph).indexOf(n) === -1));
    ok('nothing read Firestore or called compute()', T.reads.length === 0 && T.today.computeCalls === 0, J(T.reads));
    // the control: the same widgets with the mode off name the other customers and show money
    const C = win({ home: Object.assign({}, PRIV_HOME, { phone: PRIV_HOME.acts[0].phone, on: undefined }) });
    await flush();
    const tc = text(phoneEl(C));
    ok('control: with the mode off the same home names them and paints Money and Closes', /Lee/.test(tc) && !!byKey(phoneEl(C), 'money-1') && !!byKey(phoneEl(C), 'closes-1'), tc.slice(0, 300));
  });

  console.log('\n3. fail closed: before the bundle lands, and if it cannot');
  await G(async () => {
    const T = win({ home: PRIV_HOME, hold: true });
    await flush();
    const t = text(phoneEl(T));
    ok('while it loads every widget says Loading…', /Loading…/.test(text(byKey(phoneEl(T), 'upnext-1'))), text(byKey(phoneEl(T), 'upnext-1')));
    ok('...and no customer at all is named', t.indexOf('Pat') === -1 && OTHERS.every((n) => t.indexOf(n) === -1), t.slice(0, 300));
    T.W.releaseActs();
    await flush();
    ok('then it paints through the lens', /Pat <b>Customer<\/b>/.test(text(phoneEl(T))) && OTHERS.every((n) => text(phoneEl(T)).indexOf(n) === -1));
    const F = win({ home: PRIV_HOME, fail: true });
    await flush();
    const tf = text(phoneEl(F));
    ok('a bundle that cannot load: Couldn\'t load, Retry, and no names', /Couldn't load/.test(tf) && tf.indexOf('Pat') === -1 && OTHERS.every((n) => tf.indexOf(n) === -1), tf.slice(0, 300));
  });

  console.log('\n4. Do Not Disturb follows "In a home"');
  await G(async () => {
    const T = win({ home: PRIV_HOME, system: true });
    await flush();
    ok('In a home on at mount: Do Not Disturb on', T.W.dnd === true && J(T.W.dndCalls) === J([true]), J(T.W.dndCalls));
    T.W.NBDOSActs.switchTo('office');
    ok('leaving it turns Do Not Disturb back off', T.W.dnd === false && J(T.W.dndCalls) === J([true, false]), J(T.W.dndCalls));
    const D = win({ home: PRIV_HOME, system: true, dndOn: true });
    await flush();
    D.W.NBDOSActs.switchTo(null);
    ok('Do Not Disturb the member had on stays on', D.W.dnd === true && D.W.dndCalls.length === 0, J(D.W.dndCalls));
  });

  console.log('\n5. switching is manual only');
  await G(async () => {
    const storm = J({ ts: NOW - 5 * 60000, data: [{ event: 'Hail <Warning>' }] });
    const T = win({ home: { v: 1, phone: [{ id: 'glance', s: 'm' }] }, store: { nbd_storm_alerts_cache: storm }, system: true });
    await flush();
    for (let i = 0; i < 3; i++) {
      T.timers.forEach((x) => { if (x.fn) { const f = x.fn; if (x.kind === 't') x.fn = null; f(); } });
      ['storage', 'nbd:data-refreshed', 'nbd:os-unlock', 'online', 'nbd:today-rendered'].forEach((type) => T.W.dispatchEvent({ type, key: 'nbd_storm_alerts_cache' }));
      await flush();
    }
    ok('a fresh storm alert, every timer and every event: no mode is switched on', HL.activeAct(HL.normalize(T.saved() || {}), 'phone', 0) === null && !(lastOn(T) || {}).phone, J(lastOn(T)));
    const offers = T.W.toastObjs.filter((x) => x && typeof x.undoAction === 'function');
    ok('the storm OFFERS Storm day once, in a toast with one button', offers.length === 1 && /Switch to Storm day/.test(offers[0].undoText) && /Hail <Warning>/.test(offers[0].message), J(T.W.toastObjs));
    offers[0].undoAction();
    await flush();
    ok('the toast\'s button is what switches', J(lastOn(T)) === J({ phone: 'storm', desk: null }), J(lastOn(T)));
    ok('...and the phone shows Storm day\'s own widgets', !!byKey(phoneEl(T), 'storm-1') && /Storm day/.test(text(phoneEl(T).querySelector('.os-act-chip'))));
    const src = noComments(ACTS_JS);
    // acts.js: its definition, the host call inside it, the menu pick and the toast button: nothing else
    ok('acts.js calls switchTo only from the menu and the toast button', (src.match(/switchTo\(/g) || []).length === 4, (src.match(/[^\n]*switchTo\([^\n]*/g) || []).join('\n'));
    ok('its one timer waits for the system layer (Do Not Disturb); no interval',
      (src.match(/setTimeout\(/g) || []).length === 1 && /setTimeout\(waitSystem, 1500\)/.test(src) && !/setInterval\(/.test(src));
    // os.js: its definition, the host it hands acts.js, and Spotlight's run
    const os = noComments(OS_JS);
    ok('layouts/os.js switches only from the host it hands the menu and Spotlight\'s run', (os.match(/switchAct\b/g) || []).length === 3 && /run: function \(\) \{ switchAct\(m\.id\); \}/.test(os),
      (os.match(/[^\n]*switchAct\b[^\n]*/g) || []).join('\n'));
  });

  console.log('\n6. Control Center, the menu, Spotlight, rename');
  await G(async () => {
    const T = win({ home: { v: 1, phone: [{ id: 'glance', s: 'm' }] }, system: true });
    await flush();
    const tile = T.W.controls.filter((c) => c.id === 'os-acts')[0];
    ok('a Control Center tile "Mode", hint Off', !!tile && tile.label === 'Mode' && tile.hint() === 'Off', J(T.W.controls.map((c) => c.id)));
    tile.run();
    await flush();
    const d = T.document.querySelector('dialog.os-acts');
    ok('it opens the menu: four modes and Off', !!d && d.open && d.querySelectorAll('.os-acts-pick').length === 5, d && text(d));
    ok('In a home says what it hides', /Hides money and other customers' names/.test(text(d)));
    click(T.dom, d.querySelector('[data-osacts="pick"][data-id="canvass"]'));
    ok('picking Canvassing switches and closes', J(lastOn(T)) === J({ phone: 'canvass', desk: null }) && !d.open, J(lastOn(T)));
    ok('the tile\'s hint follows', tile.hint() === 'Canvassing');
    const labels = T.W.cmd.map((a) => a.label);
    ok('Spotlight: Switch to each mode, and Turn mode off', ['Switch to Canvassing', 'Switch to In a home', 'Switch to Storm day', 'Switch to Office', 'Turn mode off'].every((l) => labels.indexOf(l) !== -1), J(labels));
    T.W.cmd.filter((a) => a.id === 'os:act:inhome')[0].run();
    await flush();
    ok('a Spotlight action switches', J(lastOn(T)) === J({ phone: 'inhome', desk: null }));
    click(T.dom, phoneEl(T).querySelector('.os-act-chip'));
    await flush();
    ok('the chip opens the menu too', d.open);
    const esc = H.key(T.dom, d.querySelector('.os-acts-pick'), 'Escape');
    ok('Escape closes it itself (whatever else listens for Escape), focus back on the chip',
      !d.open && esc.defaultPrevented && T.document.activeElement === phoneEl(T).querySelector('.os-act-chip'), String(T.document.activeElement && T.document.activeElement.className));
    click(T.dom, phoneEl(T).querySelector('.os-act-chip'));
    await flush();
    click(T.dom, d.querySelector('[data-osacts="rename"][data-id="inhome"]'));
    const input = d.querySelector('.os-acts-input');
    ok('Rename shows a labelled field, 24 characters at most', !!input && input.getAttribute('maxlength') === '24');
    input.value = '<img src=x onerror=alert(1)>';
    fire(T.dom, d.querySelector('.os-acts-form'), 'submit');
    await flush();
    const saved = HL.normalize(T.saved());
    ok('the name is saved as text', saved.acts[1].name === '<img src=x onerror=alert(1)>'.slice(0, 24), J(saved.acts[1]));
    ok('...shown escaped (no element made from it)', !phoneEl(T).querySelector('img') && !d.querySelector('img') && /<img src=x/.test(text(phoneEl(T).querySelector('.os-act-chip'))));
    ok('...and Spotlight follows the new name', T.W.cmd.some((a) => a.label === 'Switch to ' + saved.acts[1].name));
    click(T.dom, d.querySelector('[data-osacts="pick"][data-id=""]'));
    ok('Off turns the mode off', !lastOn(T) || !lastOn(T).phone);
    T.W._impl.unmount();
    ok('unmount takes the tile and the Spotlight actions down', !T.W.controls.some((c) => c.id === 'os-acts') && !T.W.cmd.some((a) => /^os:act:/.test(a.id)));
  });

  console.log('\n7. laptop: desks are job-phase workspaces');
  await G(async () => {
    const T = win({ surface: 'desk', home: { v: 1, desk: [{ id: 'upnext', s: 'l', x: 0, y: 0, w: 2, h: 2 }], on: { desk: 'canvass' } } });
    await flush();
    const dk = deskEl(T);
    const btn = dk.querySelector('.os-act-task');
    ok('the taskbar names the workspace: Leads on desk 1', text(btn) === 'Leads' && /desk 1/.test(btn.getAttribute('aria-label')), text(btn));
    const up = () => text(byKey(dk, 'upnext-1'));
    ok('Leads: Up Next shows the new lead\'s call only', /Missed call/.test(up()) && !/Pat/.test(up()) && !/Lee/.test(up()) && !/Dee/.test(up()), up());
    click(T.dom, dk.querySelector('[data-osdesk="2"]'));
    ok('desk 3 is Build: its work only', text(btn) === 'Build' && /Lee "Q" Three/.test(up()) && !/Pat/.test(up()), up());
    T.W.cmd.filter((a) => a.id === 'os:act:office')[0].run();
    await flush();
    ok('"Switch to Collect workspace" goes to desk 4', T.W.NBDOSLayout.state().desk === 3 && text(btn) === 'Collect' && /Dee Four/.test(up()), up());
    ok('...and Collect shows money (no privacy on the laptop)', /Money to collect|Past due/.test(up()) || /Dee Four/.test(up()));
    T.W.cmd.filter((a) => a.id === 'os:act:off')[0].run();
    await flush();
    ok('workspaces off: the whole day on every desk', text(btn) === 'Workspaces' && /Pat/.test(up()), up());
    ok('the saved workspaces state is off', !lastOn(T) || !lastOn(T).desk);
  });

  console.log('\n8. Notification Center in a privacy mode');
  await G(async () => {
    const g = SL.groupNotifications([{ id: 'a', type: 'overdue-task', title: 'Call Lee' }, { id: 'b', type: 'stale-lead', title: 'Dee Four' }, { id: 'c', server: true, title: 'Ivy replied' }]);
    const p = SL.privateGroups(g);
    ok('only the time-sensitive group (Tasks) shows; the rest is a count', J(p.shown.map((x) => x.id)) === J(['tasks']) && p.held === 2, J(p));
    const SYS = read('docs/pro/js/os/system.js');
    ok('system.js asks the mode and hides the message history in it', /A\.privacy\(\)/.test(SYS) && /state\.history\.length && !pg/.test(SYS));
  });

  console.log('\n8b. the real Notification Center in "In a home": a task row names no customer');
  await G(async () => {
    // the bell's task rows as notif-bell.js builds them: { title, text: '"<task text>"', sub: leadName(lead) }
    const ITEMS = [
      { id: 'task:L3:t1', leadId: 'L3', type: 'overdue-task', title: 'Overdue task', text: '"Call Lee about the insurance check"', sub: 'Lee Three', ts: NOW - 3600000 },
      { id: 'task:L4:t2', leadId: 'L4', type: 'task-today', title: 'Task due today', text: '"Collect $9200 from Dee"', sub: 'Dee Four', ts: NOW - 600000 },
      { id: 'stale:L2', leadId: 'L2', type: 'stale-lead', title: 'Ivy Inbound', sub: 'No contact in 9 days', ts: NOW - 7200000 },
    ];
    const boot = (home) => {
      const T = win({ home });
      T.W.NotifBell = { items: () => ITEMS.slice(), getCount: () => ITEMS.length };
      vm.runInContext(read('docs/pro/js/os/system.js'), T.W, { filename: 'docs/pro/js/os/system.js' });
      return T;
    };
    const T = boot(PRIV_HOME);
    await flush();
    ok('"In a home" is on (the bundle answers privacy)', !!T.W.NBDOSActs && T.W.NBDOSActs.privacy() === true);
    T.W.NBDOS.open('notifs');
    const body = T.document.getElementById('osSheetBody');
    const t = text(body);
    ok('the Tasks group shows (it is time-sensitive)', /Overdue task/.test(t) && /Task due today/.test(t), t.slice(0, 300));
    ok('no other customer\'s name, task text or $ reaches the rendered rows', OTHERS.concat(['insurance', '$']).every((n) => t.indexOf(n) === -1),
      OTHERS.concat(['insurance', '$']).filter((n) => t.indexOf(n) !== -1).join() + ' :: ' + t.slice(0, 300));
    ok('...nor any attribute', OTHERS.every((n) => htmlOf(body).indexOf(n) === -1), OTHERS.filter((n) => htmlOf(body).indexOf(n) !== -1).join());
    ok('the held count says what waits', /1 more waits until you leave it/.test(t), t.slice(0, 300));
    ok('no Mark all read or Clear all: they would act on the groups it hides',
      !body.querySelector('[data-key="readall"]') && !body.querySelector('[data-key="clearall"]'), t.slice(0, 120));
    // the control: with the mode off the same rows name the customer and the task
    const C = boot(Object.assign({}, PRIV_HOME, { on: undefined }));
    await flush();
    C.W.NBDOS.open('notifs');
    const tc = text(C.document.getElementById('osSheetBody'));
    ok('control: with the mode off the rows name the customer and the task', /Lee Three/.test(tc) && /insurance check/.test(tc), tc.slice(0, 300));
    ok('control: with the mode off Mark all read and Clear all are there', !!C.document.getElementById('osSheetBody').querySelector('[data-key="clearall"]'));
  });

  console.log('\n9. CSS and markup floors');
  await G(async () => {
    const css = ACTS_CSS + read('docs/pro/css/os/home.css').split('Activities and Focus modes')[1];
    ok('no style attribute in the new code', !/style=/.test(noComments(ACTS_JS)) && !/\.style\./.test(noComments(ACTS_JS)));
    const px = (css.match(/font-size:\s*(?:var\([^,]+,\s*)?(\d+)px/g) || []).map((m) => Number(/(\d+)px/.exec(m)[1]));
    ok('no text under 11px', px.length > 0 && px.every((n) => n >= 11), J(px));
    ok('buttons are 44px targets', /\.os-acts-btn \{[^}]*min-height: 44px/.test(css) && /\.os-act-chip \{[^}]*min-height: 44px/.test(css) && /\.os-acts-pick \{[^}]*min-height: 56px/.test(css));
    ok('no motion (no transition or animation)', !/transition|animation/.test(css));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
