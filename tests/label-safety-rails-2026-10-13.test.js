/**
 * tests/label-safety-rails-2026-10-13.test.js — a label must never silently
 * hide a real customer (audits C-4 and UX H5, 2026-10-13).
 *
 *   A. the lead valve covers QUIET too (server call-watch-logic == client
 *      home-attention): a quiet number's call that is filed on a customer
 *      comes back; a quiet number NOT on a customer still stays quiet
 *      (Jo's 2026-10-12 decision: quiet = promise / due callback only)
 *   B. capture-off yields to a customer that appeared AFTER the label
 *      (functions/contact-labels.js captureOff), and still honours a label
 *      Jo set while the customer already existed, or confirmed since
 *   C. pure client rules: effect copy, reconcile(), capture-off = hide
 *   D. suggestions: a hiding or quiet kind on a number that is on a customer
 *      is never one tap (opens the sheet); the chip says what Accept does
 *   E. the Today row (contact-suggest.js, vm sandbox): escaped, people-
 *      counted, Keep hidden / Unlabel wired, viewers never see it
 *   F. wiring pins: cache-busters, manifest, no inline handlers
 *
 * Every absence assertion carries a positive control (the same input minus
 * the thing under test DOES produce the thing).
 * Run: node tests/label-safety-rails-2026-10-13.test.js
 */
'use strict';
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}

