/**
 * tests/review-paid-in-full-2026-10-03.test.js
 *
 * Jo, 2026-10-03 — two decisions:
 *
 *  A. Review requests wait until the job is PAID IN FULL, and carry the
 *     homeowner's referral link in the same message. Before: the ask fired at
 *     ANY won stage (Install Done, Final Photos — before the money) and the
 *     referral code was a separate tap; prod had 0 of 36 won/paid jobs asked.
 *       functions/paid-in-full.js        the one rule (server)
 *       docs/pro/js/review-engine.js     its byte-identical copy (client):
 *                                        the bell, the review message
 *       docs/pro/js/review-deck.js       the deck + Home count
 *       functions/review-request-nudge.js the morning rep digest
 *       functions/job-spine.js           the "⭐ Request Review" task at
 *                                        Final Payment when paid in full
 *       functions/referrals.js           honours the referrer's own code
 *
 *  B. In-person signing moves the card: document-generator.js calls
 *     recordInPersonSignature after saving the signed contract; the server
 *     re-reads lead + document and records contract_signed through the
 *     spine — which also makes #2131's deposit draft fire.
 *       functions/in-person-signing.js
 *
 * Every send here goes to a stub. Nothing reaches a network.
 * Run: node tests/review-paid-in-full-2026-10-03.test.js   (needs functions/ deps)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function tryReq(p) { try { return require(path.join(ROOT, p)); } catch (e) { console.log('  (cannot load ' + p + ': ' + e.message + ')'); return null; } }

const PIF = tryReq('functions/paid-in-full.js');
const OWED = tryReq('functions/invoice-owed.js');
const RN = (tryReq('functions/review-request-nudge.js') || {})._test;
const SPINE = tryReq('functions/job-spine.js');
const IPS = tryReq('functions/in-person-signing.js');
const REFS = tryReq('functions/referrals.js');

const DAY = 86400000;
const NOW = Date.parse('2026-10-03T15:00:00Z');
const ago = (d) => NOW - d * DAY;

// ── fixtures ─────────────────────────────────────────────────────────────
const leadOf = (o) => Object.assign({ userId: 'u1', companyId: 'u1', firstName: 'Pat', lastName: 'Jones', phone: '5135550142', email: 'pat@x.test', address: '1 Main St, Mason, OH 45040', jobType: 'cash' }, o || {});
const paidInv = (o) => Object.assign({ leadId: 'L1', companyId: 'u1', status: 'paid', total: 15000, balanceDue: 0, paidAt: ago(1) }, o || {});
const owedInv = (o) => Object.assign({ leadId: 'L1', companyId: 'u1', status: 'sent', total: 15000, balanceDue: 7500 }, o || {});

function block(src, name) {
  const s = lf(src);
  const a = s.indexOf('// nbd:' + name + ':start');
  const b = s.indexOf('// nbd:' + name + ':end');
  return (a < 0 || b < 0) ? null : s.slice(a, b);
}

// ── fake Firestore (deposit-draft test's, + ref.create, + 'in' filters) ──
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const writes = [];
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const val = (v, cur) => {
    if (v === '__TS__') return NOW;
    if (v && v.__union) return (Array.isArray(cur) ? cur : []).concat(v.__union);
    if (v && v.__inc) return (Number(cur) || 0) + v.__inc;
    return v;
  };
  const apply = (cur, patch) => { const d = Object.assign({}, cur); for (const k of Object.keys(patch)) d[k] = val(patch[k], d[k]); return d; };
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    parent: { parent: { id: p.split('/').slice(-3)[0] } },
    collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => (d === undefined ? undefined : clone(d)) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); writes.push(['update', p, patch]); store.set(p, apply(store.get(p), patch)); },
    async set(data) { writes.push(['set', p, data]); store.set(p, clone(data)); },
    async create(data) { if (store.has(p)) { const e = new Error('ALREADY_EXISTS ' + p); e.code = 6; throw e; } writes.push(['create', p, data]); store.set(p, clone(data)); },
  });
  const query = (c, filters, lim, group) => ({
    where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim, group),
    limit: (n) => query(c, filters, n, group),
    async get() {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (group) { if (parts.length < 2 || parts[parts.length - 2] !== c) continue; }
        else if (parts.length !== c.split('/').length + 1 || !k.startsWith(c + '/')) continue;
        if (filters.every(([f, op, val2]) => (op === 'in' ? val2.includes(v[f]) : v[f] === val2))) docs.push(Object.assign(ref(k), { data: () => clone(v), ref: ref(k) }));
      }
      const out = docs.slice(0, lim || docs.length);
      return { docs: out, empty: out.length === 0, size: out.length };
    },
  });
  const col = (c) => Object.assign({ doc: (id) => ref(c + '/' + (id || ('auto' + Math.random().toString(36).slice(2, 8)))), async add(d) { const id = 'auto' + (writes.length + 1); writes.push(['add', c + '/' + id, d]); store.set(c + '/' + id, clone(d)); return ref(c + '/' + id); } }, query(c, [], 0));
  return {
    store, writes, collection: col, doc: (p) => ref(p), collectionGroup: (n) => query(n, [], 0, true),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(),
        create: (r, d) => pending.push(() => { if (store.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push(['create', r.path, d]); store.set(r.path, clone(d)); }),
        set: (r, d) => pending.push(() => { writes.push(['set', r.path, d]); store.set(r.path, clone(d)); }),
        update: (r, p) => pending.push(() => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); writes.push(['update', r.path, p]); store.set(r.path, apply(store.get(r.path), p)); }),
      };
      const out = await fn(tx);
      pending.forEach((f) => f());
      return out;
    },
  };
}
const FV = { serverTimestamp: () => '__TS__', arrayUnion: (...x) => ({ __union: x }), increment: (n) => ({ __inc: n }) };
const quiet = { info() {}, warn() {}, error() {} };
const deps = { FieldValue: FV, logger: quiet, now: () => NOW };

// ── the client, in a sandbox ─────────────────────────────────────────────
// review-engine.js + collected-revenue.js (its owed rule) + review-deck.js,
// with every Firestore / send call recorded and nothing sent.
function loadClient({ leads, invoices, brand }) {
  const rec = { added: [], updated: [], sms: [], email: [], toasts: [] };
  const win = {
    _leads: leads, _user: { uid: 'u1' }, db: {},
    _brand: () => brand || { legalName: 'No Big Deal Home Solutions' },
    doc: (db, ...p) => ({ path: p.join('/') }),
    collection: (db, ...p) => ({ path: p.join('/') }),
    query: (c) => c, where: () => null,
    getDoc: async (r) => ({ exists: () => /^users\//.test(r.path), data: () => ({ googleReviewUrl: 'https://g.page/r/nbd-test/review' }) }),
    getDocs: async () => ({ empty: true, docs: [] }),
    addDoc: async (c, d) => { rec.added.push([c.path, d]); return { id: 'a' + rec.added.length }; },
    updateDoc: async (r, d) => { rec.updated.push([r.path, d]); },
    serverTimestamp: () => '__TS__',
    addEventListener() {}, dispatchEvent() {},
    NBDComms: {
      sendSMS: async (o) => { rec.sms.push(o); return { success: true, mode: 'sent' }; },
      sendEmail: async (o) => { rec.email.push(o); return { success: true, mode: 'sent' }; },
    },
  };
  win.window = win;
  const sandbox = {
    window: win, console: { log() {}, warn() {}, error() {} },
    document: { addEventListener() {}, getElementById() { return null; } },
    localStorage: { getItem: () => null, setItem() {} },
    showToast: (m, k) => rec.toasts.push([m, k]),
    setTimeout: () => 0, clearTimeout() {}, CustomEvent: function () {},
    Date, Math, JSON, Promise, encodeURIComponent, URLSearchParams,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('docs/pro/js/collected-revenue.js'), sandbox, { filename: 'collected-revenue.js' });
  const real = win.NBDRevenue;
  win.NBDRevenue = Object.assign({}, real, { cached: () => invoices, loadInvoices: async () => invoices || [] });
  vm.runInContext(read('docs/pro/js/review-engine.js'), sandbox, { filename: 'review-engine.js' });
  vm.runInContext(read('docs/pro/js/review-deck.js'), sandbox, { filename: 'review-deck.js' });
  return { win, rec, RE: win.ReviewEngine, DECK: win.NBDReviewDeck };
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ═══ 1. one rule, two copies ═════════════════════════════════════════
  console.log('\n1. one paid-in-full rule (server + client copy)');
  {
    const a = block(read('functions/paid-in-full.js'), 'paid-in-full-rule');
    const b = block(read('docs/pro/js/review-engine.js'), 'paid-in-full-rule');
    ok('nbd:paid-in-full-rule is byte-identical in functions/paid-in-full.js and docs/pro/js/review-engine.js', !!a && a === b);
    ok('the server rule judges invoices with the shared owed rule (invoice-owed.js)', /require\('\.\/invoice-owed'\)/.test(read('functions/paid-in-full.js')));
  }

  // ═══ 2. the gate (pure) ═══════════════════════════════════════════════
  console.log('\n2. the gate — Jo\'s cases');
  if (PIF && OWED) {
    const pif = (lead, invs) => PIF.isPaidInFull(lead, invs, OWED.owedDollarsOf);
    ok('unpaid at Final Photos → no ask', !pif(leadOf({ stage: 'final_photos', stageRole: 'won' }), [owedInv()]));
    ok('…and Final Photos with nothing owing is STILL no ask (the job is not at Final Payment yet)', !pif(leadOf({ stage: 'final_photos', stageRole: 'won' }), []));
    ok('Install Done / Deductible → no ask', !pif(leadOf({ stage: 'install_complete', stageRole: 'won' }), []) && !pif(leadOf({ stage: 'deductible_collected', stageRole: 'won' }), []));
    ok('paid at Final Payment → ask', pif(leadOf({ stage: 'final_payment', stageRole: 'won' }), [paidInv()]));
    ok('Collections → no ask, even with nothing owing', !pif(leadOf({ stage: 'collections', stageRole: 'won' }), []) && !pif(leadOf({ stage: 'collections', stageRole: 'won' }), [paidInv()]));
    ok('Final Payment but an invoice still owes → no ask', !pif(leadOf({ stage: 'final_payment', stageRole: 'won' }), [paidInv(), owedInv()]));
    ok('a DRAFT invoice owes nothing (never sent) → still paid in full', pif(leadOf({ stage: 'final_payment', stageRole: 'won' }), [paidInv(), owedInv({ status: 'draft' })]));
    ok('a void Stripe mirror owes nothing', pif(leadOf({ stage: 'closed', stageRole: 'won' }), [{ status: 'void', balanceDue: 0, total: 900 }]));
    ok('Closed (and the legacy "Complete" / "Closed Won") count', pif(leadOf({ stage: 'closed' }), []) && pif(leadOf({ stage: 'Complete' }), []) && pif(leadOf({ stage: 'Closed Won' }), []));
    ok('a tenant CUSTOM won stage counts (persisted stageRole)', pif(leadOf({ stage: 'paid_and_done', stageRole: 'won' }), []));
    ok('a stale stageRole "won" on Collections does not sneak through', !pif(leadOf({ stage: 'collections', stageRole: 'won' }), []));
    ok('not-yet-won stages → no', !pif(leadOf({ stage: 'contract_signed', stageRole: 'active' }), []) && !pif(leadOf({ stage: 'install_in_progress', stageRole: 'job' }), []));
    ok('invoices not known (null) → not paid — never ask on a guess', !pif(leadOf({ stage: 'final_payment', stageRole: 'won' }), null));
    ok('deleted lead → no', !pif(leadOf({ stage: 'final_payment', stageRole: 'won', deleted: true }), []));
    const mine = PIF.invoicesForLead([paidInv(), owedInv({ companyId: 'other-co' }), owedInv({ leadId: 'L2' }), owedInv({ deleted: true })], leadOf(), 'L1');
    ok('invoicesForLead: another company\'s, another lead\'s and deleted invoices are not this customer\'s', mine.length === 1 && mine[0].status === 'paid');
    ok('invoicesForLead with a jobId: only that job\'s (and un-stamped) invoices', PIF.invoicesForLead([paidInv({ jobId: 'j2' }), owedInv({ jobId: 'j1' })], leadOf(), 'L1', 'j2').length === 1);
  } else ok('functions/paid-in-full.js + invoice-owed.js load', false);

  // ═══ 3. the morning rep digest (server) ═══════════════════════════════
  console.log('\n3. review-request-nudge: only paid-in-full jobs are due');
  if (RN) {
    const db = makeDb({
      'leads/A': leadOf({ lastName: 'FinalPhotos', stage: 'final_photos', stageRole: 'won', stageStartedAt: ago(10) }),
      'leads/B': leadOf({ lastName: 'PaidFinal', stage: 'final_payment', stageRole: 'won', stageStartedAt: ago(10) }),
      'invoices/ib': paidInv({ leadId: 'B', paidAt: ago(10) }),
      'leads/C': leadOf({ lastName: 'Owes', stage: 'final_payment', stageRole: 'won', stageStartedAt: ago(10) }),
      'invoices/ic': owedInv({ leadId: 'C' }),
      'leads/D': leadOf({ lastName: 'Collections', stage: 'collections', stageRole: 'won', stageStartedAt: ago(10) }),
      // Entered Final Payment 40 days ago; the last of the money landed 5 days ago.
      'leads/E': leadOf({ lastName: 'LatePay', stage: 'final_payment', stageRole: 'won', stageStartedAt: ago(40) }),
      'invoices/ie': paidInv({ leadId: 'E', paidAt: ago(5) }),
      // Another company's invoice stamped with this lead id must not block.
      'leads/F': leadOf({ lastName: 'Foreign', stage: 'closed', stageRole: 'won', stageStartedAt: ago(9) }),
      'invoices/if': owedInv({ leadId: 'F', companyId: 'someone-else' }),
    });
    const out = await RN.findReviewDueLeads(db, 'u1');
    const ids = out.map((e) => e.id).sort().join(',');
    ok('unpaid at Final Photos → no ask', !/A/.test(ids), ids);
    ok('paid at Final Payment → ask', /B/.test(ids), ids);
    ok('Final Payment with an invoice still owing → no ask', !/C/.test(ids), ids);
    ok('Collections → no ask', !/D/.test(ids), ids);
    ok('the window counts from when it became PAID (last payment 5 days ago), not stage entry 40 days ago', /E/.test(ids), ids);
    ok('another company\'s invoice on the same lead id does not block the ask', /F/.test(ids), ids);
    const html = typeof RN.buildEmailHtml !== 'function' ? '' : RN.buildEmailHtml({ firstName: 'Jo', dueLeads: out.map((l) => Object.assign({}, l)) });
    ok('the digest says paid in full and its drop-in script carries the referral link', /Paid in full/.test(html) && /referral link/.test(html));
    const failing = makeDb({ 'leads/B': leadOf({ stage: 'final_payment', stageRole: 'won', stageStartedAt: ago(10) }) });
    const rc = failing.collection.bind(failing);
    failing.collection = (c) => (c === 'invoices' ? { where: () => ({ get: async () => { throw new Error('unavailable'); } }) } : rc(c));
    ok('invoices unreadable → fail closed (no ask on a guess)', (await RN.findReviewDueLeads(failing, 'u1')).length === 0);
  } else ok('functions/review-request-nudge.js loads', false);

  // ═══ 4. the client: bell, message, deck ═══════════════════════════════
  console.log('\n4. client — the bell, the review message with the referral link, the deck');
  {
    const leads = [
      leadOf({ id: 'L1', customerId: 'NBD-0042', stage: 'final_payment', stageRole: 'won', stageStartedAt: { seconds: Math.floor(Date.now() / 1000) - 2 * 86400 } }),
      leadOf({ id: 'L2', firstName: 'Una', stage: 'final_photos', stageRole: 'won', stageStartedAt: { seconds: Math.floor(Date.now() / 1000) - 2 * 86400 } }),
      leadOf({ id: 'L3', firstName: 'Col', stage: 'collections', stageRole: 'won', stageStartedAt: { seconds: Math.floor(Date.now() / 1000) - 2 * 86400 } }),
      leadOf({ id: 'L4', firstName: 'Owen', stage: 'final_payment', stageRole: 'won', stageStartedAt: { seconds: Math.floor(Date.now() / 1000) - 2 * 86400 } }),
    ];
    const invoices = [paidInv({ leadId: 'L1' }), owedInv({ leadId: 'L4' })];
    const { win, rec, RE, DECK } = loadClient({ leads, invoices });
    win.ReviewEngine.checkAutoReviews();
    await tick(); await tick();
    const bells = rec.added.filter(([p]) => p === 'notifications').map(([, d]) => d.leadId).sort().join(',');
    ok('the bell fires for the paid-in-full job only (not Final Photos, Collections or an owing invoice)', bells === 'L1', bells);
    ok('…and says paid in full', rec.added.some(([p, d]) => p === 'notifications' && /paid in full/.test(d.message)));
    const deck = DECK.candidates(leads, 'u1').map((l) => l.id).join(',');
    ok('review deck / Home count: the paid-in-full job only', deck === 'L1', deck);
    ok('deck with invoices not loaded yet → nobody (no ask on a guess)', DECK.candidates(leads, 'u1', Date.now(), null).length === 0);

    await RE.sendReviewSMS('L1');
    const sms = rec.sms[0] || {};
    ok('the review SMS goes through the platform sender (stub) with the Google review link', sms.source === 'review_request' && /https:\/\/g\.page\/r\/nbd-test\/review/.test(sms.message || ''));
    const m = /https:\/\/nobigdealwithjoedeal\.com\/pro\/refer\.html\?ref=NBD-0042&code=([A-Z0-9-]+)/.exec(sms.message || '');
    ok('…and the homeowner\'s referral link IN THE SAME MESSAGE, keyed by their customer id + code', !!m, sms.message);
    const minted = rec.added.find(([p]) => p === 'referrals');
    ok('…the code is the existing generator\'s (minted once into referrals/, stamped on the lead)', !!minted && m && minted[1].code === m[1] && minted[1].referrerLeadId === 'L1'
      && rec.updated.some(([p, d]) => p === 'leads/L1' && d.referralCode === m[1]));
    ok('…minting inside the review send shows no extra "Referral code" toast', !rec.toasts.some(([t]) => /Referral code:/.test(t)));
    const BAD = /\$\s?\d|bonus|reward|gift card|discount|incentive|claim|insurance|deductible|adjuster/i;
    ok('Google policy + Kentucky: no incentive, no claim or deductible wording in the review SMS', !BAD.test(sms.message || ''), (sms.message || '').match(BAD) && (sms.message || '').match(BAD)[0]);
    await RE.sendReviewEmail('L1');
    const em = rec.email[0] || {};
    ok('the review EMAIL carries the same referral link (same code, no second mint)', em.kind === 'review_request' && m && (em.html || '').indexOf('ref=NBD-0042&amp;code=' + m[1]) >= 0
      && rec.added.filter(([p]) => p === 'referrals').length === 1, em.html);
    ok('…and no incentive / claim wording in the email either', !BAD.test(em.html || ''));
    const tenant = loadClient({ leads: [leadOf({ id: 'T1', stage: 'closed', stageRole: 'won' })], invoices: [], brand: { legalName: 'Oak Roofing LLC' } });
    await tenant.RE.sendReviewSMS('T1');
    ok('a tenant\'s link names THEIR company (&co=) and keys by lead id when no customer id', /refer\.html\?ref=T1&code=[A-Z0-9-]+&co=Oak%20Roofing%20LLC/.test((tenant.rec.sms[0] || {}).message || ''));
  }

  // ═══ 5. the spine's Request Review task ═══════════════════════════════
  console.log('\n5. job spine — "⭐ Request Review" at Final Payment when paid in full');
  if (SPINE) {
    const TASK = 'leads/L1/tasks/stage-final_payment-request_review';
    {
      const db = makeDb({ 'leads/L1': leadOf({ stage: 'final_photos', stageRole: 'won' }), 'invoices/i1': paidInv() });
      const r = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'paid_in_full', sourceId: 'i1', actor: 'payment recorded (zelle)' }, deps);
      const t = db.store.get(TASK);
      ok('paid in full: the card moves to Final Payment AND the Request Review task is created', r.moved === true && r.to === 'final_payment' && r.reviewTask && (r.reviewTask || {}).created === true
        && t && t.title === 'Request Review' && t.actionId === 'request_review' && t.done === false && t.stageKey === 'final_payment', JSON.stringify(r.reviewTask));
      ok('…alongside the stage\'s own entry task (Warranty Certificate)', db.store.has('leads/L1/tasks/stage-final_payment-warranty_cert'));
      ok('the spine sends nothing — only the lead, marker, note and tasks were written',
        db.writes.every((w) => /^(leads\/L1(\/tasks\/[^/]+)?|job_events\/[^/]+|notes\/[^/]+)$/.test(w[1])), JSON.stringify(db.writes.map((w) => w[1])));
      db.store.set(TASK, Object.assign({}, db.store.get(TASK), { done: true }));
      const again = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'paid_in_full', sourceId: 'i1' }, deps);
      ok('a redelivered payment never reopens a finished task', again.duplicate === true && db.store.get(TASK).done === true && (again.reviewTask || {}).created === false);
    }
    {
      const db = makeDb({ 'leads/L1': leadOf({ stage: 'final_photos', stageRole: 'won' }), 'invoices/i1': paidInv(), 'invoices/i2': owedInv() });
      const r = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'paid_in_full', sourceId: 'i1' }, deps);
      ok('one invoice paid, another still owing → no Request Review task', r.reviewTask && (r.reviewTask || {}).created === false && (r.reviewTask || {}).reason === 'balance_owed' && !db.store.has(TASK));
    }
    {
      const db = makeDb({ 'leads/L1': leadOf({ stage: 'final_payment', stageRole: 'won' }), 'invoices/i1': paidInv() });
      const r = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'paid_in_full', sourceId: 'i1' }, deps);
      ok('card already dragged to Final Payment, then the money cleared → the task still comes', r.moved === false && (r.reviewTask || {}).created === true && db.store.has(TASK));
    }
    {
      const db = makeDb({ 'leads/L1': leadOf({ stage: 'service_approved', jobType: 'service' }), 'invoices/i1': paidInv() });
      const r = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'paid_in_full', sourceId: 'i1' }, deps);
      ok('a paid repair the spine may not move (service track) → no task until Jo closes it', (r.reviewTask || {}).created === false && (r.reviewTask || {}).reason === 'not_paid_stage');
    }
    {
      const db = makeDb({ 'leads/L1': leadOf({ stage: 'final_photos', stageRole: 'won', activeJobId: 'j2' }), 'invoices/i1': paidInv({ jobId: 'j2' }) });
      const r = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'paid_in_full', sourceId: 'i1' }, deps);
      ok('multi-job: the task is per job (a second job gets its own)', (r.reviewTask || {}).created === true && (r.reviewTask || {}).taskId === 'stage-final_payment-request_review-j2');
    }
    {
      const db = makeDb({ 'leads/L1': leadOf({ stage: 'final_photos', stageRole: 'won', reviewAskDeclined: true }), 'invoices/i1': paidInv() });
      const r = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'paid_in_full', sourceId: 'i1' }, deps);
      ok('"Don\'t ask this one" stands — no task', (r.reviewTask || {}).created === false && (r.reviewTask || {}).reason === 'declined');
    }
    {
      const db = makeDb({ 'leads/L1': leadOf({ stage: 'estimate_sent_cash', primaryEstimateId: 'E1' }) });
      const r = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'booked', sourceId: 'b1' }, Object.assign({ depositDraft: false }, deps));
      ok('other events never make the task', r.reviewTask === undefined);
    }
  } else ok('functions/job-spine.js loads', false);

  // ═══ 6. recordInPersonSignature ═══════════════════════════════════════
  console.log('\n6. recordInPersonSignature — in-person signing moves the card');
  if (IPS) {
    const H = IPS._test.handleInPersonSignature;
    const signed = (o) => Object.assign({ type: 'contract', status: 'signed', signedAt: '2026-10-03T15:00:00Z',
      signers: [{ role: 'homeowner', required: true }, { role: 'contractor', required: true }],
      signedSigners: [{ role: 'homeowner', signedAt: 1 }, { role: 'contractor', signedAt: 2 }] }, o || {});
    const perSq = { leadId: 'L1', userId: 'u1', priceMode: 'per-sq', prices: { good: 12000, better: 15000, best: 18000 }, selectedTier: 'better', grandTotal: 15000, taxRate: 0, mode: 'cash' };
    const seed = () => ({
      'leads/L1': leadOf({ stage: 'estimate_sent_cash', primaryEstimateId: 'E1' }),
      'estimates/E1': perSq,
      'leads/L1/documents/d1': signed(),
    });
    const refusal = async (p) => { try { await p; return null; } catch (e) { return e; } };
    const me = { uid: 'u1', token: {} };

    const run = IPS.recordInPersonSignature && IPS.recordInPersonSignature.run;
    if (typeof run === 'function') {
      const v = await refusal(run({ auth: { uid: 'u9', token: { role: 'viewer', companyId: 'u1' } }, data: { leadId: 'L1', docId: 'd1' } }));
      ok('viewer → refused "Your role is view-only" (the deployed handler)', v && v.code === 'permission-denied' && /view-only/.test(v.message));
      const u = await refusal(run({ auth: null, data: { leadId: 'L1', docId: 'd1' } }));
      ok('signed out → unauthenticated (the deployed handler)', u && u.code === 'unauthenticated');
    } else ok('onCall exposes .run for the handler', false);

    const e1 = await refusal(H(makeDb(seed()), { uid: '' }, { leadId: 'L1', docId: 'd1' }, deps));
    ok('no uid → unauthenticated', e1 && e1.code === 'unauthenticated');
    {
      const db = makeDb(seed());
      const e = await refusal(H(db, { uid: 'u2', token: { companyId: 'other-co', role: 'sales_rep' } }, { leadId: 'L1', docId: 'd1' }, deps));
      ok('another company\'s lead → permission-denied, nothing written', e && e.code === 'permission-denied' && db.writes.length === 0);
    }
    {
      const db = makeDb(seed());
      const r = await H(db, { uid: 'u3', token: { companyId: 'u1', role: 'sales_rep' } }, { leadId: 'L1', docId: 'd1' }, deps);
      ok('a teammate in the SAME company may record it', r.ok === true && r.moved === true);
    }
    for (const [label, doc] of [
      ['a draft (never signed)', signed({ status: 'draft' })],
      ['status says signed but no signedAt', signed({ signedAt: null })],
      ['no signer on record', signed({ signedSigners: [] })],
      ['the homeowner (a REQUIRED signer) never signed', signed({ signedSigners: [{ role: 'contractor', signedAt: 2 }] })],
    ]) {
      const db = makeDb(Object.assign(seed(), { 'leads/L1/documents/d1': doc }));
      const e = await refusal(H(db, me, { leadId: 'L1', docId: 'd1' }, deps));
      ok('unsigned doc refused: ' + label, e && e.code === 'failed-precondition' && db.store.get('leads/L1').stage === 'estimate_sent_cash' && db.writes.length === 0);
    }
    {
      const db = makeDb(seed());
      const e = await refusal(H(db, me, { leadId: 'L1', docId: 'nope' }, deps));
      ok('a document that is not under this lead → not-found', e && e.code === 'not-found');
      const bad = await refusal(H(db, me, { leadId: 'L1/../x', docId: 'd1' }, deps));
      ok('malformed ids → invalid-argument', bad && bad.code === 'invalid-argument');
    }
    {
      const db = makeDb(Object.assign(seed(), { 'leads/L1/documents/d2': signed({ type: 'certificate_of_completion' }) }));
      const r = await H(db, me, { leadId: 'L1', docId: 'd2' }, deps);
      ok('a signed completion certificate is not a contract signing → skipped, card untouched', r.skipped === 'not_a_contract' && db.store.get('leads/L1').stage === 'estimate_sent_cash');
    }
    {
      const db = makeDb(seed());
      const r = await H(db, me, { leadId: 'L1', docId: 'd1' }, deps);
      const lead = db.store.get('leads/L1');
      const invs = [...db.store.keys()].filter((k) => /^invoices\//.test(k));
      ok('signed contract → the card moves to Contract Signed', r.ok === true && r.moved === true && r.to === 'contract_signed' && lead.stage === 'contract_signed');
      ok('…through the spine: marker keyed doc_<docId> (the same id remote signing uses)', db.store.has('job_events/L1__contract_signed__doc_d1'));
      ok('…and #2131\'s deposit draft fires for an in-person signing (one DRAFT, never sent)', r.depositDraft && r.depositDraft.created === true && invs.length === 1 && db.store.get(invs[0]).status === 'draft');
      const again = await H(db, me, { leadId: 'L1', docId: 'd1' }, deps);
      ok('idempotent: the same document again → duplicate, no second move, still one invoice',
        again.ok === true && again.duplicate === true && again.moved === false && [...db.store.keys()].filter((k) => /^invoices\//.test(k)).length === 1);
      ok('nothing was sent: only the lead, marker, note, tasks and the draft invoice were written',
        db.writes.every((w) => /^(leads\/L1(\/tasks\/[^/]+)?|job_events\/[^/]+|notes\/[^/]+|invoices\/[^/]+)$/.test(w[1])), JSON.stringify(db.writes.map((w) => w[1])));
    }
  } else ok('functions/in-person-signing.js loads (recordInPersonSignature exists)', false);

  // ═══ 7. the client call after an in-person signing ═══════════════════
  console.log('\n7. document-generator — calls recordInPersonSignature after saving; never blocks');
  {
    const SRC_DG = read('docs/pro/js/document-generator.js');
    const SRC_T = read('docs/pro/js/document-generator-templates.js');
    async function signInPerson(callable) {
      const rec = { calls: [], toasts: [], updates: [], viewer: null };
      const win = {
        _brand: () => ({ legalName: 'No Big Deal Home Solutions' }), _companyProfileLoaded: true, _user: { uid: 'u1', email: 'jo@x.test' },
        db: {}, storage: {}, ref: () => ({}), uploadBytes: async () => ({}),
        collection: (db, ...p) => ({ path: p.join('/') }), doc: (db, ...p) => ({ path: p.join('/') }),
        addDoc: async () => ({ id: 'docAbc' }), updateDoc: async (r, d) => { rec.updates.push([r && r.path, d]); },
        setDoc: async () => {}, serverTimestamp: () => '__TS__', getDocs: async () => ({ docs: [], empty: true }),
        NBDDocViewer: { open: (o) => { rec.viewer = o; } },
        _functions: {}, _httpsCallable: (f, name) => async (data) => { rec.calls.push([name, data]); return callable(data); },
      };
      win.window = win;
      const el = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
      const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: el, body: el() },
        console: { log() {}, warn() {}, error() {} }, showToast: (m, k) => rec.toasts.push([m, k]), Blob: function () {},
        setTimeout, clearTimeout, Date, Math, JSON, Promise };
      vm.createContext(sb);
      vm.runInContext(SRC_DG, sb, { filename: 'document-generator.js' });
      vm.runInContext(SRC_T, sb, { filename: 'document-generator-templates.js' });
      await win.NBDDocGen.generate('contract', { leadId: 'L1', homeownerName: 'Pat Jones', address: '1 Main St, Mason, OH 45040', contractPrice: '$15,000.00',
        signers: [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'contractor', label: 'Contractor', required: true }] });
      if (!rec.viewer) return rec;
      await rec.viewer.onPersistFinalized('<html>signed</html>', [{ role: 'homeowner', png: 'data:x', signedAt: 1 }, { role: 'contractor', png: 'data:y', signedAt: 2 }]);
      return rec;
    }
    const good = await signInPerson(() => ({ data: { ok: true, moved: true, to: 'contract_signed' } }));
    ok('the generator opened the viewer for an in-person contract', !!good.viewer);
    const saved = good.updates.findIndex(([, d]) => d && d.status === 'signed');
    ok('after the signed contract is saved, recordInPersonSignature is called with the lead + the saved document id',
      saved >= 0 && good.calls.length === 1 && good.calls[0][0] === 'recordInPersonSignature' && good.calls[0][1].leadId === 'L1' && good.calls[0][1].docId === 'docAbc', JSON.stringify(good.calls));
    ok('…and the rep is told the card moved', good.toasts.some(([m]) => /card moved to Contract Signed/.test(m)));
    let threw = null; let bad = null;
    try { bad = await signInPerson(() => { throw new Error('internal'); }); } catch (e) { threw = e; }
    ok('a failed call never blocks signing: the contract is still saved, the flow does not throw', !threw && bad && bad.updates.some(([, d]) => d && d.status === 'signed'), threw && threw.message);
    ok('…it logs and shows a toast telling the rep to move the card by hand', bad && bad.toasts.some(([m, k]) => /did not move/.test(m) && k === 'warning'));
  }

  // ═══ 8. the refer page honours only the referrer's own code ══════════
  console.log('\n8. submitReferral — the code on the link attributes only to its own referrer');
  if (REFS && REFS._ownReferralCode) {
    const db = makeDb({ 'referrals/r1': { code: 'PAT-AB12', referrerLeadId: 'L1', userId: 'u1' }, 'referrals/r2': { code: 'SAM-CD34', referrerLeadId: 'L9', userId: 'u1' } });
    ok('this referrer\'s own code → stamped', await REFS._ownReferralCode(db, 'pat-ab12', { id: 'L1' }) === 'PAT-AB12');
    ok('someone else\'s code on this referrer\'s link → dropped', await REFS._ownReferralCode(db, 'SAM-CD34', { id: 'L1' }) === null);
    ok('malformed / missing code → dropped', await REFS._ownReferralCode(db, '<b>x', { id: 'L1' }) === null && await REFS._ownReferralCode(db, '', { id: 'L1' }) === null);
    const ref = read('docs/pro/js/refer.js');
    ok('refer.js forwards ?code= to submitReferral', /get\('code'\)/.test(ref) && /code \? \{ code \} : \{\}/.test(ref));
  } else ok('functions/referrals.js exports _ownReferralCode', false);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
