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
  return { ui: win.StormOutreachUI, calls, handlers, repaints: () => repaints };
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
  ok('opening the tab lists once even when asked twice', h.calls.filter((c) => c.name === 'listStormOutreach').length === 1 && h.calls[0].payload && Object.keys(h.calls[0].payload).length === 0);
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
  ok('the call carries the event key and lead ids only', Object.keys(fc[0].payload).sort().join() === 'eventKey,leadIds' && fc[0].payload.eventKey === KEY && fc[0].payload.leadIds.slice().sort().join() === 'a1,b2');
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

  console.log('C. nothing here can send; CSP-clean; wired in');
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no fetch / XHR / sms / email / outbound call in the module', !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|sendSms|sendEmail|twilio|resend|agentDraftAction|smsLog|sms_log/i.test(code));
  ok('only the two storm-outreach callables are ever called', [...code.matchAll(/callable\('([A-Za-z]+)'/g)].map((m) => m[1]).sort().join() === 'fileStormOutreachDrafts,listStormOutreach');
  ok('no inline handlers, <script>, or style attributes in the markup', !/\son[a-z]+\s*=/i.test(code.replace(/ariaon/g, '')) && !/<script/i.test(code) && !/style="/.test(code));
  const sc = read('docs/pro/js/storm-center.js');
  ok('storm-center has the Outreach tab, the load hook and the render branch', /tabBtn\('outreach'/.test(sc) && /window\.StormOutreachUI\.load\(\)/.test(sc) && /currentTab === 'outreach'/.test(sc));
  ok('the loader ships the module after storm-center, with a bumped cache version', /storm-center\.js\?v=7[\s\S]*storm-outreach-ui\.js\?v=1/.test(read('docs/pro/js/script-loader.js')));
  const css = read('docs/pro/css/storm-center.css');
  ok('styles exist for the tab, use no raw hex colours, and keep 44px targets', /\.sto-row/.test(css) && !/\.sto-[^{]*\{[^}]*#[0-9a-fA-F]{3,6}/.test(css) && /\.btn\.sto-file \{ min-height: 44px/.test(css));
  ok('the dashboard bumps the stylesheet version', /css\/storm-center\.css\?v=3/.test(read('docs/pro/dashboard.html')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
