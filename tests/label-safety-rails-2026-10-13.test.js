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
  // A token in a comment must not satisfy a pin: strip comments first, and prove
  // the stripper works with a positive control.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
  ok('control: stripComments removes a commented token and keeps code', !/setFilter/.test(stripComments("// setFilter('labeled')\n/* setFilter */")) && /setFilter/.test(stripComments("cc.setFilter('x');")));
  const INLINE = /\son[a-z]+\s*=/i;
  ok('control: the inline-handler pattern catches onclick / onerror / spaced forms', INLINE.test('<b onclick="x">') && INLINE.test('<img onerror = y>') && INLINE.test(' onfoo=1') && !INLINE.test('<b class="one">'));
  const ui = stripComments(read('docs/pro/js/contact-suggest.js') + read('docs/pro/js/contact-labels.js') + read('docs/pro/js/contact-suggest-logic.js') + read('docs/pro/js/contact-labels-logic.js'));
  ok('no inline handler attributes in the label UI (any event name)', !INLINE.test(ui));
  const sheet = stripComments(read('docs/pro/js/contact-labels.js'));
  ok('the personal confirm warns skipped texts cannot be brought back', /can.?t be brought back|cannot be brought back|not be brought back/i.test(sheet));
  const tn = stripComments(read('functions/text-inbox.js'));
  ok('text notes filter capture-off days through captureOff (comments stripped)', /groupTextDays\([^)]*\)\s*\.filter\([^;]*CL\.captureOff\(\s*labels,\s*d\.phoneDigits/.test(tn));
  ok('the sheet repaints an effect line for the current choice', /cl-effect/.test(sheet));
  ok('Keep hidden (ack) offers an Undo', /showUndo\('Kept hidden/.test(sheet));
}

async function runH() {
  console.log('H. strengthened guards (vacuous-test audit, 2026-10-13)');
  const FAR = NOW + 400 * DAY;
  // far-future stamps cannot park a hidden number (both mirrors)
  const onLeadCall = [call({ id: 'f1', leadId: 'L1', bucket: 'customer', startedAtMs: NOW - H })];
  [['server', W], ['client', HA]].forEach(([who, impl]) => {
    ok(who + ': a far-future ackAtMs is ignored — the hidden number on a customer still resurfaces', impl.resurfacedNumbers(onLeadCall, lab('personal', 'hide', { ackAtMs: FAR }), NOW).length === 1);
    ok(who + ': a far-future updatedAtMs is ignored too', impl.resurfacedNumbers(onLeadCall, { [N]: { kind: 'personal', policy: 'hide', updatedAtMs: FAR } }, NOW).length === 1);
    ok(who + ' control: a sane ackAtMs after the call DOES silence it', impl.resurfacedNumbers(onLeadCall, lab('personal', 'hide', { ackAtMs: NOW - 10 * MIN }), NOW).length === 0);
  });
  // effect copy MEANING, not keywords
  const q = LG.effectText('supplier', 'quiet');
  ok('quiet effect: urgent and missed calls "will not show" and nothing says they will', /will not show/.test(q) && !/\bwill show\b/.test(q) && !/still shows/.test(q), q);
  ok('hide personal: an urgent call "still shows"; hide spam: "does not break through"', /urgent call still shows/.test(LG.effectText('personal', 'hide')) && /does not break through/.test(LG.effectText('spam', 'hide')) && !/still shows\.$/.test(LG.effectText('spam', 'hide').replace(/ If the number.*$/, '')));
  // capOff only for personal
  const sp = LG.buildDoc({ digits: N, kind: 'supplier', policy: 'quiet', capture: 'off', companyId: 'c', uid: 'u', nowMs: NOW });
  ok('buildDoc: capture off on a non-personal kind neither forces hide nor is stored', sp && sp.policy === 'quiet' && sp.capture === undefined, JSON.stringify(sp));
  const sp2 = LG.buildDoc({ digits: N, kind: 'spam', policy: 'surface', capture: 'off', companyId: 'c', uid: 'u', nowMs: NOW });
  ok('buildDoc: spam + capture off keeps the chosen surface policy', sp2 && sp2.policy === 'surface' && sp2.capture === undefined);
  // reconcile branches
  const L0 = (id, o) => Object.assign({ id, firstName: 'Pat', lastName: 'Lee', phone: N }, o);
  const qlab = { [N]: { kind: 'supplier', policy: 'quiet', updatedAtMs: NOW - 6 * H } };
  ok('reconcile: an archived lead is not live', LG.reconcile(qlab, [L0('A', { archived: true, createdAt: NOW - H })], { now: NOW }).length === 0);
  ok('reconcile control: the same lead not archived is listed', LG.reconcile(qlab, [L0('A', { createdAt: NOW - H })], { now: NOW }).length === 1);
  const two = LG.reconcile(qlab, [L0('OLDER', { createdAt: NOW - 2 * H }), L0('NEWER', { createdAt: NOW - H, firstName: 'Zed' })], { now: NOW });
  ok('reconcile: two leads on one number -> one row, the NEWEST customer', two.length === 1 && two[0].leadId === 'NEWER' && two[0].name === 'Zed Lee', JSON.stringify(two));
  ok('reconcile: a lead created at exactly the label time is not newer (> not >=); one ms later is', LG.reconcile(qlab, [L0('T', { createdAt: NOW - 6 * H })], { now: NOW }).length === 0 && LG.reconcile(qlab, [L0('T', { createdAt: NOW - 6 * H + 1 })], { now: NOW }).length === 1);
  ok('reconcile: createdAtMs is read when createdAt is absent', LG.reconcile(qlab, [L0('M', { createdAtMs: NOW - H })], { now: NOW }).length === 1);
  const sc = LG.reconcile({ [N]: { kind: 'personal', policy: 'surface', capture: 'off', updatedAtMs: NOW - 6 * H } }, [L0('A', { createdAt: NOW - H })], { now: NOW });
  ok('reconcile: surface + capture off (a raw doc) is still listed as capture-off', sc.length === 1 && sc[0].captureOff === true);
  ok('reconcile control: surface + NO capture off is not listed', LG.reconcile({ [N]: { kind: 'customer', policy: 'surface', updatedAtMs: NOW - 6 * H } }, [L0('A', { createdAt: NOW - H })], { now: NOW }).length === 0);
  // server captureOff edges
  const cl0 = { [N]: { kind: 'personal', policy: 'hide', capture: 'off', updatedAtMs: NOW - 5 * DAY, ackAtMs: 0 } };
  ok('captureOff: a DELETED newer lead is not a customer', CL.captureOff(cl0, N, [{ id: 'D', deleted: true, createdAt: NOW - H }]) === true);
  ok('captureOff: a lead created at exactly the label time is not newer (> not >=)', CL.captureOff(cl0, N, [{ id: 'E', createdAt: NOW - 5 * DAY }]) === true && CL.captureOff(cl0, N, [{ id: 'E', createdAt: NOW - 5 * DAY + 1 }]) === false);
  ok('captureOff: createdAtMs is read when createdAt is absent', CL.captureOff(cl0, N, [{ id: 'F', createdAtMs: NOW - H }]) === false);
  // suggestion fields
  const sgBase = { digits: N, calls: [call({ id: 'a', callType: 'supplier', startedAtMs: NOW - 2 * H }), call({ id: 'b', callType: 'supplier', startedAtMs: NOW - H })], thursday: [], labels: {}, dismissals: {}, now: NOW };
  const sOn = SG.suggestFor(Object.assign({}, sgBase, { onLead: true, leadName: 'Pat Lee' }));
  const sOff = SG.suggestFor(Object.assign({}, sgBase, { onLead: false }));
  ok('suggestion carries onLead + leadName (and false/empty off a customer)', sOn.onLead === true && sOn.leadName === 'Pat Lee' && sOff.onLead === false && sOff.leadName === '');

  // contact-suggest.js in a vm: row ordering, cap, own number, button labels, chip effect text
  function bootS(o) {
    const listeners = {};
    const w = { NBDContactLabelsLogic: LG, NBDContactSuggestLogic: SG, _user: { uid: 'u1' }, _userClaims: { role: 'company_admin', companyId: 'co' },
      _leads: o.leads || [], _companyProfile: o.profile || {}, NBDHomeAttention: { lastRows: o.rows || [] },
      NBDContactLabels: { canWrite: () => true, current: () => o.labels || {}, get: () => null, ack: async () => ({ ok: true }), clear: async () => ({ ok: true }), openSheet() {}, applyWithUndo: async () => ({ ok: true }) },
      addEventListener() {}, dispatchEvent() {}, showToast() {}, getDocs: async () => ({ docs: [] }) };
    w.document = { addEventListener: (t, f) => { listeners[t] = f; } };
    const c = vm.createContext(Object.assign({ console, Date, JSON, Math, Object, Array, String, Number, Promise, CustomEvent: function () {} }, w));
    c.window = c; c.setTimeout = () => 0;
    vm.runInContext(read('docs/pro/js/contact-suggest.js'), c);
    return c.NBDContactSuggest;
  }
  const realNow = Date.now; Date.now = () => NOW;
  try {
    const mkLead = (id, d, ms) => ({ id, firstName: 'P' + id, lastName: 'Q', phone: d, createdAt: NOW - ms });
    const nums = ['5550141001', '5550141002', '5550141003'];
    const labs3 = {}; nums.forEach((d) => { labs3[d] = { kind: 'supplier', policy: 'quiet', updatedAtMs: NOW - DAY }; });
    const leads3 = nums.map((d, i) => mkLead('L' + i, d, (i + 1) * H));
    const ordinary = call({ id: 'o1', phoneDigits: '5550149876', tags: ['sub'], contactName: 'Tag Sub', startedAtMs: NOW - H });
    const S3 = bootS({ leads: leads3, labels: labs3, rows: [ordinary] });
    const l3 = S3.forToday();
    const recs = l3.filter((s) => s.type === 'reconcile');
    ok('forToday: reconcile rows come BEFORE an ordinary suggestion that exists (positive control: it is present)', l3.some((s) => s.type !== 'reconcile') && l3[0].type === 'reconcile' && l3.findIndex((s) => s.type !== 'reconcile') > l3.map((s) => s.type).lastIndexOf('reconcile'), JSON.stringify(l3.map((s) => s.type)));
    ok('forToday: at most 2 reconcile rows; the last carries more = hidden remainder', recs.length === 2 && !recs[0].more && recs[1].more === 1, JSON.stringify(recs.map((r) => r.more)));
    ok('the "+N more" text is in the rendered row', /1 more like this/.test(S3.chipHtml(recs[1])));
    const SO = bootS({ leads: [mkLead('L0', nums[0], H)], labels: { [nums[0]]: labs3[nums[0]] }, profile: { phone: nums[0] } });
    ok('the owner\'s own number never raises a row', SO.forToday().length === 0);
    const SC = bootS({ leads: [mkLead('L0', nums[0], H)], labels: { [nums[0]]: labs3[nums[0]] } });
    ok('control: the same label with no own-number match raises the row', SC.forToday().length === 1);
    const qh = SC.chipHtml(SC.forToday()[0]);
    ok('quiet row: "Keep it hidden" button and the "and urgent" tail', />Keep it hidden</.test(qh) && /missed and urgent calls/.test(qh), qh);
    const hideLab = { [nums[0]]: { kind: 'spam', policy: 'hide', updatedAtMs: NOW - DAY } };
    const hh = bootS({ leads: [mkLead('L0', nums[0], H)], labels: hideLab });
    const hhHtml = hh.chipHtml(hh.forToday()[0]);
    ok('hide row: no "and urgent" in the tail (the contrast with quiet)', /Its missed calls stay off/.test(hhHtml) && !/missed and urgent/.test(hhHtml), hhHtml);
    const capLab = { [nums[0]]: { kind: 'personal', policy: 'hide', capture: 'off', updatedAtMs: NOW - DAY } };
    const cc = bootS({ leads: [mkLead('L0', nums[0], H)], labels: capLab });
    ok('capture-off row: "Keep it off" and "Unlabel and record again"', />Keep it off</.test(cc.chipHtml(cc.forToday()[0])) && />Unlabel and record again</.test(cc.chipHtml(cc.forToday()[0])));
    // chip effect lines
    const eff = (s) => SC.chipHtml(Object.assign({ digits: N, title: 'Looks like Supplier', why: 'x' }, s));
    const one = eff({ kind: 'supplier', needsSheet: false, effect: 'EFFECT-TEXT' });
    ok('one-tap chip: "If you accept:" + the effect, in the effect div', /class="cl-sug-effect">If you accept: EFFECT-TEXT</.test(one), one);
    const onl = eff({ kind: 'supplier', needsSheet: true, onLead: true, leadName: 'Sam Roe', effect: 'EFFECT-TEXT' });
    ok('on-customer chip: names the customer and says it is not one tap', /on customer Sam Roe, so it is not one tap/.test(onl) && !/If you accept/.test(onl), onl);
    const offl = eff({ kind: 'spam', needsSheet: true, onLead: false, effect: 'EFFECT-TEXT' });
    ok('hiding-kind chip: says you pick next, never promises the effect', /You pick what happens to its calls next/.test(offl) && !/EFFECT-TEXT/.test(offl));
    ok('control: a kind-less pattern chip has no effect div', !/cl-sug-effect/.test(eff({ kind: '', needsSheet: true, effect: '' })));
  } finally { Date.now = realNow; }

  // "See them" lands on the Labeled list (behavioural, in a vm)
  {
    const calls = []; const listeners = {};
    const w = { _user: { uid: 'u1' }, _userClaims: { role: 'company_admin', companyId: 'co' }, NBDContactLabelsLogic: LG, db: {}, collection: () => ({}),
      getDocs: async () => ({ docs: [] }), showToast() {}, addEventListener() {}, dispatchEvent() {}, CustomEvent: function () {}, _leads: [],
      NBDCallCenter: { setFilter: (f) => calls.push(f), _state: { loaded: true } } };
    w.document = { addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {}, style: {} }), body: { appendChild() {} } };
    const c = vm.createContext(Object.assign({ console, Date, JSON, Math, Object, Array, String, Number, Promise, setTimeout: () => 0, clearTimeout() {} }, w));
    c.window = c;
    vm.runInContext(read('docs/pro/js/contact-labels.js'), c);
    const hit = { closest: (sel) => (/tp-hidden/.test(sel) ? {} : null) };
    const miss = { closest: () => null };
    listeners.click.forEach((f) => f({ target: miss }));
    ok('a click elsewhere does not touch the Call Center filter', calls.length === 0);
    listeners.click.forEach((f) => f({ target: hit }));
    ok('the hidden-by-labels line sets the Call Center filter to "labeled"', calls.join() === 'labeled', JSON.stringify(calls));
  }
}


