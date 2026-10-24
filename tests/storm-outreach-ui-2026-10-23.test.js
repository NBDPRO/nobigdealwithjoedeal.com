#!/usr/bin/env node
/**
 * Storm Center > Outreach tab (docs/pro/js/storm-outreach-ui.js), PR 2 of the
 * storm-and-demand queue. The module is run in a vm sandbox with a stub window
 * and a recording callable, so we see exactly what the browser would send.
 *
 * Proves: loads once; shows loading / error / empty / list states; names and
 * addresses are escaped; a customer with no phone, a declined form or no draft
 * cannot be ticked; every row has an accessible name; the file call carries an
 * event key and lead ids ONLY (never wording, phone or text); a busy filing
 * cannot be double-fired; the result says nothing was sent; nothing in the file
 * can send (no sms/email call, no fetch); CSP-clean (no inline handlers or
 * styles); storm-center.js and the loader are wired to it.
 *
 * Run: node tests/storm-outreach-ui-2026-10-23.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

const SRC = read('docs/pro/js/storm-outreach-ui.js');

function boot(callImpl) {
  const calls = [];
  const handlers = {};
  const root = { __stoWired: false, addEventListener: (t, fn) => { handlers[t] = fn; }, querySelectorAll: () => [] };
  let repaints = 0;
  const win = {
    _functions: {},
    _httpsCallable: (fns, name) => async (payload) => { calls.push({ name, payload }); return { data: await callImpl(name, payload) }; },
    StormCenter: { render: () => { repaints++; } },
  };
  const ctx = { window: win, document: { getElementById: (id) => (id === 'view-storm' ? root : null) }, console, Promise, setTimeout };
  ctx.window.window = win;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'storm-outreach-ui.js' });
  return { ui: win.StormOutreachUI, win, calls, handlers, repaints: () => repaints };
}

const PLAN = {
  days: 14, miles: 3, without_location: 2,
  events: [{
    key: '2026-10-21T20_40_00Z|39.1|-84.51|HAIL', hazard: 'hail', where: 'Mason, Warren, OH', when_text: 'Oct 21, 4:40 PM ET',
    counts: { past_customer: 1, open_lead: 3 },
    customers: [
      { lead_id: 'a1', name: 'Wanda <b>Won</b>', address: '1 Past St', stage: 'closed', cohort: 'past_customer', miles: 0.3, has_phone: true, declined_texting: false, draft: 'Hi Wanda, this is No Big Deal. A storm with hail was reported near Mason on Oct 21, 2026. Reply STOP to opt out.' },
      { lead_id: 'b2', name: 'Oren', address: '2 Open St', stage: 'new', cohort: 'open_lead', miles: 1.4, has_phone: true, declined_texting: false, draft: 'Hi Oren, draft two' },
      { lead_id: 'c3', name: 'Nophone', address: '', stage: 'new', cohort: 'open_lead', miles: 0.7, has_phone: false, declined_texting: false, draft: 'Hi' },
      { lead_id: 'd4', name: 'Declined', address: '4 St', stage: 'new', cohort: 'open_lead', miles: 0.8, has_phone: true, declined_texting: true, draft: 'Hi' },
    ],
  }],
};
const KEY = PLAN.events[0].key;

(async () => {
  console.log('A. states');
  let h = boot(async () => PLAN);
  ok('idle/loading shows a loading line, not an empty list', /Loading storm reports/.test(h.ui.html()));
  h.ui.load(); h.ui.load();
  await tick();
  ok('opening the tab lists once even when asked twice', h.calls.filter((c) => c.name === 'listStormOutreach').length === 1 && h.calls[0].payload && JSON.stringify(h.calls[0].payload) === '{"miles":3}');
  ok('the tab repaints when the list lands', h.repaints() >= 1);
  const out = h.ui.html();
  ok('the list shows the report, the town and the counts', /Hail report/.test(out) && /Mason, Warren, OH/.test(out) && /1 past customers, 3 open leads nearby/.test(out));
  ok('the owner is told nothing is sent from here', /Nothing is sent from here/.test(out));
  ok('2 customers without a map location are mentioned', /2 customers have no map location/.test(out));
  ok('markup in a name is escaped, not rendered', !/<b>Won/.test(out) && /Wanda &lt;b&gt;Won&lt;\/b&gt;/.test(out));
  ok('each row has an accessible name that includes cohort and distance', /aria-label="Wanda &lt;b&gt;Won&lt;\/b&gt;, Past customer, 0\.3 miles from the report"/.test(out));
  ok('each row has a visible label tied to the checkbox', /<label class="sto-name" for="sto-[^"]+-a1">/.test(out));
  ok('the draft is previewable', /Preview draft/.test(out) && /Hi Wanda, this is No Big Deal/.test(out));
  const dis = (id) => new RegExp('id="sto-[^"]+-' + id + '"[^>]*disabled').test(out);
  ok('no-phone and declined customers cannot be ticked, and say why', dis('c3') && dis('d4') && /No phone on file/.test(out) && /Declined texting/.test(out));
  ok('control: a textable customer is not disabled', !dis('a1') && !dis('b2'));
  ok('the file button starts disabled with 0 ticked', /class="btn btn-orange sto-file"[^>]*disabled>File 0 drafts/.test(out));
  ok('no phone number or email is rendered anywhere', !/\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b|@/.test(out));

  const empty = boot(async () => ({ days: 14, miles: 3, events: [], without_location: 0 }));
  empty.ui.load(); await tick();
  ok('no reports → a plain empty state', /No recent storm reports near your customers/.test(empty.ui.html()));
  const denied = boot(async () => { const e = new Error('no'); e.code = 'permission-denied'; throw e; });
  denied.ui.load(); await tick();
  ok('a non-owner sees who may use it, not a broken screen', /Only the owner or an admin/.test(denied.ui.html()) && /Try again/.test(denied.ui.html()));
  const broke = boot(async () => { throw new Error('boom'); });
  broke.ui.load(); await tick();
  ok('a failed load offers Try again and leaks no error text', /Try again in a moment/.test(broke.ui.html()) && !/boom/.test(broke.ui.html()));

  console.log('B. ticking and filing');
  h = boot(async (name, p) => (name === 'listStormOutreach' ? PLAN : { ok: true, filed: p.leadIds.length - 1, skipped: { cannot_text: 1 } }));
  h.ui.load(); await tick();
  h.ui._wire();
  const tickBox = (lead, on) => h.handlers.change({ target: { classList: { contains: (c) => c === 'sto-check' }, getAttribute: (k) => ({ 'data-sto-event': KEY, 'data-sto-lead': lead })[k], checked: on } });
  const clickFile = () => h.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => ({ 'data-sto-action': 'file', 'data-sto-event': KEY })[k] }) } });
  clickFile(); await tick();
  ok('control: filing with nothing ticked calls nothing', h.calls.filter((c) => c.name === 'fileStormOutreachDrafts').length === 0);
  tickBox('a1', true); tickBox('b2', true); tickBox('a1', false); tickBox('b2', true);
  ok('the button count follows the ticks', /File 1 draft to Agent inbox/.test(h.ui.html()));
  tickBox('a1', true);
  clickFile(); clickFile();
  await tick();
  const fc = h.calls.filter((c) => c.name === 'fileStormOutreachDrafts');
  ok('one file call, even if clicked twice while busy', fc.length === 1);
  ok('the call carries the event key and lead ids only', Object.keys(fc[0].payload).sort().join() === 'eventKey,leadIds,miles' && fc[0].payload.miles === 3 && fc[0].payload.eventKey === KEY && fc[0].payload.leadIds.slice().sort().join() === 'a1,b2');
  ok('the browser never sends wording, a phone or an address', !/Hi |STOP|Past St|555/.test(JSON.stringify(fc[0].payload)));
  const after = h.ui.html();
  ok('the result says what was filed, what was skipped, and that nothing was sent', /1 draft filed to your Agent inbox\. Nothing was sent\. Skipped: 1 no textable phone/.test(after), after.match(/sto-live[^<]*/)[0]);
  ok('the selection is cleared after filing', /File 0 drafts/.test(after));
  const bad = boot(async (name) => { if (name === 'listStormOutreach') return PLAN; throw new Error('server said no'); });
  bad.ui.load(); await tick(); bad.ui._wire();
  bad.handlers.change({ target: { classList: { contains: () => true }, getAttribute: (k) => ({ 'data-sto-event': KEY, 'data-sto-lead': 'a1' })[k], checked: true } });
  bad.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => ({ 'data-sto-action': 'file', 'data-sto-event': KEY })[k] }) } });
  await tick();
  ok('a failed filing says nothing was sent and keeps the ticks', /Could not file the drafts\. Nothing was sent\./.test(bad.ui.html()) && !/server said no/.test(bad.ui.html()) && /File 1 draft/.test(bad.ui.html()));

  console.log('B2. radius and select-all');
  const log = [];
  const m = boot(async (name, p) => { log.push([name, p]); return name === 'listStormOutreach' ? PLAN : { ok: true, filed: p.leadIds.length, skipped: {} }; });
  m.ui.load(); await tick(); m.ui._wire();
  const out2 = m.ui.html();
  ok('the radius control is a labelled group of 1 / 3 / 5 / 10 mi buttons with 3 pressed', /role="group" aria-label="Distance from the report"/.test(out2)
    && ['1', '3', '5', '10'].every((x) => new RegExp('data-sto-miles="' + x + '" aria-pressed="' + (x === '3') + '"').test(out2)));
  ok('each report offers Select everyone I can text and Clear', /data-sto-action="all"/.test(out2) && /data-sto-action="none"/.test(out2));
  const act = (r, attrs) => r.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => attrs[k] }) } });
  const lists = () => log.filter((c) => c[0] === 'listStormOutreach');
  act(m, { 'data-sto-action': 'miles', 'data-sto-miles': '10' }); await tick();
  ok('choosing 10 mi re-lists with miles 10 and marks it pressed', lists().length === 2 && lists()[1][1].miles === 10 && /data-sto-miles="10" aria-pressed="true"/.test(m.ui.html()));
  act(m, { 'data-sto-action': 'miles', 'data-sto-miles': '10' }); await tick();
  ok('choosing the same radius again does not re-list', lists().length === 2);
  act(m, { 'data-sto-action': 'miles', 'data-sto-miles': '99' }); await tick();
  ok('a radius that is not on offer is ignored', lists().length === 2 && m.ui._state.miles === 10);

  const m2 = boot(async (name, p) => (name === 'listStormOutreach' ? PLAN : { ok: true, filed: p.leadIds.length, skipped: {} }));
  m2.ui.load(); await tick();
  const calls2 = m2.calls;
  m2.ui._wire();
  m2.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => ({ 'data-sto-action': 'all', 'data-sto-event': KEY })[k] }) } });
  ok('Select everyone ticks only the rows that can be texted (state)', Object.keys(m2.ui._state.picked[KEY] || {}).sort().join() === 'a1,b2');
  ok('Select everyone leaves the no-phone and declined rows unticked (state)', !(m2.ui._state.picked[KEY] || {}).c3 && !(m2.ui._state.picked[KEY] || {}).d4);
  ok('the file button count follows Select everyone', /File 2 drafts to Agent inbox/.test(m2.ui.html()));
  m2.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => ({ 'data-sto-action': 'none', 'data-sto-event': KEY })[k] }) } });
  ok('Clear empties the selection', Object.keys(m2.ui._state.picked[KEY] || {}).length === 0 && /File 0 drafts/.test(m2.ui.html()));
  m2.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => ({ 'data-sto-action': 'all', 'data-sto-event': KEY })[k] }) } });
  m2.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => ({ 'data-sto-action': 'file', 'data-sto-event': KEY })[k] }) } });
  await tick();
  const f2 = calls2.filter((c) => c.name === 'fileStormOutreachDrafts');
  ok('filing after Select everyone sends exactly the two textable leads and the radius', f2.length === 1 && f2[0].payload.leadIds.slice().sort().join() === 'a1,b2' && f2[0].payload.miles === 3);

  // selection does not survive a radius change (the list under it changed)
  const m3 = boot(async (name, p) => (name === 'listStormOutreach' ? PLAN : { ok: true, filed: 0, skipped: {} }));
  m3.ui.load(); await tick(); m3.ui._wire();
  const act3 = (attrs) => m3.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => attrs[k] }) } });
  act3({ 'data-sto-action': 'all', 'data-sto-event': KEY });
  const before = Object.keys(m3.ui._state.picked[KEY] || {}).length;
  act3({ 'data-sto-action': 'miles', 'data-sto-miles': '5' }); await tick();
  ok('control: two were ticked; changing the radius clears the selection', before === 2 && Object.keys(m3.ui._state.picked).length === 0 && /File 0 drafts/.test(m3.ui.html()));
  // no selection edits while a filing is in flight
  let release;
  const gate = new Promise((r) => { release = r; });
  const m4 = boot(async (name, p) => { if (name === 'listStormOutreach') return PLAN; await gate; return { ok: true, filed: 2, skipped: {} }; });
  m4.ui.load(); await tick(); m4.ui._wire();
  const act4 = (attrs) => m4.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => attrs[k] }) } });
  act4({ 'data-sto-action': 'all', 'data-sto-event': KEY });
  act4({ 'data-sto-action': 'file', 'data-sto-event': KEY });
  act4({ 'data-sto-action': 'none', 'data-sto-event': KEY });
  ok('Clear is ignored while a filing is in flight', Object.keys(m4.ui._state.picked[KEY] || {}).length === 2 && m4.ui._state.busy === KEY);
  release(); await tick();

  console.log('B3. account switch in the same tab (audit finding 3)');
  const sw = boot(async () => PLAN);
  sw.win._user = { uid: 'u1' }; sw.win._userClaims = { companyId: 'coA' };
  sw.ui.load(); await tick(); sw.ui._wire();
  sw.handlers.click({ target: { closest: () => ({ disabled: false, getAttribute: (k) => ({ 'data-sto-action': 'all', 'data-sto-event': KEY })[k] }) } });
  ok('control: company A sees its customers and has two ticked', /Wanda/.test(sw.ui.html()) && Object.keys(sw.ui._state.picked[KEY] || {}).length === 2);
  sw.win._user = { uid: 'u2' }; sw.win._userClaims = { companyId: 'coB' };
  const afterSwitch = sw.ui.html();
  ok('after a switch to company B the old customers, drafts and ticks are gone', !/Wanda|Oren|Hi Wanda/.test(afterSwitch) && sw.ui._state.data === null && Object.keys(sw.ui._state.picked).length === 0);
  const listsBefore = sw.calls.filter((c) => c.name === 'listStormOutreach').length;
  sw.ui.load(); await tick();
  ok('opening the tab as company B lists again instead of reusing the old list', sw.calls.filter((c) => c.name === 'listStormOutreach').length === listsBefore + 1);
  const sw2 = (() => { let release; const gate = new Promise((r) => { release = r; }); const h = boot(async () => { await gate; return PLAN; }); h.release = release; return h; })();
  sw2.win._userClaims = { companyId: 'coA' };
  sw2.ui.load();
  sw2.win._userClaims = { companyId: 'coB' };
  sw2.ui.html();
  sw2.release(); await tick();
  ok('an answer still in flight for the old account is dropped, not shown to the new one', sw2.ui._state.data === null && !/Wanda/.test(sw2.ui.html()));
  const same = boot(async () => PLAN);
  same.win._user = { uid: 'u1' }; same.win._userClaims = { companyId: 'coA' };
  same.ui.load(); await tick(); same.ui.html(); same.ui.load(); await tick();
  ok('control: with no account change the loaded list is kept and listed once', /Wanda/.test(same.ui.html()) && same.calls.filter((c) => c.name === 'listStormOutreach').length === 1);

  console.log('C. nothing here can send; CSP-clean; wired in');
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no fetch / XHR / sms / email / outbound call in the module', !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|sendSms|sendEmail|twilio|resend|agentDraftAction|smsLog|sms_log/i.test(code));
  ok('only the two storm-outreach callables are ever called', [...code.matchAll(/callable\('([A-Za-z]+)'/g)].map((m) => m[1]).sort().join() === 'fileStormOutreachDrafts,listStormOutreach');
  ok('no inline handlers, <script>, or style attributes in the markup', !/\son[a-z]+\s*=/i.test(code.replace(/ariaon/g, '')) && !/<script/i.test(code) && !/style="/.test(code));
  const sc = read('docs/pro/js/storm-center.js');
  ok('storm-center has the Outreach tab, the load hook and the render branch', /tabBtn\('outreach'/.test(sc) && /window\.StormOutreachUI\.load\(\)/.test(sc) && /currentTab === 'outreach'/.test(sc));
  ok('the loader ships the module after storm-center, with a bumped cache version', /storm-center\.js\?v=([7-9]|\d\d)[\s\S]*storm-outreach-ui\.js\?v=3/.test(read('docs/pro/js/script-loader.js')));
  const css = read('docs/pro/css/storm-center.css');
  ok('styles exist for the tab, use no raw hex colours, and keep 44px targets', /\.sto-row/.test(css) && !/\.sto-[^{]*\{[^}]*#[0-9a-fA-F]{3,6}/.test(css) && /\.btn\.sto-file \{ min-height: 44px/.test(css));
  ok('the radius and select-all buttons keep 44px targets and the pressed radius is visibly different', /\.sto-radius-btn, \.sto-bar \.btn \{ min-height: 44px/.test(css) && /\.sto-radius-btn\[aria-pressed="true"\]/.test(css));
  ok('the dashboard bumps the stylesheet version', /css\/storm-center\.css\?v=([4-9]|\d\d)(?!\d)/.test(read('docs/pro/dashboard.html')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
