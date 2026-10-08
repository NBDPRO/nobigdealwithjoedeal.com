/**
 * tests/sms-lift-stop-2026-10-07.test.js
 *
 * WHY THIS EXISTS (Jo, 2026-10-07)
 * ────────────────────────────────
 * PR #2300 scoped STOP / Do Not Text per company and logged a gap: a company
 * had no way to lift its OWN phone-recorded STOP when the homeowner later said
 * "you can text me again". Jo's rule:
 *
 *   - the owner or a company_admin may LIFT an entry their company recorded
 *     itself (a manual add, or "They replied STOP" from their own phone);
 *   - a reason is required, and who / when / why is kept as an audit record;
 *     the entry is marked lifted, never deleted;
 *   - a STOP the homeowner texted to NBD's number (carrier level) stays
 *     START-only, never liftable from the CRM; other companies' entries are
 *     never touched;
 *   - enforced in the callable (reps / viewers refused), not only the page.
 *
 *   A. the role matrix — through the REAL requireTeamAdmin (handlers/_shared.js),
 *      not the world's stub.
 *   B. what lifts and what never does; the audit record; isOptedOut after.
 *   C. other companies untouched; the caller can't aim at another company.
 *   D. a new STOP / add on a lifted number puts it back in force; START on
 *      the line leaves a lifted entry (and its history) alone; listDnc says
 *      what can be lifted and why not.
 *   E. the page: Lift only on eligible entries for owner / company_admin, the
 *      reason sheet, the ineligible wording, escaping, the payload.
 *
 * Run: node tests/sms-lift-stop-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const W = require('./lib/sms-compliance-world');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const PHONE = '(859) 555-0134';
const KEY = '8595550134';
const ID1 = 'sms_dnc/co-1__' + KEY;
const ID2 = 'sms_dnc/co-2__' + KEY;
const OWNER_NOTE = 'They replied STOP (recorded from the CRM)';
const REASON = 'Homeowner said on the 10/8 call texts are fine';

// companies/co-1 is owned by own-1 — what the real requireTeamAdmin reads.
const COMPANY = { 'companies/co-1': { ownerId: 'own-1' }, 'companies/co-2': { ownerId: 'own-2' } };
const MANUAL1 = { [ID1]: { companyId: 'co-1', key: KEY, phone: PHONE, source: 'manual', addedAt: 1, addedBy: 'rep-1', note: 'asked at the door' } };
const PHONESTOP1 = { [ID1]: { companyId: 'co-1', key: KEY, phone: PHONE, source: 'stop_reply', stopLine: 'owner_phone', stopCompanyId: 'co-1', addedAt: 1, note: OWNER_NOTE } };
const LINESTOP1 = { [ID1]: { companyId: 'co-1', key: KEY, phone: PHONE, source: 'stop_reply', stopLine: 'twilio', addedAt: 1 } };

const OWNER = { uid: 'own-1', companyId: 'co-1' };
const ADMIN = { uid: 'adm-1', companyId: 'co-1', role: 'company_admin' };
const REP = { uid: 'rep-1', companyId: 'co-1', role: 'sales_rep' };
const MANAGER = { uid: 'mgr-1', companyId: 'co-1', role: 'manager' };
const VIEWER = { uid: 'v-1', companyId: 'co-1', role: 'viewer' };
const SOLO = { uid: 'solo-1' };

function world(docs) {
  const w = W.makeWorld({ docs: Object.assign({}, COMPANY, docs || {}) });
  // The REAL role check, not the world's stub: the matrix below is what the
  // deployed callable does.
  delete w.stubs['./handlers/_shared'];
  return w;
}
async function call(token, data, docs, w0) {
  const w = w0 || world(docs);
  const mod = W.load(w, 'sms-dnc.js');
  try {
    const out = await mod.manageSmsCompliance.__handler({ auth: token ? { uid: token.uid, token } : null, data });
    return { w, out };
  } catch (e) { return { w, err: e }; }
}
async function optedOut(w, companyId) {
  const OptOut = W.load(w, 'sms-optout.js');
  return OptOut.isOptedOut(w.db, PHONE, { companyId });
}
const show = (r) => JSON.stringify(r.err ? (r.err.code + ': ' + r.err.message) : r.out);
const lift = (extra) => Object.assign({ action: 'liftDnc', phone: PHONE, reason: REASON }, extra || {});

(async () => {
  // ═══ A. role matrix ════════════════════════════════════════════════════
  console.log('A. who may lift (real requireTeamAdmin)');
  for (const [name, token, docs] of [['the owner', OWNER, MANUAL1], ['a company_admin', ADMIN, MANUAL1],
    ['a solo owner (tenant = own uid)', SOLO, { ['sms_dnc/solo-1__' + KEY]: { companyId: 'solo-1', key: KEY, source: 'manual', addedAt: 1 } }]]) {
    const r = await call(token, lift(), docs);
    const id = token === SOLO ? 'sms_dnc/solo-1__' + KEY : ID1;
    ok(name + ' lifts their company\'s manual entry', r.out && r.out.ok === true && r.out.result === 'lifted'
      && (r.w.store.get(id) || {}).lifted === true, show(r));
  }
  for (const [name, token] of [['a sales rep', REP], ['a manager', MANAGER], ['a viewer', VIEWER]]) {
    const r = await call(token, lift(), MANUAL1);
    ok(name + ' is refused (permission-denied) and the entry still blocks', r.err && r.err.code === 'permission-denied'
      && (r.w.store.get(ID1) || {}).lifted !== true && (await optedOut(r.w, 'co-1')).optedOut === true, show(r));
  }
  {
    const r = await call(null, lift(), MANUAL1);
    ok('signed out → unauthenticated', r.err && r.err.code === 'unauthenticated', show(r));
  }
  {
    // The old action name is the same gate.
    const r = await call(REP, { action: 'removeDnc', phone: PHONE, reason: REASON }, MANUAL1);
    ok('the old removeDnc name is the same gate (a rep is refused)', r.err && r.err.code === 'permission-denied' && r.w.store.has(ID1), show(r));
  }

  // ═══ B. what lifts, the audit record ═══════════════════════════════════
  console.log('\nB. what lifts, and the record it leaves');
  {
    const r = await call(OWNER, lift(), MANUAL1);
    const d = r.w.store.get(ID1) || {};
    const h = Array.isArray(d.history) ? d.history : [];
    ok('a manual entry is MARKED lifted, not deleted (history kept)', r.w.store.has(ID1) && d.lifted === true && d.source === 'manual' && d.note === 'asked at the door', JSON.stringify(d));
    ok('…with the reason, who and when', d.liftReason === REASON && d.liftedBy === 'own-1' && d.liftedRole === 'owner' && d.liftedAt != null, JSON.stringify(d));
    ok('…and an audit event: lifted, by, role, reason, what it was', h.length === 1 && h[0].action === 'lifted' && h[0].byUid === 'own-1'
      && h[0].role === 'owner' && h[0].reason === REASON && h[0].source === 'manual' && typeof h[0].atMs === 'number', JSON.stringify(h));
    const after = await optedOut(r.w, 'co-1');
    ok('isOptedOut is false for that company afterwards', after.optedOut === false, JSON.stringify(after));
    ok('the lift is logged without the phone or reason', r.w.logs.info.some((a) => a[0] === 'sms_dnc_lift' && !/8595550134|10\/8/.test(JSON.stringify(a))), JSON.stringify(r.w.logs.info));
  }
  {
    const r = await call(ADMIN, lift(), PHONESTOP1);
    const d = r.w.store.get(ID1) || {};
    ok('"They replied STOP" recorded from the company\'s own phone (owner_phone) lifts — company_admin',
      r.out && r.out.result === 'lifted' && d.lifted === true && d.liftedRole === 'company_admin' && d.source === 'stop_reply' && d.stopLine === 'owner_phone', show(r));
    ok('…and that company can text the number again', (await optedOut(r.w, 'co-1')).optedOut === false);
  }
  {
    // Written before R6-3-5: no stopLine, but the CRM's own note.
    const r = await call(OWNER, lift(), { [ID1]: { companyId: 'co-1', key: KEY, source: 'stop_reply', note: OWNER_NOTE, addedAt: 1 } });
    ok('an older phone-recorded STOP (OWNER_STOP_NOTE, no stopLine) lifts', r.out && r.out.result === 'lifted' && (r.w.store.get(ID1) || {}).lifted === true, show(r));
  }
  for (const [name, docs] of [['a STOP texted to NBD\'s number (stopLine twilio)', LINESTOP1],
    ['an older STOP nobody can attribute (no stopLine, no CRM note)', { [ID1]: { companyId: 'co-1', key: KEY, source: 'stop_reply', addedAt: 1 } }],
    ['a phone STOP recorded by ANOTHER company (stopCompanyId co-2)', { [ID1]: { companyId: 'co-1', key: KEY, source: 'stop_reply', stopLine: 'owner_phone', stopCompanyId: 'co-2', addedAt: 1 } }]]) {
    const before = JSON.stringify(docs[ID1]);
    const r = await call(OWNER, lift(), docs);
    ok(name + ' is NEVER lifted from the CRM — doc byte-identical, still blocks', r.out && r.out.ok === false && r.out.result === 'not_liftable'
      && JSON.stringify(r.w.store.get(ID1)) === before && (await optedOut(r.w, 'co-1')).optedOut === true, show(r));
  }
  {
    const r = await call(OWNER, lift(), LINESTOP1);
    ok('…and says why: only their START reply lifts it', r.out && r.out.why === 'stop_reply_line', show(r));
  }
  for (const [name, reason] of [['no reason', undefined], ['a blank reason', '   '], ['a reason over 300 characters', 'x'.repeat(301)]]) {
    const r = await call(OWNER, { action: 'liftDnc', phone: PHONE, reason }, MANUAL1);
    ok(name + ' → invalid-argument, nothing written', r.err && r.err.code === 'invalid-argument' && JSON.stringify(r.w.store.get(ID1)) === JSON.stringify(MANUAL1[ID1]), show(r));
  }
  {
    const w = world(MANUAL1);
    await call(OWNER, lift(), null, w);
    const r = await call(ADMIN, lift({ reason: 'again' }), null, w);
    ok('lifting an already-lifted entry → not_liftable (lifted), the first record kept', r.out && r.out.result === 'not_liftable' && r.out.why === 'lifted'
      && (w.store.get(ID1) || {}).liftReason === REASON && (w.store.get(ID1).history || []).length === 1, show(r));
  }
  {
    const r = await call(OWNER, lift());
    ok('no entry → absent', r.out && r.out.ok === false && r.out.result === 'absent', show(r));
  }
  {
    // A manual entry lifted while the homeowner ALSO texted STOP to the line:
    // the register still holds them, and the answer says so.
    const r = await call(OWNER, lift(), Object.assign({ ['sms_opt_outs/' + KEY]: { phone: '+18595550134' } }, MANUAL1));
    ok('lifted, but a line STOP in the register still blocks → stillBlocked stop_reply_line',
      r.out && r.out.result === 'lifted' && r.out.stillBlocked === 'stop_reply_line' && (await optedOut(r.w, 'co-1')).optedOut === true, show(r));
  }

  // ═══ C. other companies ════════════════════════════════════════════════
  console.log('\nC. other companies are never affected');
  {
    const co2 = { companyId: 'co-2', key: KEY, phone: PHONE, source: 'stop_reply', stopLine: 'owner_phone', stopCompanyId: 'co-2', addedAt: 1 };
    const co2m = { companyId: 'co-2', key: KEY, phone: PHONE, source: 'manual', addedAt: 1 };
    for (const [name, other] of [['phone STOP', co2], ['manual entry', co2m]]) {
      const r = await call(OWNER, lift(), Object.assign({ [ID2]: other }, MANUAL1));
      ok('co-1 lifting its entry leaves co-2\'s ' + name + ' byte-identical and blocking', r.out && r.out.result === 'lifted'
        && JSON.stringify(r.w.store.get(ID2)) === JSON.stringify(other) && (await optedOut(r.w, 'co-2')).optedOut === true
        && (await optedOut(r.w, 'co-1')).optedOut === false, show(r));
    }
    const r = await call(ADMIN, lift({ companyId: 'co-2' }), { [ID2]: co2m });
    ok('a companyId in the request is ignored — co-1\'s admin cannot reach co-2\'s entry', r.out && r.out.result === 'absent'
      && JSON.stringify(r.w.store.get(ID2)) === JSON.stringify(co2m), show(r));
    // Defence in depth: the doc id is company-scoped, but the entry's own
    // companyId must match too (a mis-keyed doc never lifts for the caller).
    const odd = { companyId: 'co-2', key: KEY, source: 'manual', addedAt: 1 };
    const r2 = await call(OWNER, lift(), { [ID1]: odd });
    ok('an entry whose companyId is another company never lifts (other_company)', r2.out && r2.out.result === 'not_liftable' && r2.out.why === 'other_company'
      && JSON.stringify(r2.w.store.get(ID1)) === JSON.stringify(odd), show(r2));
  }

  // ═══ D. reinstated, START, listDnc ═════════════════════════════════════
  console.log('\nD. a new STOP puts it back; START leaves a lifted entry alone; the list');
  {
    const w = world(MANUAL1);
    await call(OWNER, lift(), null, w);
    const r = await call(REP, { action: 'addDnc', phone: PHONE, note: 'changed their mind' }, null, w);
    const d = w.store.get(ID1) || {};
    ok('re-adding a lifted number puts it back in force (rep)', r.out && r.out.ok && d.lifted === false && (await optedOut(w, 'co-1')).optedOut === true, show(r) + JSON.stringify(d));
    ok('…the history keeps the lift and adds the reinstatement', (d.history || []).length === 2 && d.history[0].action === 'lifted' && d.history[0].reason === REASON
      && d.history[1].action === 'reinstated', JSON.stringify(d.history));
  }
  {
    const w = world(PHONESTOP1);
    await call(OWNER, lift(), null, w);
    const OptOut = W.load(w, 'sms-optout.js');
    await OptOut.addDnc(w.db, { companyId: 'co-1', phone: PHONE, source: 'stop_reply', stopLine: 'owner_phone', stopCompanyId: 'co-1' }, () => w.clock.now);
    const d = w.store.get(ID1) || {};
    ok('a new "They replied STOP" on a lifted entry reinstates it', d.lifted === false && d.stopLine === 'owner_phone' && (await optedOut(w, 'co-1')).optedOut === true, JSON.stringify(d));
  }
  {
    const w = world(Object.assign({ 'leads/L1': { phone: PHONE, phoneDigits: KEY, companyId: 'co-1' } }, MANUAL1));
    await call(OWNER, lift(), null, w);
    const OptOut = W.load(w, 'sms-optout.js');
    await OptOut.copyStopToTenantLists(w.db, '+18595550134', { serverTimestamp: () => w.clock.now });
    const d = w.store.get(ID1) || {};
    ok('a STOP texted to the line on a lifted entry reinstates it as a line STOP (not liftable)', d.lifted === false && d.source === 'stop_reply' && d.stopLine === 'twilio'
      && OptOut.liftEligibility(d, 'co-1').ok === false, JSON.stringify(d));
  }
  {
    const w = world(PHONESTOP1);
    await call(OWNER, lift(), null, w);
    const OptOut = W.load(w, 'sms-optout.js');
    // NBD's own line START with this company as the line owner would clear its
    // owner_phone STOP — a lifted one is left alone so its history survives.
    await OptOut.liftStopOnLine(w.db, '+18595550134', { lineCompanyId: 'co-1', serverTimestamp: () => w.clock.now });
    ok('START on the line leaves a lifted entry (and its history) in place', w.store.has(ID1) && (w.store.get(ID1).history || []).length === 1);
  }
  {
    const r = await call(VIEWER, { action: 'listDnc' }, Object.assign({
      'sms_dnc/co-1__5135550123': { companyId: 'co-1', key: '5135550123', source: 'stop_reply', stopLine: 'twilio', addedAt: 3 },
      'sms_dnc/co-1__5135550199': { companyId: 'co-1', key: '5135550199', source: 'manual', addedAt: 2, lifted: true, liftedAt: 5, liftReason: REASON },
    }, PHONESTOP1));
    const by = {}; ((r.out && r.out.entries) || []).forEach((e) => { by[e.key] = e; });
    ok('listDnc: a phone STOP → liftable', by[KEY] && by[KEY].liftable === true && by[KEY].stopLine === 'owner_phone', show(r));
    ok('listDnc: a line STOP → not liftable, liftBlock stop_reply_line', by['5135550123'] && by['5135550123'].liftable === false && by['5135550123'].liftBlock === 'stop_reply_line');
    ok('listDnc: a lifted entry is listed as history with its reason', by['5135550199'] && by['5135550199'].lifted === true && by['5135550199'].liftReason === REASON && by['5135550199'].liftable === false);
  }
  {
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const m = rules.match(/match \/sms_dnc\/\{id\} \{([\s\S]*?)\}/);
    ok('firestore.rules: sms_dnc stays admin-SDK written only', !!m && /allow read, write: if false;/.test(m[1]));
  }

  // ═══ E. the page ═══════════════════════════════════════════════════════
  console.log('\nE. Settings → Texting rules: Lift, the reason sheet, escaping');
  const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/sms-compliance-settings.js'), 'utf8');
  const flush = () => new Promise((r) => setImmediate(r));
  function page(o) {
    const calls = []; const toasts = []; const listeners = {};
    const mount = { innerHTML: '' };
    const reasonBox = { value: o.reason || '', focus() { reasonBox.focused = true; } };
    const elements = { smsComplianceMount: mount, sccLiftReason: reasonBox, 'stab-panel-ai-texting': { style: { display: 'none' } } };
    const responses = Object.assign({
      getSettings: { allowed: true, registered: true, enabled: true, needsRegistration: false },
      listDnc: { entries: o.entries || [] },
      liftDnc: { ok: true, result: 'lifted', stillBlocked: null },
    }, o.responses || {});
    const win = {
      _userClaims: o.claims || {}, _user: { uid: o.uid || 'own-1' }, _functions: {},
      _httpsCallable: () => async (payload) => { calls.push(payload); return { data: responses[payload.action] }; },
      showToast: (m, k) => toasts.push([k, String(m)]),
      nbdConfirm: async () => true, switchSettingsTab: function () {},
      console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, String, Object, Array, JSON, Math, Number,
    };
    const document = { readyState: 'complete', getElementById: (id) => elements[id] || null, addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
    win.document = document; win.window = win;
    vm.runInNewContext(SRC, win);
    const click = async (attrs) => {
      const el = { disabled: false, getAttribute: (k) => (attrs[k] == null ? null : attrs[k]), closest: () => el };
      for (const fn of listeners.click || []) fn({ target: el });
      await flush(); await flush(); await flush();
    };
    return { win, mount, calls, toasts, click, reasonBox };
  }
  const ENTRIES = [
    { key: KEY, phone: PHONE, source: 'stop_reply', stopLine: 'owner_phone', liftable: true, liftBlock: null, addedAtMs: 3 },
    { key: '5135550123', phone: '513-555-0123', source: 'stop_reply', stopLine: 'twilio', liftable: false, liftBlock: 'stop_reply_line', addedAtMs: 2 },
    { key: '5135550199', phone: '513-555-0199', source: 'manual', liftable: false, lifted: true, liftedAtMs: Date.UTC(2026, 9, 8, 16),
      liftReason: '<img src=x onerror=alert(1)> "said ok"', addedAtMs: 1 },
  ];
  {
    const h = page({ entries: ENTRIES });
    await h.win.NBDSmsCompliance.load(); await flush();
    const html = h.mount.innerHTML;
    ok('owner: a Lift button on the phone-recorded STOP', /data-scc-action="lift" data-scc-phone="8595550134"/.test(html), html.slice(0, 400));
    ok('…worded as a STOP recorded from their phone', /Replied STOP to your phone \(recorded by your team\)/.test(html));
    ok('a line STOP has NO Lift button and says why', !/data-scc-phone="5135550123"/.test(html) && /Opted out by text — only their START reply lifts it/.test(html));
    ok('a lifted entry shows as history ("Texting OK again"), no button', /Texting OK again — lifted/.test(html) && !/data-scc-phone="5135550199"/.test(html));
    ok('the lift reason is escaped (public-input rule: no live markup, quotes encoded)', !/<img src=x/.test(html) && /&lt;img src=x onerror=alert\(1\)&gt; &quot;said ok&quot;/.test(html));
    ok('no sheet until Lift is tapped', !/id="sccLiftReason"/.test(html));
  }
  {
    const h = page({ entries: [{ key: '85955"><b>0134', phone: '"><svg onload=alert(1)>', source: 'manual', liftable: true, addedAtMs: 1, note: '"><i>n' }] });
    await h.win.NBDSmsCompliance.load(); await flush();
    const html = h.mount.innerHTML;
    ok('a hostile key / phone / note is escaped in text AND in the data-scc-phone attribute', !/<svg|<b>|<i>/.test(html) && /data-scc-phone="85955&quot;&gt;&lt;b&gt;0134"/.test(html), html);
    await h.click({ 'data-scc-action': 'lift', 'data-scc-phone': '85955"><b>0134' });
    ok('…and in the sheet', /id="sccLiftReason"/.test(h.mount.innerHTML) && !/<svg|<b>/.test(h.mount.innerHTML));
  }
  {
    const h = page({ entries: ENTRIES });
    await h.win.NBDSmsCompliance.load(); await flush();
    await h.click({ 'data-scc-action': 'lift', 'data-scc-phone': KEY });
    const html = h.mount.innerHTML;
    ok('tapping Lift opens the reason sheet (required reason, Lift + Cancel)', /id="sccLiftReason"/.test(html) && /Reason \(required\)/.test(html)
      && /data-scc-action="lift-confirm" data-scc-phone="8595550134"/.test(html) && /data-scc-action="lift-cancel"/.test(html));
    ok('…and focuses the reason box', h.reasonBox.focused === true);
    await h.click({ 'data-scc-action': 'lift-confirm', 'data-scc-phone': KEY });
    ok('an empty reason never reaches the server', !h.calls.some((c) => c.action === 'liftDnc') && h.toasts.some(([k]) => k === 'error'), JSON.stringify(h.calls));
    h.reasonBox.value = '  ' + REASON + ' ';
    await h.click({ 'data-scc-action': 'lift-confirm', 'data-scc-phone': KEY });
    const sent = h.calls.find((c) => c.action === 'liftDnc');
    ok('Lift → manageSmsCompliance { action: liftDnc, phone, reason (trimmed) }', !!sent && sent.phone === KEY && sent.reason === REASON, JSON.stringify(h.calls));
    ok('…success toast, list reloaded, sheet closed', h.toasts.some(([k, m]) => k === 'success' && /Lifted/.test(m))
      && h.calls.filter((c) => c.action === 'listDnc').length === 2 && !/id="sccLiftReason"/.test(h.mount.innerHTML));
  }
  {
    const h = page({ entries: ENTRIES, reason: REASON, responses: { liftDnc: { ok: true, result: 'lifted', stillBlocked: 'stop_reply_line' } } });
    await h.win.NBDSmsCompliance.load(); await flush();
    await h.click({ 'data-scc-action': 'lift', 'data-scc-phone': KEY });
    await h.click({ 'data-scc-action': 'lift-confirm', 'data-scc-phone': KEY });
    ok('lifted but still blocked by a line STOP → says only their START reply lifts that', h.toasts.some(([k, m]) => k === 'error' && /only their START reply/.test(m)), JSON.stringify(h.toasts));
  }
  {
    const h = page({ entries: ENTRIES });
    await h.win.NBDSmsCompliance.load(); await flush();
    await h.click({ 'data-scc-action': 'lift', 'data-scc-phone': KEY });
    await h.click({ 'data-scc-action': 'lift-cancel' });
    ok('Cancel closes the sheet with nothing sent', !/id="sccLiftReason"/.test(h.mount.innerHTML) && !h.calls.some((c) => c.action === 'liftDnc'));
  }
  for (const [name, claims] of [['a sales rep', { companyId: 'co-1', role: 'sales_rep' }], ['a viewer', { companyId: 'co-1', role: 'viewer' }], ['a manager', { companyId: 'co-1', role: 'manager' }]]) {
    const h = page({ entries: ENTRIES, claims, uid: 'x' });
    await h.win.NBDSmsCompliance.load(); await flush();
    ok(name + ' sees no Lift button', !/data-scc-action="lift"/.test(h.mount.innerHTML) && /\(859\) 555-0134/.test(h.mount.innerHTML));
  }
  {
    const h = page({ entries: ENTRIES, claims: { companyId: 'co-1', role: 'company_admin' }, uid: 'adm-1' });
    await h.win.NBDSmsCompliance.load(); await flush();
    ok('a company_admin sees the Lift button', /data-scc-action="lift" data-scc-phone="8595550134"/.test(h.mount.innerHTML));
  }
  ok('the page never calls the old removeDnc and has no Remove button', !/removeDnc/.test(SRC) && !/data-scc-action="remove"/.test(SRC));
  ok('no inline on*= handlers and no style= attributes', !/\son[a-z]+=/i.test(SRC.replace(/\/\/.*$/gm, '')) && !/style=/.test(SRC));
  const loader = fs.readFileSync(path.join(ROOT, 'docs/pro/js/script-loader.js'), 'utf8');
  ok('the loader cache-buster moved past v=1', /'js\/sms-compliance-settings\.js\?v=([2-9]|\d{2,})'/.test(loader));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
