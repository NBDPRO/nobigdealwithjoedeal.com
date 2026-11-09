/**
 * tests/nbd-os-shutdown-sheet-2026-11-09.test.js - NBD OS P1: the Shutdown widget
 * and sheet in the fake-DOM harness (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6.2).
 *
 *   - the catalog entry (S / M / L, read cost 0 on paint, nav crm)
 *   - loaded lazily: os/home.js registers the runtime ScriptLoader bundle `osshutdown`
 *     the first time the widget paints; no needs.script path, no <script> tag, no
 *     boot-loaded file changed
 *   - quiet outside 4 PM - 8 PM: no number; inside, counts from _leads and the plan
 *   - the sheet is a native <dialog> (showModal) listing the rows
 *   - one tap per row: the REAL followup-deck.js setFollowUp (spied), the field and
 *     the date it writes, the undo it returns is reachable in the sheet and on the toast
 *   - "Loop closed: N leads, N visits" from counts; visits unread -> not said
 *   - the carry-over in localStorage nbd_os_carry, ids only
 *   - Attach visit opens the recorder's Unfiled sheet; promises Open the record
 *   - a viewer gets Open only; escaped names; no style attributes, 44px targets
 *
 * Run: node tests/nbd-os-shutdown-sheet-2026-11-09.test.js
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
const NNS = require(path.join(ROOT, 'docs/pro/js/no-next-step.js'));
const HOME_JS = read('docs/pro/js/os/home.js');
const SD_JS = read('docs/pro/js/os/shutdown.js');
const SDL_JS = read('docs/pro/js/os/shutdown-logic.js');
const SD_CSS = read('docs/pro/css/os/shutdown.css');

const EVENING = new Date(2026, 10, 9, 17, 30).getTime();   // Mon Nov 9 2026, 5:30 PM local
const NOON = new Date(2026, 10, 9, 12, 0).getTime();
const TEN = new Date(2026, 10, 9, 10, 0).getTime();
const UID = 'u1';
function leads() {
  return [
    { id: 'A', firstName: 'Ann', lastName: '<b>Able</b>', address: '1 Oak St, Town, OH', stage: 'contacted', userId: UID, lastContactedAt: TEN, lastContactType: 'call' },
    { id: 'B', firstName: 'Bo', lastName: 'Best', address: '2 Elm St, Town, OH', stage: 'new', userId: UID, lastOutboundAt: TEN + 60000 },
    { id: 'C', firstName: 'Cy', lastName: 'Team', stage: 'contacted', userId: 'rep2', lastContactedAt: TEN },          // a teammate's
    { id: 'D', firstName: 'Di', lastName: 'Done', stage: 'contacted', userId: UID, lastContactedAt: TEN, followUp: '2026-11-12' },   // closed
    { id: 'E', firstName: 'Ed', lastName: 'Stamp', stage: 'contacted', userId: UID, updatedAt: TEN },                // a server stamp only
    { id: 'P', firstName: 'Pat', lastName: 'Promise', stage: 'contacted', userId: UID },                              // the promise's lead (own, not touched today)
  ];
}
const PLAN = { total: 1, appointments: [], calls: [], promised: [], estimates: [], money: [], stalled: [],
  promises: [{ key: 'pr:P', leadId: 'P', name: 'Pat Promise', missTotal: 2, promiseTasks: [{ overdue: true }] }] };

/** A window with the OS home, a ScriptLoader that runs the real bundle files, the real followup-deck.js, and a recorder stub. */
function win(o) {
  o = o || {};
  const T = makeWin(Object.assign({ surface: 'phone', now: EVENING, plan: PLAN, leads: leads(), uid: UID,
    home: { phone: [{ id: 'shutdown', s: o.size || 'm' }], desk: [] } }, o.win || {}));
  const W = T.W;
  if (!o.noNns) W.NBDNoNextStep = { _pure: NNS };
  W._taskCache = {};
  W.serverTimestamp = () => ({ __server: true });
  W.writes = [];
  W.updateDoc = (ref, patch) => { W.writes.push({ ref, patch }); return o.writeFails ? Promise.reject(new Error('offline')) : Promise.resolve(); };
  W.doc = (db, col, id) => col + '/' + id;
  W.toasts = [];
  W.showToast = (m, t) => { W.toasts.push(typeof m === 'object' ? m : { message: m, type: t }); };
  vm.runInContext(read('docs/pro/js/followup-deck.js'), W, { filename: 'followup-deck.js' });
  const real = W.NBDFollowUpDeck.setFollowUp;
  W.setFollowUpCalls = [];
  W.NBDFollowUpDeck.setFollowUp = function (lead, val) { W.setFollowUpCalls.push([lead.id, val]); return real(lead, val); };
  W.bundleLoads = [];
  W.ScriptLoader = {
    bundles: {},
    loadBundle(name) {
      W.bundleLoads.push(name);
      (this.bundles[name] || []).forEach((src) => {
        if (/\.css/.test(src)) return;
        vm.runInContext(read('docs/pro/' + src.replace(/\?.*$/, '')), W, { filename: src });
      });
      return Promise.resolve();
    },
  };
  W.unfiledOpened = 0;
  W.NBDVisitRecorderLauncher = { openUnfiled() { W.unfiledOpened++; } };
  if (o.visits !== null) {
    W.NBDVisitRecorder = { listAll: () => Promise.resolve({ local: o.visits || [
      { id: 'v1', startedAtMs: TEN + 2 * 3600000, status: 'uploaded' },
      { id: 'v2', startedAtMs: TEN, status: 'uploaded', leadId: 'A' },
    ], remote: [], remoteOk: o.remoteOk === undefined ? true : o.remoteOk }) };
  }
  W._impl.mount({ surface: 'phone' });
  return T;
}
const phone = (T) => T.document.getElementById('osPhone');
const widgetOf = (T) => byKey(phone(T), 'shutdown-1');
const dialog = (T) => T.document.querySelector('dialog.os-sd');