const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
const CL = require(path.join(ROOT, 'functions/contact-labels.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const LG = require(path.join(ROOT, 'docs/pro/js/contact-labels-logic.js'));
const SG = require(path.join(ROOT, 'docs/pro/js/contact-suggest-logic.js'));

const NOW = Date.parse('2026-10-13T16:00:00Z');
const H = 3600000, MIN = 60000, DAY = 86400000;
const N = '5550142222';
const call = (o) => Object.assign({ id: 'c1', direction: 'inbound', status: 'noted', bucket: 'unknown', phoneDigits: N, startedAtMs: NOW - H }, o);
const lab = (kind, policy, extra) => ({ [N]: Object.assign({ kind, policy, updatedAtMs: NOW - 6 * H }, extra || {}) });

console.log('A. the lead valve covers quiet');
{
  const urgentOnLead = [call({ id: 'u1', urgent: true, leadId: 'L1', bucket: 'customer' })];
  const urgentOffLead = [call({ id: 'u2', urgent: true })];
  const quiet = lab('supplier', 'quiet');
  const hide = lab('personal', 'hide');
  [['server', W], ['client', HA]].forEach(([who, impl]) => {
    const onLead = impl.resurfacedNumbers(urgentOnLead, quiet, NOW);
    ok(who + ': quiet number whose call is filed on a customer resurfaces (reason lead)', onLead.length === 1 && onLead[0].reason === 'lead', JSON.stringify(onLead));
    ok(who + ': control — the same call from a HIDE number resurfaces (existing valve)', impl.resurfacedNumbers(urgentOnLead, hide, NOW).length === 1);
    ok(who + ': a quiet number off every customer does NOT resurface (Jo: quiet = promise only)', impl.resurfacedNumbers(urgentOffLead, quiet, NOW).length === 0);
    const burst = [1, 2, 3].map((i) => call({ id: 'b' + i, startedAtMs: NOW - i * 10 * MIN }));
    ok(who + ': a quiet number calling 3x does NOT burst-resurface (a supplier ringing is not news)', impl.resurfacedNumbers(burst, quiet, NOW).length === 0);
    ok(who + ': control — three calls from a HIDE number do burst', impl.resurfacedNumbers(burst, hide, NOW).length === 1 && impl.resurfacedNumbers(burst, hide, NOW)[0].reason === 'burst');
    const acked = lab('supplier', 'quiet', { ackAtMs: NOW - 10 * MIN });
    ok(who + ': "Keep hidden" after the call quiets the quiet number (baseline moved)', impl.resurfacedNumbers(urgentOnLead, acked, NOW).length === 0);
  });
  const groups = HA.groupNeeds(urgentOnLead, NOW, quiet);
  ok('client groupNeeds: the customer is on Today, tagged resurfaced=lead', groups.length === 1 && groups[0].resurfaced === 'lead', JSON.stringify(groups.map((g) => g.resurfaced)));
  ok('control: groupNeeds on a quiet number off a customer is empty for an urgent call', HA.groupNeeds(urgentOffLead, NOW, quiet).length === 0);
  ok('control: same off-customer call with NO label counts', HA.groupNeeds(urgentOffLead, NOW, null).length === 1);
  const n = W.newNeeds(urgentOnLead, [], [], 0, NOW, quiet);
  ok('server newNeeds: a quiet number on a customer alerts once', JSON.stringify(n).indexOf('hidden:' + N) !== -1, JSON.stringify(n).slice(0, 200));
  const n0 = W.newNeeds(urgentOffLead, [], [], 0, NOW, quiet);
  ok('control: server newNeeds stays silent for a quiet number off a customer', JSON.stringify(n0).indexOf('hidden:' + N) === -1 && (n0.items || n0).length === 0, JSON.stringify(n0).slice(0, 200));
}

console.log('B. capture-off yields to a newer customer');
{
  const labels = { [N]: { kind: 'personal', policy: 'hide', capture: 'off', updatedAtMs: NOW - 5 * DAY, ackAtMs: 0 } };
  const newer = [{ id: 'L1', createdAt: { toMillis: () => NOW - 1 * DAY } }];
  const older = [{ id: 'L0', createdAt: { toMillis: () => NOW - 30 * DAY } }];
  ok('no lead: capture stays off (the old rule)', CL.captureOff(labels, N, []) === true && CL.captureOff(labels, N) === true);
  ok('a customer created AFTER the label: the number is captured again', CL.captureOff(labels, N, newer) === false);
  ok('a customer that existed BEFORE the label: Jo chose it with the lead hint — still off', CL.captureOff(labels, N, older) === true);
  const acked = { [N]: Object.assign({}, labels[N], { ackAtMs: NOW - 12 * H }) };
  ok('"Keep hidden" after the customer appeared restores capture-off', CL.captureOff(acked, N, newer) === true);
  ok('control: ackAtMs earlier than the customer does not', CL.captureOff({ [N]: Object.assign({}, labels[N], { ackAtMs: NOW - 3 * DAY }) }, N, newer) === false);
  ok('a lead with a plain number createdAt works too', CL.captureOff(labels, N, [{ id: 'L2', createdAt: NOW - DAY }]) === false);
  ok('a lead with no createdAt predates the label (legacy) — still off', CL.captureOff(labels, N, [{ id: 'L3' }]) === true);
  ok('a non-personal label never stops capture (unchanged)', CL.captureOff({ [N]: { kind: 'supplier', policy: 'quiet', capture: 'off', updatedAtMs: 1 } }, N, newer) === false);
}

console.log('C. pure client rules');
{
  const doc = LG.buildDoc({ digits: N, kind: 'personal', policy: 'surface', capture: 'off', companyId: 'co', uid: 'u', nowMs: NOW });
  ok('capture off forces policy hide (a "surface" label that records nothing was a lie)', doc && doc.policy === 'hide' && doc.capture === 'off', JSON.stringify(doc));
  const doc2 = LG.buildDoc({ digits: N, kind: 'personal', policy: 'surface', companyId: 'co', uid: 'u', nowMs: NOW });
  ok('control: personal + surface WITHOUT capture-off keeps surface', doc2 && doc2.policy === 'surface');
  const ix = LG.indexLabels([{ id: N, data: { kind: 'personal', policy: 'surface', capture: 'off' } }]);
  ok('an old surface + capture-off doc reads as hide', ix[N] && ix[N].policy === 'hide');

  const sup = LG.effectText('supplier', 'quiet');
  ok('quiet effect names urgent AND missed calls', /urgent/i.test(sup) && /missed/i.test(sup), sup);
  ok('quiet effect says a customer match will be flagged', /customer/i.test(sup), sup);
  ok('hide effect (spam) says urgent does NOT break through', /urgent/i.test(LG.effectText('spam', 'hide')) && /not/i.test(LG.effectText('spam', 'hide')));
  ok('hide effect (personal) says an urgent call still shows', /urgent call still shows/i.test(LG.effectText('personal', 'hide')));
  ok('capture off adds a not-recorded sentence', /not copied|not recorded|never saved|not saved/i.test(LG.effectText('personal', 'hide', 'off')));
  ok('surface effect says it stays on Today', /on Today/i.test(LG.effectText('customer', 'surface')));

  const lead = (id, o) => Object.assign({ id, firstName: 'Pat', lastName: 'Lee', phone: '(555) 014-2222', createdAt: { toMillis: () => NOW - 2 * H } }, o || {});
  const labels = lab('supplier', 'quiet');
  let r = LG.reconcile(labels, [lead('L1')], { now: NOW });
  ok('reconcile: a quiet number that gained a customer after the label is listed', r.length === 1 && r[0].leadId === 'L1' && r[0].kind === 'supplier' && r[0].digits[0] === N, JSON.stringify(r));
  ok('reconcile: control — a customer that predates the label is NOT listed', LG.reconcile(labels, [lead('L1', { createdAt: { toMillis: () => NOW - 30 * DAY } })], { now: NOW }).length === 0);
  ok('reconcile: a deleted lead is not a customer', LG.reconcile(labels, [lead('L1', { deleted: true })], { now: NOW }).length === 0);
  ok('reconcile: a proxy number (3+ leads) identifies nobody', LG.reconcile(labels, [lead('L1'), lead('L2'), lead('L3')], { now: NOW }).length === 0);
  ok('reconcile: a surface label never needs reconciling', LG.reconcile(lab('customer', 'surface'), [lead('L1')], { now: NOW }).length === 0);
  ok('reconcile: Keep hidden after the customer appeared clears it', LG.reconcile(lab('supplier', 'quiet', { ackAtMs: NOW - 10 * MIN }), [lead('L1')], { now: NOW }).length === 0);
  ok('reconcile: a far-future ack cannot park it for good', LG.reconcile(lab('supplier', 'quiet', { ackAtMs: NOW + 400 * DAY }), [lead('L1')], { now: NOW }).length === 1);
  ok('reconcile: capture-off personal is listed and flagged', (() => { const x = LG.reconcile(lab('personal', 'hide', { capture: 'off' }), [lead('L1')], { now: NOW }); return x.length === 1 && x[0].captureOff === true; })());
  ok('reconcile: two labeled numbers on ONE customer = one person', (() => {
    const two = Object.assign({}, labels, { '5550149999': { kind: 'supplier', policy: 'quiet', updatedAtMs: NOW - 6 * H } });
    const x = LG.reconcile(two, [lead('L1', { phone2: '555-014-9999' })], { now: NOW });
    return x.length === 1 && x[0].digits.length === 2;
  })());
  ok('reconcile: the owner\'s own number is never listed', LG.reconcile(labels, [lead('L1')], { now: NOW, ownDigits: [N] }).length === 0);
  ok('reconcile: no labels / no leads = empty, never a throw', LG.reconcile(null, null, { now: NOW }).length === 0 && LG.reconcile({}, [lead('L1')], { now: NOW }).length === 0);
}

console.log('D. suggestions');
{
  const calls = [call({ id: 'a', callType: 'supplier', status: 'noted', startedAtMs: NOW - 2 * H }), call({ id: 'b', callType: 'supplier', status: 'noted', startedAtMs: NOW - H })];
  const base = { digits: N, calls, thursday: [], labels: {}, dismissals: {}, now: NOW };
  const off = SG.suggestFor(Object.assign({}, base, { onLead: false }));
  ok('control: two supplier calls off a customer suggest Supplier, one tap', off && off.kind === 'supplier' && off.needsSheet === false, JSON.stringify(off));
  const on = SG.suggestFor(Object.assign({}, base, { onLead: true, leadName: 'Pat Lee' }));
  ok('the same number ON a customer opens the sheet (never one tap into quiet)', on && on.kind === 'supplier' && on.needsSheet === true, JSON.stringify(on));
  ok('the chip carries a plain-words effect line before the tap', off && /urgent/i.test(off.effect || '') && /missed/i.test(off.effect || ''), off && off.effect);
  ok('the customer-evidence suggestion (surface) stays one tap', (() => {
    const s = SG.suggestFor({ digits: N, calls: [call({ id: 'x', leadId: null })], thursday: [], labels: {}, dismissals: {}, onLead: true, leadName: 'Pat Lee', now: NOW });
    return s && s.kind === 'customer' && s.needsSheet === false;
  })());
}

console.log('E. the Today row (contact-suggest.js in a vm sandbox)');
{
  function boot(opts) {
    const calls = { cleared: [], acked: [], opened: [] };
    const listeners = {};
    const win = {
      NBDContactLabelsLogic: LG, NBDContactSuggestLogic: SG,
      _user: { uid: 'u1' }, _userClaims: Object.assign({ role: 'company_admin', companyId: 'co-a' }, opts.claims || {}),
      _leads: opts.leads || [],
      NBDHomeAttention: { lastRows: [] },
      NBDContactLabels: {
        canWrite: () => opts.canWrite !== false,
        current: () => opts.labels || {},
        get: (d) => (opts.labels || {})[d] || null,
        ack: async (d) => { [].concat(d).forEach((x) => calls.acked.push(x)); return { ok: true }; },
        clear: async (d) => { [].concat(d).forEach((x) => calls.cleared.push(x)); return { ok: true }; },
        openSheet: (o) => calls.opened.push(o),
        applyWithUndo: async () => ({ ok: true }),
      },
      addEventListener() {}, dispatchEvent() {}, CustomEvent: function () {},
      showToast() {},
      getDocs: async () => ({ docs: [] }),
    };
    win.window = win; win.document = { addEventListener: (t, f) => { listeners[t] = f; }, getElementById: () => null };
    win.CustomEvent = function CE(n) { this.type = n; };
    win.setTimeout = () => 0;
    const ctx = vm.createContext(Object.assign({ console }, win));
    ctx.window = ctx; ctx.document = win.document;
    vm.runInContext(read('docs/pro/js/contact-suggest.js'), ctx);
    return { ctx, calls, click: (attrs) => {
      const el = { getAttribute: (k) => attrs[k] == null ? null : attrs[k] };
      listeners.click({ target: { closest: (sel) => (sel === '[data-cs]' && attrs['data-cs'] ? el : null) } });
    } };
  }
  const lead = { id: 'L1', firstName: '<img src=x onerror=alert(1)>', lastName: 'Lee', phone: '(555) 014-2222', createdAt: { toMillis: () => NOW - 2 * H } };
  const labels = lab('supplier', 'quiet');
  const realNow = Date.now; Date.now = () => NOW;
  try {
    const b = boot({ leads: [lead], labels });
    const S = b.ctx.NBDContactSuggest;
    const list = S.forToday();
    const rec = list.filter((s) => s.type === 'reconcile');
    ok('forToday lists the reconciliation row first', rec.length === 1 && list[0] === rec[0], JSON.stringify(list.map((s) => s.type)));
    const html = S.chipHtml(rec[0]);
    ok('the row names the label and says it is now a customer', /Supplier/.test(html) && /now a customer/i.test(html), html);
    ok('the customer name is escaped (no live tag, no attribute break)', html.indexOf('<img') === -1 && html.indexOf('&lt;img') !== -1, html);
    ok('Keep hidden and Unlabel buttons are at least rendered as buttons with data-cs', /data-cs="rec-keep"/.test(html) && /data-cs="rec-clear"/.test(html));
    b.click({ 'data-cs': 'rec-keep', 'data-digits': N });
    ok('Keep hidden acks every labeled number of that person', b.calls.acked.length === 1 && b.calls.acked[0] === N, JSON.stringify(b.calls.acked));
    b.click({ 'data-cs': 'rec-clear', 'data-digits': N });
    ok('Unlabel clears the number', b.calls.cleared.length === 1 && b.calls.cleared[0] === N);
    const viewer = boot({ leads: [lead], labels, canWrite: false });
    ok('a viewer (cannot write) never gets the row (positive control: the admin did)', viewer.ctx.NBDContactSuggest.forToday().length === 0 && list.length > 0);
    const none = boot({ leads: [Object.assign({}, lead, { createdAt: { toMillis: () => NOW - 40 * DAY } })], labels });
    ok('control: a customer that predates the label raises no row', none.ctx.NBDContactSuggest.forToday().filter((s) => s.type === 'reconcile').length === 0);
    const cap = boot({ leads: [lead], labels: lab('personal', 'hide', { capture: 'off' }) });
    const chtml = cap.ctx.NBDContactSuggest.chipHtml(cap.ctx.NBDContactSuggest.forToday()[0]);
    ok('a capture-off row says texts that were skipped cannot be recovered', /text/i.test(chtml) && /recover|brought back|saved/i.test(chtml), chtml);
  } finally { Date.now = realNow; }
}

console.log('G. coordinator review fixes (timestamps, empty cache, partial failure, undo)');
const gDone = (async () => {
  const shapes = {
    iso: new Date(NOW - H).toISOString(), date: new Date(NOW - H), fsTs: { toMillis: () => NOW - H },
    seconds: { seconds: Math.floor((NOW - H) / 1000) }, _seconds: { _seconds: Math.floor((NOW - H) / 1000) }, num: NOW - H,
  };
  const lbl = { [N]: { kind: 'personal', policy: 'hide', capture: 'off', updatedAtMs: NOW - 5 * DAY, ackAtMs: 0 } };
  Object.keys(shapes).forEach((k) => {
    const srv = CL.captureOff(lbl, N, [{ id: 'L', createdAt: shapes[k] }]);
    const cli = LG.reconcile({ [N]: { kind: 'personal', policy: 'hide', capture: 'off', updatedAtMs: NOW - 5 * DAY } }, [{ id: 'L', phone: N, createdAt: shapes[k] }], { now: NOW }).length === 1;
    ok('createdAt as ' + k + ': server yields (captured) and client lists it — same answer', srv === false && cli === true, 'server=' + srv + ' client=' + cli);
  });
  ok('control: an unparseable createdAt string predates the label on BOTH sides', CL.captureOff(lbl, N, [{ id: 'L', createdAt: 'not a date' }]) === true
    && LG.reconcile({ [N]: { kind: 'personal', policy: 'hide', capture: 'off', updatedAtMs: NOW - 5 * DAY } }, [{ id: 'L', phone: N, createdAt: 'not a date' }], { now: NOW }).length === 0);
  ok('an archived customer is not live on either side (same predicate)', CL.captureOff(lbl, N, [{ id: 'L', archived: true, createdAt: NOW - H }]) === true
    && LG.reconcile({ [N]: { kind: 'personal', policy: 'hide', capture: 'off', updatedAtMs: NOW - 5 * DAY } }, [{ id: 'L', phone: N, archived: true, createdAt: NOW - H }], { now: NOW }).length === 0);
  const z = LG.buildDoc({ digits: N, kind: 'supplier', policy: 'quiet', companyId: 'c', uid: 'u', updatedAtMs: 0, nowMs: NOW });
  ok('buildDoc keeps an explicit updatedAtMs of 0 (an Undo never restamps)', z && z.updatedAtMs === 0);
  ok('control: without it updatedAtMs is now', LG.buildDoc({ digits: N, kind: 'supplier', companyId: 'c', uid: 'u', nowMs: NOW }).updatedAtMs === NOW);

  // contact-labels.js in a vm: ack / clear
  function bootLabels(opts) {
    const toasts = []; const writes = []; let reads = 0;
    const listeners = {};
    const w = { _user: { uid: 'u1' }, _userClaims: { role: 'company_admin', companyId: 'co' }, NBDContactLabelsLogic: LG,
      db: {}, collection: () => ({}), doc: (...a) => ({ p: a.slice(1).join('/') }),
      getDocs: async () => { reads++; return { docs: (opts.server || []).map((x) => ({ id: x.id, data: () => x })) }; },
      setDoc: async (r, d) => { if (opts.failFor && r.p.endsWith(opts.failFor)) throw { code: 'unavailable' }; writes.push([r.p, d]); },
      deleteDoc: async (r) => { if (opts.failFor && r.p.endsWith(opts.failFor)) throw { code: 'unavailable' }; writes.push([r.p, null]); },
      showToast: (m) => toasts.push(m), addEventListener() {}, dispatchEvent() {}, CustomEvent: function () {}, _leads: [] };
    w.document = { addEventListener: (t, f) => { listeners[t] = f; }, getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, remove() {} }), body: { appendChild() {} }, activeElement: null };
    w.window = w; w.setTimeout = () => 0; w.clearTimeout = () => {};
    const c = vm.createContext(Object.assign({ console, Date, JSON, Math, Object, Array, String, Number, Promise }, w));
    c.window = c;
    vm.runInContext(read('docs/pro/js/contact-labels.js'), c);
    return { LB: c.NBDContactLabels, toasts, writes, reads: () => reads };
  }
  const A = '5550140001', B2 = '5550140002';
  const doc = (id) => ({ id, digits: id, kind: 'supplier', policy: 'quiet', updatedAtMs: NOW - DAY, createdAtMs: NOW - DAY, companyId: 'co', updatedBy: 'u1' });
  {
    const e = bootLabels({ server: [doc(A)] });           // cache empty, server has it
    const r = await e.LB.ack([A]);
    ok('Keep hidden with an EMPTY cache reloads first and still acks (not a silent no-op)', r.ok === true && e.reads() >= 1 && e.writes.length === 1 && e.writes[0][1].ackAtMs > 0, JSON.stringify({ r, writes: e.writes.length }));
    const g = bootLabels({ server: [] });
    const r2 = await g.LB.ack([A]);
    ok('a label that is really gone says so (toast) and reports ok:false', r2.ok === false && g.toasts.some((t) => /already gone/i.test(t)), JSON.stringify(g.toasts));
    const g2 = bootLabels({ server: [] });
    const r3 = await g2.LB.clear([A, B2]);
    ok('Unlabel on a gone label says so too', r3.ok === false && g2.toasts.length === 1);
    const p = bootLabels({ server: [doc(A), doc(B2)], failFor: B2 });
    await p.LB.load(true);
    const r4 = await p.LB.ack([A, B2]);
    ok('partial failure: ok:false, the saved number is kept and the failure is toasted (not "all kept")', r4.ok === false && p.writes.some((x) => x[0].endsWith(A)) && p.toasts.some((t) => /Couldn.t save/i.test(t)), JSON.stringify({ r4, toasts: p.toasts }));
    const u = bootLabels({ server: [Object.assign(doc(A), { updatedAtMs: 0 })] });
    await u.LB.load(true);
    await u.LB.clear([A, A]);
    ok('control: clear of one labeled number writes a delete', u.writes.some((x) => x[1] === null));
  }
})();

