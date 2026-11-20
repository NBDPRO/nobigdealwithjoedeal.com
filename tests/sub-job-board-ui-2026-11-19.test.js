/**
 * tests/sub-job-board-ui-2026-11-19.test.js — the Sub job board panel
 * (docs/pro/js/sub-job-board.js, flag subJobBoard).
 *
 * Behaviour, not source shape: the REAL panel, board logic, payments logic and
 * production logic run in a vm sandbox against a tiny fake DOM and a fake
 * Firestore. The assertions that matter:
 *   - the agreed-pay document it writes passes the same key allowlist the rules
 *     (firestore.rules subJobOk) enforce, so the UI and the rule cannot drift
 *   - the lead update carries ONLY subId / crew / updatedAt: no cost reaches the lead
 *   - flag off, a viewer, a sales rep: no panel
 *   - customer text is escaped
 *
 * Run: node tests/sub-job-board-ui-2026-11-19.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; fails.push(name); console.log('  FAIL ' + name); }
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

// The key allowlist and caps from firestore.rules subJobOk(): the UI's write must satisfy them.
const RULE_KEYS = ['subId', 'basis', 'rateCents', 'qty', 'agreedCents', 'noSubNeeded', 'note', 'updatedAt', 'updatedBy'];

function makeEnv(opts) {
  const o = Object.assign({ flag: true, claims: {}, uid: 'co-a', hash: '#/schedule', leads: [], roster: [], subJobs: [], payments: [] }, opts || {});
  const reg = {}, docL = {}, winL = {};
  const calls = { setDoc: [], updateDoc: [], toasts: [], estReads: [] };
  const makeEl = () => ({
    id: '', className: '', innerHTML: '',
    remove() { if (this.id) delete reg[this.id]; },
    insertAdjacentElement(pos, e) { if (e.id) reg[e.id] = e; return e; },
  });
  const anchor = makeEl(); anchor.id = 'schedPlanPanel'; reg.schedPlanPanel = anchor;
  const snap = (rows) => ({ docs: rows.map((r) => ({ id: r.id, data: () => { const c = Object.assign({}, r); delete c.id; return c; } })), forEach(fn) { this.docs.forEach(fn); } });
  const sb = {
    console, setTimeout, clearTimeout, Promise, Math, Date, Number, String, Array, Object, JSON, RegExp, parseInt, parseFloat, isFinite,
    document: {
      readyState: 'complete',
      getElementById: (id) => reg[id] || null,
      createElement: makeEl,
      addEventListener: (t, fn) => { (docL[t] = docL[t] || []).push(fn); },
    },
    location: { hash: o.hash },
    _leads: o.leads, _userClaims: o.claims, _user: { uid: o.uid }, db: {},
    NBDFlags: { enabled: (n) => (n === 'subJobBoard' && !!o.flag) || (n === 'laborHoursBook' && !!o.hoursFlag) },
    NBDCatalogCosts: o.hours ? { laborOp: (id) => (o.book || {})[id] || null } : undefined,
    getDoc: async (ref) => { calls.estReads.push(ref.path.join('/')); if (o.estFail) { const e = new Error('offline'); e.code = 'unavailable'; throw e; } const d = (o.estimates || {})[ref.path[1]]; return { exists: () => !!d, data: () => d }; },
    NBDProduction: { loadSubs: async () => o.roster, subs: () => o.roster },
    showToast: (m) => calls.toasts.push(m),
    collection: (db, ...p) => ({ path: p }),
    query: (c) => ({ path: c.path }), where: () => ({}), orderBy: () => ({}), limit: () => ({}),
    doc: (db, ...p) => ({ path: p }),
    getDocs: async (q) => snap(q.path[0] === 'expenses' ? o.payments : q.path.indexOf('subJobs') !== -1 ? o.subJobs : []),
    setDoc: async (ref, data) => { calls.setDoc.push({ path: ref.path, data }); },
    updateDoc: async (ref, data) => { calls.updateDoc.push({ path: ref.path, data }); },
    serverTimestamp: () => 'SERVER_TS',
  };
  sb.window = sb;
  sb.addEventListener = (t, fn) => { (winL[t] = winL[t] || []).push(fn); };
  vm.createContext(sb);
  (o.hours ? ['sub-payments-logic.js', 'sub-job-board-logic.js', 'production-logic.js', 'labor-hours-logic.js', 'job-hours-logic.js', 'sub-job-board.js'] : ['sub-payments-logic.js', 'sub-job-board-logic.js', 'production-logic.js', 'sub-job-board.js']).forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f });
  });
  const fire = (t) => (winL[t] || []).forEach((fn) => fn({}));
  const html = () => (reg.subJobBoardPanel ? reg.subJobBoardPanel.innerHTML : null);
  const click = (action, attrs, form) => {
    const t = {
      closest: (sel) => (sel === '[data-sjb-action]' ? t : sel === '#subJobBoardPanel' ? reg.subJobBoardPanel : sel === '[data-sjb-form]' ? form : null),
      getAttribute: (a) => (a === 'data-sjb-action' ? action : (attrs || {})[a] || null),
    };
    (docL.click || []).forEach((fn) => fn({ target: t }));
  };
  return { sb, reg, calls, fire, html, click, docL };
}

const roster = [
  { id: 's1', name: 'Mike Ruiz', trade: 'Roofing', active: true, rates: [{ type: 'Tear-off & install', basis: 'sq', cents: 8500 }] },
  { id: 's2', name: 'Sam Lee', trade: 'Gutters', active: true },
];
const lead = (id, over) => Object.assign({ id, firstName: 'Cust', lastName: id, stage: 'install_in_progress' }, over || {});

function fakeForm(leadId, vals) {
  const fields = {};
  Object.keys(vals).forEach((k) => { fields[k] = k === 'none' ? { checked: !!vals[k] } : { value: String(vals[k]) }; });
  const msg = { textContent: '' }, btn = { disabled: false };
  return {
    fields, msg, btn,
    getAttribute: (a) => (a === 'data-sjb-form' ? leadId : null),
    querySelector: (sel) => {
      const m = /\[data-sjb-f="(\w+)"\]/.exec(sel);
      if (m) return fields[m[1]] || null;
      if (sel === '[data-sjb-action="save"]') return btn;
      if (sel === '[data-sjb-msg]') return msg;
      return null;
    },
  };
}

// A change event on one field of an open editor.
function fireChange(e, form, key, value) {
  const t = {
    value, getAttribute: (a) => (a === 'data-sjb-f' ? key : null),
    closest: (sel) => (sel === '[data-sjb-form]' ? { closest: (s) => (s === '#subJobBoardPanel' ? e.reg.subJobBoardPanel : null), querySelector: form.querySelector } : null),
  };
  (e.docL.change || []).forEach((fn) => fn({ target: t }));
}

(async () => {
  console.log('1. the panel renders the board');
  {
    const e = makeEnv({ roster, leads: [lead('L1', { firstName: '<img src=x onerror=alert(1)>' }), lead('L2', { subId: 's1' })] });
    e.fire('nbd:data-refreshed'); await tick();
    const h = e.html();
    ok('panel appears after the Plan Jobs panel when the flag is on', !!h && /Sub job board/.test(h));
    ok('the no-sub job is listed under its bucket', /No sub on the job <span class="sp-count">1<\/span>/.test(h));
    ok('the sub-but-no-agreed-pay job is listed under its bucket', /Sub on, no agreed pay <span class="sp-count">1<\/span>/.test(h));
    ok('customer text is escaped: no raw <img> tag, the text shows as &lt;img', !/<img/.test(h) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(h));
    ok('the honest paid caveat is on screen', /Cash paid and never logged is not here/.test(h));
    ok('warnings only: the board says nothing is blocked', /nothing here blocks a job/.test(h));
  }

  console.log('2. who sees it');
  {
    const base = { roster, leads: [lead('L1')] };
    const off = makeEnv(Object.assign({ flag: false }, base)); off.fire('nbd:data-refreshed'); await tick();
    ok('flag off: no panel', off.html() === null);
    const rep = makeEnv(Object.assign({ claims: { role: 'sales_rep', companyId: 'co-a' }, uid: 'alice' }, base)); rep.fire('nbd:data-refreshed'); await tick();
    ok('a sales rep sees no panel', rep.html() === null);
    const vw = makeEnv(Object.assign({ claims: { role: 'viewer', companyId: 'co-a' }, uid: 'vic' }, base)); vw.fire('nbd:data-refreshed'); await tick();
    ok('a viewer sees no panel', vw.html() === null);
    const mgr = makeEnv(Object.assign({ claims: { role: 'manager', companyId: 'co-a' }, uid: 'mike' }, base)); mgr.fire('nbd:data-refreshed'); await tick();
    ok('control: a manager sees the panel', mgr.html() !== null);
    const adm = makeEnv(Object.assign({ claims: { role: 'admin', companyId: 'co-a' }, uid: 'co-a' }, base)); adm.fire('nbd:data-refreshed'); await tick();
    ok('the platform admin who OWNS the tenant (company id = their uid) sees it: the owner is the platform admin', adm.html() !== null);
    const adm2 = makeEnv(Object.assign({ claims: { role: 'admin', companyId: 'co-a' }, uid: 'joe' }, base)); adm2.fire('nbd:data-refreshed'); await tick();
    ok('a platform admin who does NOT own the tenant does not (the subJobs rule would refuse every save)', adm2.html() === null);
    const away = makeEnv(Object.assign({ hash: '#/leads' }, base)); away.fire('nbd:data-refreshed'); await tick();
    ok('control: off the Schedule view, nothing renders', away.html() === null);
  }

  console.log('3. saving agreed pay');
  {
    const e = makeEnv({ roster, leads: [lead('L1', { crew: 'Big Mike' })] });
    e.fire('nbd:data-refreshed'); await tick();
    e.click('edit', { 'data-id': 'L1' });
    ok('tapping Set pay opens the editor for that job', /data-sjb-form="L1"/.test(e.html()) && /No sub needed on this job/.test(e.html()));
    const f0 = fakeForm('L1', { sub: 's1', card: '', basis: 'sq', rate: '', qty: '', total: '', note: '', none: false });
    f0.fields.card.innerHTML = '';
    fireChange(e, f0, 'sub', 's1');
    ok('picking a sub offers that sub\'s rate card', /Tear-off &amp; install: \$85\.00 \/ SQ/.test(f0.fields.card.innerHTML));
    fireChange(e, f0, 'sub', 's2');
    ok('a sub with no rate card says so instead of showing the last sub\'s', /No rate card on this sub/.test(f0.fields.card.innerHTML) && !/Tear-off/.test(f0.fields.card.innerHTML));

    const form = fakeForm('L1', { sub: 's1', card: '', basis: 'sq', rate: '85', qty: '32', total: '2720', note: '', none: false });
    e.click('save', {}, form); await tick();
    const w = e.calls.setDoc[0];
    ok('one agreed-pay write, at companies/{tenant}/subJobs/{leadId}', e.calls.setDoc.length === 1 && w.path.join('/') === 'companies/co-a/subJobs/L1');
    ok('the doc carries the sub, basis, whole-cent rate, quantity and agreed total', w.data.subId === 's1' && w.data.basis === 'sq' && w.data.rateCents === 8500 && w.data.qty === 32 && w.data.agreedCents === 272000 && w.data.noSubNeeded === false);
    ok('updatedBy is the writer and updatedAt is a server timestamp (the rule requires both)', w.data.updatedBy === 'co-a' && w.data.updatedAt === 'SERVER_TS');
    ok('every key the UI writes is inside the rules allowlist', Object.keys(w.data).every((k) => RULE_KEYS.indexOf(k) !== -1));
    const lu = e.calls.updateDoc[0];
    ok('the sub is also put on the lead so the calendar lanes see it', !!lu && lu.path.join('/') === 'leads/L1' && lu.data.subId === 's1' && lu.data.crew === 'Mike Ruiz');
    ok('PRIVACY: the lead update carries no money key at all', Object.keys(lu.data).sort().join(',') === 'crew,subId,updatedAt');
    ok('after saving, the job leaves the "no sub" bucket', /No sub on the job <span class="sp-count">0<\/span>/.test(e.html()));
  }

  console.log('4. other saves and refusals');
  {
    const e = makeEnv({ roster, leads: [lead('L1'), lead('L2')] });
    e.fire('nbd:data-refreshed'); await tick();
    const none = fakeForm('L1', { sub: '', card: '', basis: 'sq', rate: '', qty: '', total: '', note: 'customer did it', none: true });
    e.click('save', {}, none); await tick();
    const d = e.calls.setDoc[0] && e.calls.setDoc[0].data;
    ok('"No sub needed" saves the flag and a note, with no sub and no money', !!d && d.noSubNeeded === true && d.subId === undefined && d.agreedCents === undefined && d.note === 'customer did it');
    ok('"No sub needed" does not touch the lead', e.calls.updateDoc.length === 0);

    const e2 = makeEnv({ roster, leads: [lead('L1')] });
    e2.fire('nbd:data-refreshed'); await tick();
    const bad = fakeForm('L1', { sub: '', card: '', basis: 'sq', rate: '85', qty: '3', total: '255', note: '', none: false });
    e2.click('save', {}, bad); await tick();
    ok('no sub and not "no sub needed": nothing is written, and it says why', e2.calls.setDoc.length === 0 && /Pick a sub/.test(bad.msg.textContent));
    const big = fakeForm('L1', { sub: 's1', card: '', basis: 'job', rate: '', qty: '', total: '1000000', note: '', none: false });
    e2.click('save', {}, big); await tick();
    ok('an agreed total over $999,999.99 is refused before it reaches the rule', e2.calls.setDoc.length === 0 && /over the limit/.test(big.msg.textContent));
    const badQty = fakeForm('L1', { sub: 's1', card: '', basis: 'sq', rate: '85', qty: '-4', total: '100', note: '', none: false });
    e2.click('save', {}, badQty); await tick();
    ok('a negative quantity is refused', e2.calls.setDoc.length === 0 && /Quantity/.test(badQty.msg.textContent));
    const ok1 = fakeForm('L1', { sub: 's2', card: '', basis: 'job', rate: '350', qty: '', total: '350', note: '', none: false });
    e2.click('save', {}, ok1); await tick();
    ok('control: a flat-per-job save with no quantity goes through', e2.calls.setDoc.length === 1 && e2.calls.setDoc[0].data.basis === 'job' && e2.calls.setDoc[0].data.qty === undefined);
  }

  console.log('5. the rate card and the scorecard');
  {
    const e = makeEnv({ roster, leads: [lead('L1')] });
    e.fire('nbd:data-refreshed'); await tick();
    e.click('edit', { 'data-id': 'L1' });
    const form = fakeForm('L1', { sub: 's1', card: '0', basis: 'job', rate: '', qty: '20', total: '', note: '', none: false });
    fireChange(e, form, 'card', '0');
    ok('picking a rate-card entry fills the basis and rate, then the total (85 x 20 = 1700)', form.fields.basis.value === 'sq' && form.fields.rate.value === '85.00' && form.fields.total.value === '1700.00');
    e.click('view', { 'data-view': 'score' });
    ok('the scorecard lists each roster sub', /Mike Ruiz/.test(e.html()) && /Sam Lee/.test(e.html()) && /No per-SQ jobs yet/.test(e.html()));
  }

  console.log('7. estimated hours');
  {
    const BOOK = { 'BOOK:replacement': { hoursPerUnit: 1.25 }, 'BOOK:repair': { hoursPerUnit: 6 } };
    const L1 = lead('L1', { primaryEstimateId: 'E1' });
    const EST = { E1: { workKind: 'replacement', sq: 30, pl: 6 }, E2: { workKind: null, sq: 30 }, E3: { workKind: 'repair' } };
    const mk = (over) => makeEnv(Object.assign({ roster, leads: [L1], hours: true, hoursFlag: true, book: BOOK, estimates: EST }, over || {}));
    const go = async (e, id) => { e.fire('nbd:data-refreshed'); await tick(); e.click('hours', { 'data-id': id || 'L1' }); await tick(); return e.html(); };

    const e = mk();
    e.fire('nbd:data-refreshed'); await tick();
    ok('the Estimate hours button shows when the flag, the book and the logic are all there', /data-sjb-action="hours"/.test(e.html()));
    const h = await go(mk());
    ok('a replacement: 30 SQ x the 1.25 book time = 37.5 man-hours', /About 37\.5 man-hours for 30 SQ of roof replacement/.test(h));
    ok('with no crew size on the sub it says the default was used', /crew of 3 \(the usual default: set it on the sub\)/.test(h) && /1\.6 crew-days/.test(h) && /book 2 days/.test(h));
    const rd = mk(); await go(rd);
    ok('exactly one read, of estimates/E1', rd.calls.estReads.length === 1 && rd.calls.estReads[0] === 'estimates/E1');

    const crew = await go(mk({ roster: [Object.assign({}, roster[0], { crewSize: 5 }), roster[1]], leads: [lead('L1', { primaryEstimateId: 'E1', subId: 's1' })] }));
    ok('a sub with a crew size uses it and does not say "default"', /crew of 5/.test(crew) && !/usual default/.test(crew) && /0\.9 crew-days/.test(crew) && /book 1 day\./.test(crew));

    const rep = await go(mk({ leads: [lead('L1', { primaryEstimateId: 'E3' })], estimates: Object.assign({}, EST, { E3: { workKind: 'repair', sq: 500 } }) }));
    ok('a repair is one job: 6 man-hours whatever the squares', /About 6 man-hours for 1 job of repair/.test(rep));

    const nb = await go(mk({ book: {} }));
    ok('no book time for the job type says so and shows no number', /No book time for roof replacement yet/.test(nb) && !/man-hours for/.test(nb));
    const nk = await go(mk({ leads: [lead('L1', { primaryEstimateId: 'E2' })] }));
    ok('an estimate that does not say repair or replacement gets a reason, not a guess', /repair or a replacement/.test(nk) && !/man-hours for/.test(nk));
    const ne = await go(mk({ leads: [lead('L1')] }));
    ok('a job with no estimate says so (and reads nothing)', /no estimate yet/.test(ne));
    const gone = await go(mk({ estimates: {} }));
    ok('an estimate that cannot be found says so', /could not be found/.test(gone));
    const fail = await go(mk({ estFail: true }));
    ok('a failed read says so, never a number', /Could not read the estimate/.test(fail) && !/man-hours for/.test(fail));

    const off = mk({ hoursFlag: false }); off.fire('nbd:data-refreshed'); await tick();
    ok('the laborHoursBook flag off: no button', !/data-sjb-action="hours"/.test(off.html()));
    const nl = makeEnv({ roster, leads: [L1], hoursFlag: true, estimates: EST }); nl.fire('nbd:data-refreshed'); await tick();
    ok('control: without the hours logic and book loaded there is no button, and the board still works', !/data-sjb-action="hours"/.test(nl.html()) && /Sub job board/.test(nl.html()));
    const line = (/<div class="sp-sub" role="status">([^<]*)<\/div>/.exec(h) || [])[1] || '';
    ok('PRIVACY: the hours line itself is found and carries no money word or figure', /man-hours/.test(line) && !/\$|price|total|rate|margin|cost|paid|agreed/i.test(line));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