(async () => {
  console.log('\n1. catalog and lazy loading');
  await G(async () => {
    const c = HL.CATALOG.shutdown;
    ok('Shutdown is in the catalog: S, M and L, default M, read cost 0 on paint, nav crm',
      !!c && J(c.sizes) === J(['s', 'm', 'l']) && c.def === 'm' && c.reads === 0 && c.nav === 'crm' && c.bundle === 'osshutdown', J(c));
    // a tap runs NBDVisitRecorder.listAll: one visit_captures query, limit 40, so up to 40 billed doc reads
    const vr = read('docs/pro/js/visit-recorder.js');
    const lim = /collection\(window\.db, 'users', u, 'visit_captures'\)[^;]*window\.limit\((\d+)\)/.exec(vr);
    ok('...and its tap cost is the billed worst case, listAll\'s visit_captures limit (one query, up to N doc reads)',
      !!lim && c.tapReads === Number(lim[1]), J([c.tapReads, lim && lim[1]]));
    ok('it survives normalize (a saved home keeps it)', J(HL.normalize({ phone: [{ id: 'shutdown', s: 'l' }] }).phone) === J([{ id: 'shutdown', s: 'l' }]));
    const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
    ok('no needs.script path for it (the last free slot is board-logic\'s)', R.get('os').needs.script.every((p) => !/shutdown/.test(p)));
    const dash = read('docs/pro/dashboard.html');
    ok('no <script> tag on the dashboard', !/shutdown/.test(dash.match(/<script[^>]*>/g).join('')));
    ok('home.js registers the bundle at runtime: css/os/shutdown.css, shutdown-logic.js, then shutdown.js',
      /SD_BUNDLE = \['css\/os\/shutdown\.css\?v=\d+', 'js\/os\/shutdown-logic\.js\?v=\d+', 'js\/os\/shutdown\.js\?v=\d+'\]/.test(HOME_JS));
    const T = win();
    await flush();
    ok('the first paint of the widget asks for the bundle once', J(T.W.bundleLoads) === J(['osshutdown']), J(T.W.bundleLoads));
    ok('then the widget paints from os/shutdown.js', !!T.W.NBDOSShutdown && /Shutdown/.test(text(widgetOf(T))) && !/Getting ready/.test(text(widgetOf(T))), text(widgetOf(T)));
    T.W.dispatchEvent({ type: 'nbd:data-refreshed' });
    ok('later paints load nothing more', T.W.bundleLoads.length === 1);
    const T0 = makeWin({ surface: 'phone', home: { phone: [{ id: 'glance', s: 'm' }], desk: [] } });
    T0.W.bundleLoads = [];
    T0.W.ScriptLoader = { bundles: {}, loadBundle(n) { T0.W.bundleLoads.push(n); return Promise.resolve(); } };
    T0.W._impl.mount({ surface: 'phone' });
    ok('a home without the widget never loads it', T0.W.bundleLoads.length === 0);
    const Tf = makeWin({ surface: 'phone', now: EVENING, home: { phone: [{ id: 'shutdown', s: 'm' }], desk: [] } });
    Tf.W.ScriptLoader = { bundles: {}, loadBundle() { return Promise.resolve(); } };   // the files never arrive
    Tf.W._impl.mount({ surface: 'phone' });
    await flush();
    const wf = byKey(Tf.document.getElementById('osPhone'), 'shutdown-1');
    ok('a failed load shows Couldn\'t load · Retry, and no loop of loads', /Couldn't load/.test(text(wf)) && !!wf.querySelector('[data-oshw-retry="sd"]'));
    ok('every read on paint is 0 (no Firestore, no fetch)', T.reads.length === 0, J(T.reads));
  });

  console.log('\n2. the widget: quiet outside 4 PM - 8 PM, counts inside');
  await G(async () => {
    const Tq = win({ win: { now: NOON } });
    await flush();
    const wq = text(widgetOf(Tq));
    ok('at noon: no number, a quiet "Close out now"', !/\d/.test(wq.replace(/4 PM/, '')) && /Close out now/.test(wq), wq);
    ok('at noon: no filled button, no badge', !widgetOf(Tq).querySelector('.btn-orange') && !widgetOf(Tq).querySelector('.os-visit-badge, [class*="badge"]'));
    const T = win();
    await flush();
    const w = text(widgetOf(T));
    ok('at 5:30 PM (M): 2 own leads with no next step and 1 promise past due (teammate and server-stamped leads not counted)',
      /2 leads with no next step · 1 promise past due/.test(w), w);
    ok('M has one button to the sheet', widgetOf(T).querySelectorAll('[data-oshw-sd]').length === 1);
    // the widget follows the clock across 4 PM and 8 PM on home.js's 30 s tick, with no data event
    const setNow = (TT, ms) => { const B = TT.W.Date; TT.W.Date = class extends B { constructor(...a) { if (a.length) super(...a); else super(ms); } static now() { return ms; } }; };
    const Tc = win({ win: { now: new Date(2026, 10, 9, 15, 59, 50).getTime() } });
    await flush();
    ok('CONTROL 3:59 PM: quiet', /Close out now/.test(text(widgetOf(Tc))) && !/with no next step/.test(text(widgetOf(Tc))));
    setNow(Tc, new Date(2026, 10, 9, 16, 0, 20).getTime());
    Tc.fire(30000);
    ok('the tick after 4 PM repaints it: the count shows', /2 leads with no next step/.test(text(widgetOf(Tc))), text(widgetOf(Tc)));
    setNow(Tc, new Date(2026, 10, 9, 20, 0, 10).getTime());
    Tc.fire(30000);
    ok('the tick after 8 PM repaints it: quiet again, no count', /Close out now/.test(text(widgetOf(Tc))) && !/with no next step/.test(text(widgetOf(Tc))), text(widgetOf(Tc)));
    // the same inside a Smart Stack showing the Shutdown card: the tick repaints the card, never re-picks
    const Tk = win({ win: { now: new Date(2026, 10, 9, 15, 59, 50).getTime(), home: { phone: [{ id: 'stack', s: 'l', items: ['shutdown'] }], desk: [] } } });
    await flush();
    const stackOf = () => byKey(phone(Tk), 'stack-1');
    ok('CONTROL stack at 3:59 PM: the Shutdown card is quiet', !!stackOf() && /Close out now/.test(text(stackOf())) && !/with no next step/.test(text(stackOf())), stackOf() && text(stackOf()));
    setNow(Tk, new Date(2026, 10, 9, 16, 0, 20).getTime());
    Tk.fire(30000);
    ok('the tick after 4 PM repaints the Shutdown card inside a stack: the count shows', /2 leads with no next step/.test(text(stackOf())), text(stackOf()));
    setNow(Tk, new Date(2026, 10, 9, 20, 0, 10).getTime());
    Tk.fire(30000);
    ok('...and after 8 PM it goes quiet again', /Close out now/.test(text(stackOf())) && !/with no next step/.test(text(stackOf())), text(stackOf()));
    const Ts = win({ size: 's' });
    await flush();
    ok('S: the one number, from the same count (3 to close)', /3\s*to close/.test(text(widgetOf(Ts))), text(widgetOf(Ts)));
    const Tl = win({ size: 'l' });
    await flush();
    const rows = widgetOf(Tl).querySelectorAll('.os-hw-row');
    ok('L: up to 3 names, each opening the sheet', rows.length === 3 && rows.every((r) => r.hasAttribute('data-oshw-sd')), rows.length);
    ok('L: names escaped (the <b> stays text)', /Ann <b>Able<\/b>/.test(text(widgetOf(Tl))) && !widgetOf(Tl).querySelector('b'));
    const Tn = win({ win: { leads: [] }, size: 'm' });
    T.W._leadsLoaded = true;
    await flush();
    const T2 = win({ win: { leadsLoaded: false } });
    await flush();
    ok('leads not loaded yet -> no number', /Getting your day ready/.test(text(widgetOf(T2))) && !/\d/.test(text(widgetOf(T2))), text(widgetOf(T2)));
    ok('nothing open -> a plain line, no number', /Every lead you touched today has a next step/.test(text(widgetOf(Tn))) || /1 promise past due/.test(text(widgetOf(Tn))), text(widgetOf(Tn)));
  });

  console.log('\n3. the sheet: a native <dialog> with the rows');
  await G(async () => {
    const T = win();
    await flush();
    click(T.dom, widgetOf(T).querySelector('[data-oshw-sd]'));
    await flush(); await flush();
    const d = dialog(T);
    ok('a tap opens a native <dialog> with showModal', !!d && d.modal === true && d.open === true);
    ok('it is labelled by its title', d && d.getAttribute('aria-labelledby') === 'osSdTitle' && !!d.querySelector('#osSdTitle'));
    const rows = d.querySelectorAll('[data-sd-row]').map((r) => r.getAttribute('data-sd-row'));
    ok('rows: own leads A and B, today\'s unfiled visit v1, the promise P; not the teammate\'s, the closed or the server-stamped lead',
      J(rows.slice().sort()) === J(['lead:A', 'lead:B', 'promise:P', 'visit:v1']), J(rows));
    const a = d.querySelector('[data-sd-row="lead:A"]');
    ok('a lead row: Tomorrow, +3 days, +1 week, and Open (the customer page)',
      J(a.querySelectorAll('[data-sd-fu]').map((b) => b.getAttribute('data-sd-fu'))) === J(['1', '3', '7']) &&
      a.querySelector('a').getAttribute('href') === '/pro/customer.html?id=A');
    ok('it says what the touch was', /Called today/.test(text(a)));
    ok('a visit row: Attach visit', !!d.querySelector('[data-sd-row="visit:v1"] [data-sd-attach]'));
    ok('a promise row: Open, with its miss count', /missed 2 times/.test(text(d.querySelector('[data-sd-row="promise:P"]'))) && !!d.querySelector('[data-sd-row="promise:P"] a[href="/pro/customer.html?id=P"]'));
    ok('ends with "Loop closed: 1 lead, 1 visit" (D has a next step; v2 is filed)', /Loop closed: 1 lead, 1 visit · 4 still open/.test(text(d.querySelector('.os-sd-closed'))), text(d.querySelector('.os-sd-closed')));
    ok('focus starts on the first row\'s first button', T.document.activeElement === d.querySelector('[data-sd-fu]'));
    const c = JSON.parse(T.store.nbd_os_carry || 'null');
    ok('the carry-over is stored device-only: ids only, this uid, today', c && c.uid === UID && c.dk === '2026-11-09' &&
      J(c.leads.slice().sort()) === J(['A', 'B']) && J(c.visits) === J(['v1']) && J(c.promises) === J(['P']) && !/Ann|Oak|Pat/.test(T.store.nbd_os_carry), T.store.nbd_os_carry);
    ok('opening the sheet read visits once and Firestore not at all', T.reads.length === 0, J(T.reads));
    click(T.dom, d.querySelector('[data-sd-attach]'));
    ok('Attach visit closes the sheet and opens the recorder\'s Unfiled sheet', T.W.unfiledOpened === 1 && !dialog(T));
    const T2 = win();
    await flush();
    click(T2.dom, widgetOf(T2).querySelector('[data-oshw-sd]'));
    await flush();
    key(T2.dom, dialog(T2), 'Escape');
    ok('Escape closes it and focus goes back to the widget button', !dialog(T2) && T2.document.activeElement === widgetOf(T2).querySelector('[data-oshw-sd]'));
  });

  console.log('\n4. one tap: the existing follow-up writer, with undo');
  await G(async () => {
    const T = win();
    await flush();
    click(T.dom, widgetOf(T).querySelector('[data-oshw-sd]'));
    await flush(); await flush();
    const before = T.W.writes.length;
    click(T.dom, dialog(T).querySelector('[data-sd-row="lead:A"] [data-sd-fu="3"]'));
    await flush(); await flush();
    ok('the call goes through followup-deck.js setFollowUp (the existing writer), Mon + 3 days', J(T.W.setFollowUpCalls) === J([['A', '2026-11-12']]), J(T.W.setFollowUpCalls));
    const w = T.W.writes.slice(before);
    ok('it writes only followUp + updatedAt on leads/A (one write)', w.length === 1 && w[0].ref === 'leads/A' && J(Object.keys(w[0].patch).sort()) === J(['followUp', 'updatedAt']) && w[0].patch.followUp === '2026-11-12', J(w));
    ok('the row leaves the list and the loop count goes up', !dialog(T).querySelector('[data-sd-row="lead:A"]') && /Loop closed: 2 leads, 1 visit · 3 still open/.test(text(dialog(T).querySelector('.os-sd-closed'))));
    ok('the house toast carries Undo', T.W.toasts.length === 1 && T.W.toasts[0].undoText === 'Undo' && typeof T.W.toasts[0].undoAction === 'function' && /Follow up with Ann <b>Able<\/b>/.test(T.W.toasts[0].message), J(T.W.toasts));
    const u = dialog(T).querySelector('[data-sd-undo]');
    ok('and Undo is in the sheet too (the modal sheet sits over the toast), with focus on it', !!u && T.document.activeElement === u);
    ok('the home widget repainted from the same data (1 lead left)', /1 lead with no next step/.test(text(widgetOf(T))), text(widgetOf(T)));
    const st = dialog(T).querySelector('[role="status"]');
    ok('the Undo line is a role=status node', !!st && /Follow up with Ann/.test(text(st)) && st.contains(u));
    T.W.dispatchEvent({ type: 'nbd:data-refreshed' });
    await flush();
    ok('a repaint (data refresh) keeps the same status node and its text: no re-announcement',
      dialog(T).querySelector('[role="status"]') === st && /Follow up with Ann/.test(text(st)) && st.querySelector('[data-sd-undo]') === u);
    click(T.dom, u);
    await flush(); await flush();
    const w2 = T.W.writes.slice(before);
    ok('Undo puts the previous follow-up back through the writer\'s own undo', w2.length === 2 && w2[1].ref === 'leads/A' && w2[1].patch.followUp === '', J(w2));
    ok('after Undo the status node is the same node, emptied and hidden', dialog(T).querySelector('[role="status"]') === st && st.hasAttribute('hidden') && !text(st));
    ok('the row is back and the count is back', !!dialog(T).querySelector('[data-sd-row="lead:A"]') && /Loop closed: 1 lead, 1 visit/.test(text(dialog(T).querySelector('.os-sd-closed'))));
    T.W.toasts[0].undoAction();
    await flush();
    ok('a second Undo (the toast\'s) writes nothing more', T.W.writes.slice(before).length === 2);
    const Tf = win({ writeFails: true });
    await flush();
    click(Tf.dom, widgetOf(Tf).querySelector('[data-oshw-sd]'));
    await flush(); await flush();
    click(Tf.dom, dialog(Tf).querySelector('[data-sd-row="lead:B"] [data-sd-fu="1"]'));
    await flush(); await flush();
    ok('a failed write keeps the row, says so, and counts nothing closed', !!dialog(Tf).querySelector('[data-sd-row="lead:B"]') &&
      Tf.W.toasts.some((t) => t.type === 'error' && /Couldn't set the follow-up/.test(t.message)) && /Loop closed: 1 lead/.test(text(dialog(Tf).querySelector('.os-sd-closed'))));
  });

  console.log('\n5. visits not readable, viewers, safety');
  await G(async () => {
    const T = win({ visits: null });
    await flush();
    click(T.dom, widgetOf(T).querySelector('[data-oshw-sd]'));
    await flush(); await flush();
    const line = text(dialog(T).querySelector('.os-sd-closed'));
    ok('no recorder: the visits count is not said (never a 0 it did not count)', /^Loop closed: 1 lead · /.test(line) && !/visit/.test(line), line);
    ok('and the sheet says it could not check them', /Couldn't check today's visits/.test(text(dialog(T))));
    const Tp = win({ remoteOk: false });
    await flush();
    click(Tp.dom, widgetOf(Tp).querySelector('[data-oshw-sd]'));
    await flush(); await flush();
    const lp = text(dialog(Tp).querySelector('.os-sd-closed'));
    ok('the server\'s visits not read (offline, rules): this phone\'s unfiled visit is still listed', !!dialog(Tp).querySelector('[data-sd-row="visit:v1"]'));
    ok('...but the visits count is not said (it would be this phone\'s alone)', /^Loop closed: 1 lead · /.test(lp) && !/visit/.test(lp), lp);
    ok('...and the sheet says only this phone\'s visits were checked', /only this phone's visits/i.test(text(dialog(Tp))), text(dialog(Tp)));
    const To = win();
    To.W.NBDVisitRecorder.listAll = () => Promise.resolve({ local: [{ id: 'v1', startedAtMs: TEN + 2 * 3600000, status: 'uploaded' }], remote: [] });
    await flush();
    click(To.dom, widgetOf(To).querySelector('[data-oshw-sd]'));
    await flush(); await flush();
    ok('an older recorder with no remoteOk counts as not read (never a count from half the rows)', !/visit/.test(text(dialog(To).querySelector('.os-sd-closed'))), text(dialog(To).querySelector('.os-sd-closed')));
    const Th = win();
    Th.W.NBDVisitRecorder.listAll = () => new Promise(() => {});   // the visits read never answers
    await flush();
    click(Th.dom, widgetOf(Th).querySelector('[data-oshw-sd]'));
    await flush(); await flush();
    ok('while the visits are still unread, no carry-over is written (it would say no visits open)',
      !!dialog(Th) && /Checking today's visits/.test(text(dialog(Th))) && !Th.store.nbd_os_carry, Th.store.nbd_os_carry);
    const Tn = win({ noNns: true });
    await flush();
    const wn = text(widgetOf(Tn));
    ok('no-next-step.js missing: the widget makes no claim (no count, no "every lead has a next step")',
      !/\d/.test(wn) && !/has a next step|All closed/.test(wn) && !!widgetOf(Tn).querySelector('[data-oshw-sd]'), wn);
    click(Tn.dom, widgetOf(Tn).querySelector('[data-oshw-sd]'));
    await flush(); await flush();
    const dn = text(dialog(Tn));
    ok('...and the sheet says it could not check the leads, no "Loop closed", no "Nothing left open"',
      /Couldn't check your leads/.test(dn) && !/Loop closed/.test(dn) && !/Nothing left open/.test(dn) && !dialog(Tn).querySelector('[data-sd-row^="lead:"]'), dn);
    ok('...and no carry-over is stored from it', !Tn.store.nbd_os_carry, Tn.store.nbd_os_carry);
    const Tv = win({ win: { role: 'viewer' } });
    await flush();
    click(Tv.dom, widgetOf(Tv).querySelector('[data-oshw-sd]'));
    await flush(); await flush();
    ok('a viewer gets Open only, no follow-up buttons', !dialog(Tv).querySelector('[data-sd-fu]') && !!dialog(Tv).querySelector('[data-sd-row="lead:A"] a'));
    ok('names are escaped in the sheet', /Ann <b>Able<\/b>/.test(text(dialog(T))) && !dialog(T).querySelector('b'));
    const code = noComments(SD_JS + SDL_JS);
    ok('no style="" and no inline handlers in the new files', !/style\s*=/.test(SD_JS + SDL_JS + SD_CSS.replace(/\/\*[\s\S]*?\*\//g, '')) && !/\son[a-z]+=/i.test(code));
    ok('no el.style string injection', !/\.style\.(cssText|setProperty)|\.style\s*=/.test(code));
    ok('the only CRM write is the follow-up deck\'s (no updateDoc / setDoc / addDoc of its own)', !/updateDoc|setDoc|addDoc|writeBatch|deleteDoc/.test(code));
    ok('no notification, no badge, no sound', !/Notification|registerControl|badge|sound\(/i.test(code));
    ok('no fetch or callable', !/\bfetch\s*\(|httpsCallable|import\s*\(/.test(code));
    ok('44px targets in the sheet and widget buttons', /\.os-sd-btn \{[^}]*min-height: 44px/.test(SD_CSS) && /\.os-sd-close \{[^}]*min-height: 44px/.test(SD_CSS));
    ok('no text under 11px and no hex colours (tokens only)', !/font-size:\s*(?:[0-9]|10)(?:\.\d+)?px/.test(SD_CSS) && !/#[0-9a-fA-F]{3,8}\b/.test(SD_CSS));
    ok('no motion of its own', !/@keyframes|animation|transition/.test(SD_CSS));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