console.log('F. wiring pins');
{
  const ha = read('docs/pro/js/home-attention.js');
  const bundle = (ha.match(/bundles\.contactlabels = \[([^\]]+)\]/) || [])[1] || '';
  ['contact-labels-logic.js', 'contact-labels.js', 'contact-suggest-logic.js', 'contact-suggest.js', 'contact-labels.css'].forEach((f) => {
    const v = (bundle.match(new RegExp(f.replace(/\./g, '\\.') + '\\?v=(\\d+)')) || [])[1];
    ok(f + ' cache-buster was bumped', Number(v) >= (f === 'contact-labels.css' ? 3 : f === 'contact-suggest-logic.js' || f === 'contact-suggest.js' ? 2 : 6), 'v=' + v);
  });
  const man = JSON.parse(read('tests/ci-manifest.json'));
  ok('the test is in ci-manifest.json', JSON.stringify(man).indexOf('label-safety-rails-2026-10-13.test.js') !== -1);
  const ui = read('docs/pro/js/contact-suggest.js') + read('docs/pro/js/contact-labels.js');
  ok('no inline handler attributes in the label UI', !/\son(click|change|input)=/i.test(ui));
  const sheet = read('docs/pro/js/contact-labels.js');
  ok('the personal confirm warns skipped texts cannot be brought back', /can.?t be brought back|cannot be brought back|not be brought back/i.test(sheet));
  const tn = read('functions/text-inbox.js');
  ok('text notes skip a capture-off day (and yield to a newer customer) before noting', /groupTextDays\(rows, \{ nowMs \}\)\.filter\(\(d\) => !CL\.captureOff\(labels, d\.phoneDigits, idx\.get\(d\.phoneDigits\)\)\)/.test(tn));
  ok('the sheet repaints an effect line for the current choice', /cl-effect/.test(sheet));
  ok('the hidden-by-labels line opens the Labeled list', /setFilter\('labeled'\)/.test(sheet));
  ok('Keep hidden (ack) offers an Undo', /showUndo\([^)]*Kept hidden|showUndo\('Kept/.test(sheet));
}

gDone.then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
}).catch((e) => { console.error(e); process.exit(1); });