// Final audit round: the gaps the re-audit found (stamp sanitising, accept click,
// proxy / deleted lead via forNumber, partial clear, rendered confirm, retry path ...).
async function runI() {
  console.log('I. final audit round');
  const tick = () => new Promise((r) => setImmediate(r));
  // loadLabels sanitises far-future stamps (a hostile / bad-clock doc must not keep capture off)
  {
    const real = Date.now();
    const mkDb = (docs) => ({ collection: () => ({ doc: () => ({ collection: () => ({ get: async () => ({ docs: docs.map((x) => ({ id: x.id, data: () => x })) }) }) }) }) });
    const base = { id: N, kind: 'personal', policy: 'hide', capture: 'off' };
    const lead = [{ id: 'L', createdAt: real - H }];
    const far = await CL.loadLabels(mkDb([Object.assign({}, base, { ackAtMs: real + 400 * DAY, updatedAtMs: real + 400 * DAY })]), 't');
    ok('loadLabels: far-future ackAtMs / updatedAtMs are dropped, so a newer customer is captured', far[N] && far[N].ackAtMs === 0 && far[N].updatedAtMs === 0 && CL.captureOff(far, N, lead) === false, JSON.stringify(far));
    const sane = await CL.loadLabels(mkDb([Object.assign({}, base, { ackAtMs: real - 10 * 60000, updatedAtMs: real - 5 * DAY })]), 't');
    ok('loadLabels control: a sane ackAtMs after the customer keeps capture off', CL.captureOff(sane, N, lead) === true);
  }
  // reconcile: stamps, order, names, shapes
  const qlab = (o) => ({ [N]: Object.assign({ kind: 'supplier', policy: 'quiet', updatedAtMs: NOW - 6 * H }, o || {}) });
  const ld = (id, o) => Object.assign({ id, firstName: 'Pat', lastName: 'Lee', phone: N }, o);
  ok('reconcile: a far-future updatedAtMs (no ack) is ignored — the customer is listed', LG.reconcile(qlab({ updatedAtMs: NOW + 400 * DAY }), [ld('A', { createdAt: NOW - H })], { now: NOW }).length === 1);
  const n2 = LG.reconcile(qlab(), [ld('O', { createdAtMs: NOW - 3 * H }), ld('N', { createdAtMs: NOW - H, firstName: 'New' })], { now: NOW });
  ok('reconcile: newest of two leads that only carry createdAtMs', n2.length === 1 && n2[0].leadId === 'N');
  const N2 = '5550140099';
  const two = LG.reconcile({ [N]: qlab()[N], [N2]: { kind: 'supplier', policy: 'quiet', updatedAtMs: NOW - 6 * H } },
    [ld('OLD', { createdAt: NOW - 3 * H, firstName: 'Old' }), ld('NEW', { phone: N2, createdAt: NOW - H, firstName: 'New' })], { now: NOW });
  ok('reconcile: two people come back newest customer first', two.length === 2 && two[0].leadId === 'NEW' && two[1].leadId === 'OLD', JSON.stringify(two.map((x) => x.leadId)));
  ok('reconcile: a lead with no name reads "a customer"', LG.reconcile(qlab(), [{ id: 'X', phone: N, createdAt: NOW - H }], { now: NOW })[0].name === 'a customer');
  ok('reconcile: a Date with non-zero milliseconds is read to the millisecond', LG.reconcile(qlab(), [ld('D', { createdAt: new Date(NOW - 6 * H + 500) })], { now: NOW }).length === 1
    && LG.reconcile(qlab(), [ld('D', { createdAt: new Date(NOW - 6 * H) })], { now: NOW }).length === 0);
  ok('buildSuggestions with leadFor: the suggestion says onLead and the customer name', (() => {
    const rows = [call({ id: 'a', callType: 'supplier', startedAtMs: NOW - 2 * H }), call({ id: 'b', callType: 'supplier', startedAtMs: NOW - H })];
    const r = SG.buildSuggestions(rows, { leadFor: () => ({ leadName: 'Pat Lee' }), now: NOW, labels: {}, dismissals: {}, thursday: [] });
    return r.length === 1 && r[0].onLead === true && r[0].leadName === 'Pat Lee' && r[0].needsSheet === true;
  })());

  // vm helpers
  const fakeEl = () => { const e = { innerHTML: '', hidden: false, _kids: [], setAttribute() {}, appendChild(k) { if (k && k.id) els[k.id] = k; }, focus() {}, querySelector(sel) { return sel === '.cl-sheet' ? (this._sheet || (this._sheet = { innerHTML: '', querySelector() { return child; }, focus() {} })) : child; }, parentNode: null, className: '', id: '' }; return e; };
  const els = {}; const child = { focus() {} };
  function bootLabels(o) {
    const toasts = [], writes = [], timers = [], listeners = {}, created = [], attempts = [];
    const w = { _user: { uid: 'u1' }, _userClaims: { role: 'company_admin', companyId: 'co' }, NBDContactLabelsLogic: LG, db: {}, collection: () => ({}),
      doc: (...a) => ({ p: a.slice(1).join('/') }),
      getDocs: async () => ({ docs: (o.server || []).map((x) => ({ id: x.id, data: () => x })) }),
      setDoc: async (r, d) => { attempts.push(['set', r.p]); if (o.failFor && r.p.endsWith(o.failFor)) throw { code: 'unavailable' }; writes.push([r.p, d]); },
      deleteDoc: async (r) => { attempts.push(['delete', r.p]); if (o.failFor && r.p.endsWith(o.failFor)) throw { code: 'unavailable' }; writes.push([r.p, null]); },
      showToast: (m) => toasts.push(m), addEventListener() {}, dispatchEvent() {}, CustomEvent: function () {}, _leads: o.leads || [] };
    const docEls = {};
    w.document = { addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, getElementById: (id) => docEls[id] || null,
      createElement: () => { const e = fakeEl(); created.push(e); return e; }, body: { appendChild(e) { if (e && e.id) docEls[e.id] = e; } }, activeElement: null };
    const c = vm.createContext(Object.assign({ console, Date, JSON, Math, Object, Array, String, Number, Promise,
      setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {} }, w));
    c.window = c;
    if (o.callCenter) c.NBDCallCenter = o.callCenter;
    vm.runInContext(read('docs/pro/js/contact-labels.js'), c);
    const click = (attrs, sel) => listeners.click.forEach((f) => f({ target: { closest: (s) => ((sel ? s === sel : /^\[data-cl\]$/.test(s)) ? { getAttribute: (k) => (attrs[k] == null ? null : attrs[k]) } : null) } }));
    return { c, LB: c.NBDContactLabels, toasts, writes, timers, click, docEls, created, attempts };
  }
  const dd = (id, o) => Object.assign({ id, digits: id, kind: 'supplier', policy: 'quiet', updatedAtMs: NOW - DAY, createdAtMs: NOW - DAY, companyId: 'co', updatedBy: 'u1' }, o || {});
  const A = '5550140001', B = '5550140002';
  {
    const p = bootLabels({ server: [dd(A), dd(B)], failFor: B });
    await p.LB.load(true);
    const r = await p.LB.clear([A, B]);
    const bar = (p.docEls.clUndo || {}).innerHTML || '';
    ok('clear([A,B]) with B failing: ok:false and the Undo says 1 of 2 could not be removed', r.ok === false && /1 of 2 numbers could not be removed/.test(bar), bar);
    p.writes.length = 0; p.attempts.length = 0;
    p.click({ 'data-cl': 'undo' });
    await tick(); await tick();
    ok('...and that Undo restores only the number that was removed', p.writes.length === 1 && /5550140001$/.test(p.writes[0][0]), JSON.stringify(p.writes.map((x) => x[0])));
    ok('...and makes NO restore attempt at all for the number whose removal failed', p.attempts.length === 1 && /5550140001$/.test(p.attempts[0][1]) && !p.attempts.some((a) => /5550140002$/.test(a[1])), JSON.stringify(p.attempts));
  }
  {
    // rendered personal confirm (not the unrelated Unlabel toast)
    const s = bootLabels({ server: [], leads: [{ id: 'L', firstName: 'Pat', lastName: 'Lee', phone: N }] });
    s.LB.openSheet({ digits: N });
    s.click({ 'data-cl': 'kind', 'data-kind': 'personal' });
    await tick();
    const sheetEl = s.created.map((e) => e._sheet).filter(Boolean).pop();
    const html = sheetEl ? sheetEl.innerHTML : '';
    ok('the personal confirm, rendered: skipped texts "cannot be brought back" and the customer is named', /cannot be brought back into the CRM later/.test(html) && /This number is on customer Pat Lee/.test(html), html.slice(0, 300));
    ok('...and nothing was written before the second tap', s.writes.length === 0);
  }
  // not-ready then ready retry path (fake timers), and the give-up path
  {
    const calls = [];
    const cc = { setFilter: (f) => calls.push(f), _state: { loaded: false } };
    const t = bootLabels({ server: [] });
    const hit = { 'data-tp-act': 'goto' };
    delete t.c.NBDCallCenter;
    t.click(hit, '.tp-hidden [data-tp-act="goto"]');
    ok('not ready: nothing set yet and a retry is queued', calls.length === 0 && t.timers.length === 1);
    t.timers.shift()();
    ok('still not ready: another retry is queued', calls.length === 0 && t.timers.length === 1);
    t.c.NBDCallCenter = cc;
    t.timers.shift()();
    ok('ready on a later try: the filter is set to labeled exactly once', calls.join() === 'labeled' && t.timers.length === 0);
    const g = bootLabels({ server: [] });
    g.click(hit, '.tp-hidden [data-tp-act="goto"]');
    let n = 0; while (g.timers.length && n < 50) { g.timers.shift()(); n++; }
    ok('gives up quietly after about 20 tries (no throw, no endless loop)', n === 20 || n === 19 || (n > 15 && n < 25), 'tries=' + n);
  }
  // contact-suggest.js: accept click, forNumber proxy/deleted, twilio own number, quote in a name
  function bootS(o) {
    const listeners = {}, calls = { opened: [], applied: [] };
    const w = { NBDContactLabelsLogic: LG, NBDContactSuggestLogic: SG, _user: { uid: 'u1' }, _userClaims: { role: 'company_admin', companyId: 'co' },
      _leads: o.leads || [], _companyProfile: o.profile || {}, NBDHomeAttention: { lastRows: o.rows || [] },
      NBDContactLabels: { canWrite: () => true, current: () => o.labels || {}, get: () => null, ack: async () => ({ ok: true }), clear: async () => ({ ok: true }),
        openSheet: (x) => calls.opened.push(x), applyWithUndo: async (x) => { calls.applied.push(x); return { ok: true }; } },
      addEventListener() {}, dispatchEvent() {}, showToast() {}, getDocs: async () => ({ docs: [] }) };
    w.document = { addEventListener: (t, f) => { listeners[t] = f; } };
    const c = vm.createContext(Object.assign({ console, Date, JSON, Math, Object, Array, String, Number, Promise, CustomEvent: function () {} }, w));
    c.window = c; c.setTimeout = () => 0;
    vm.runInContext(read('docs/pro/js/contact-suggest.js'), c);
    const click = (attrs) => listeners.click({ target: { closest: (s) => (s === '[data-cs]' ? { getAttribute: (k) => (attrs[k] == null ? null : attrs[k]) } : null) } });
    return { S: c.NBDContactSuggest, calls, click };
  }
  const rows2 = [call({ id: 'a', callType: 'supplier', startedAtMs: NOW - 2 * H }), call({ id: 'b', callType: 'supplier', startedAtMs: NOW - H })];
  const realNow = Date.now; Date.now = () => NOW;
  try {
    const lead1 = { id: 'L1', firstName: 'Pat', lastName: 'Lee', phone: N };
    const on = bootS({ leads: [lead1], rows: rows2 });
    on.click({ 'data-cs': 'accept', 'data-digits': N, 'data-kind': 'supplier' });
    await tick(); await tick();
    ok('Accept on a number that is on a customer opens the sheet and applies NOTHING', on.calls.opened.length === 1 && on.calls.applied.length === 0 && on.calls.opened[0].leadName === 'Pat Lee', JSON.stringify(on.calls));
    const off = bootS({ leads: [], rows: rows2 });
    off.click({ 'data-cs': 'accept', 'data-digits': N, 'data-kind': 'supplier' });
    await tick(); await tick();
    ok('control: the same Accept off a customer applies the label (one tap)', off.calls.applied.length === 1 && off.calls.opened.length === 0);
    const del = bootS({ leads: [Object.assign({ deleted: true }, lead1)], rows: rows2 });
    ok('forNumber: a deleted lead is not a customer (onLead false)', del.S.forNumber(N).onLead === false);
    const prox = bootS({ leads: [lead1, Object.assign({}, lead1, { id: 'L2' }), Object.assign({}, lead1, { id: 'L3' })], rows: rows2 });
    ok('forNumber: a proxy line on 3 leads is not a customer (onLead false)', prox.S.forNumber(N).onLead === false);
    ok('forNumber control: one live lead is onLead', bootS({ leads: [lead1], rows: rows2 }).S.forNumber(N).onLead === true);
    const lab = { [N]: { kind: 'supplier', policy: 'quiet', updatedAtMs: NOW - DAY } };
    const tw = bootS({ leads: [Object.assign({ createdAt: NOW - H }, lead1)], labels: lab, profile: { twilioNumber: N } });
    ok('the company twilioNumber is an own number (no row)', tw.S.forToday().length === 0);
    const fmt = bootS({ leads: [Object.assign({ createdAt: NOW - H }, lead1)], labels: lab, profile: { phone: '(555) 014-2222', twilioNumber: '+15550142222' } });
    ok('own numbers are normalised (formatted phone, +1 twilio): no row', fmt.S.forToday().length === 0);
    ok('control: an unrelated own number does not hide the row', bootS({ leads: [Object.assign({ createdAt: NOW - H }, lead1)], labels: lab, profile: { phone: '(555) 014-9999' } }).S.forToday().length === 1);
    const q = bootS({ leads: [Object.assign({ createdAt: NOW - H }, lead1, { firstName: 'a" onmouseover="x', lastName: "O'Neil" })], labels: lab });
    const html = q.S.chipHtml(q.S.forToday()[0]);
    ok('a name with quotes cannot open an attribute (escaped, no live onmouseover)', !/\sonmouseover="/.test(html) && /&quot; onmouseover=&quot;x/.test(html) && /O&#39;Neil/.test(html), html);
  } finally { Date.now = realNow; }
}

gDone.then(runH).then(runI).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
}).catch((e) => { console.error(e); process.exit(1); });
