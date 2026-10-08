/**
 * tests/signed-price-r6-2026-10-07.test.js
 *
 * Review round 6, R6-2-2 + R6-2-5, fixed to Jo's rules (2026-10-07):
 *   - A signed estimate stays editable, but the SIGNED price wins on every
 *     bill (deposit draft, final draft, invoice, portal card, Stripe — which
 *     charges the invoice) until the homeowner re-signs.
 *   - A stale deal-room price is blocked server-side: an estimate re-saved
 *     after the link was issued can't be accepted at the old price; the
 *     homeowner gets the current price and must confirm it.
 *
 * Worked example (R6): signed $14,500, estimate re-saved at $16,200. Before:
 * the portal said "✓ Signed $16,200" and the install-day final draft billed
 * +$1,700 ("Less deposit invoiced −$14,500"). After: every bill is $14,500.
 *
 * Behaviour over the REAL modules:
 *   A. customer-estimate-rows.js signed-price helpers (both byte-identical copies)
 *   B. signed-price.js planSignedStamp / checkDealPrice
 *   C. the job spine end to end on a fake transactional Firestore: signing
 *      stamps the price, then the deposit draft and (after a re-price) the
 *      final draft
 *   D. the CRM invoice + "Paid in full?" (docs/pro/js/invoice-pipeline.js)
 *   E. the portal card's price (portal.js reads signed-price.js portalPriced)
 *   F. the deal room: submitDealAcceptance + createDealAcceptToken run for
 *      real (firebase-admin replaced by an in-memory fake)
 *   G. e-sign: a signed estimate re-sends only to re-sign a revision; the
 *      envelope keeps the price it printed
 *
 * Run: node tests/signed-price-r6-2026-10-07.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');
const c = (n) => Math.round(Number(n) * 100);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function req(p) {
  try { return require(path.join(ROOT, p)); }
  catch (e) { ok('loads ' + p, false, e && e.message); return null; }
}
// Comments stripped so a source check can't pass on its own prose.
function code(p) { return lf(read(p)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1'); }

const CER = req('functions/customer-estimate-rows.js');
const CERB = req('docs/pro/js/customer-estimate-rows.js');
const SP = req('functions/signed-price.js');
const D = req('functions/deposit-draft-logic.js');
const SPINE = req('functions/job-spine.js');

// NBD's own tenant: its cash deposit rule (50% at $2,000+) applies without a
// companyProfile (a new company's neutral default takes no deposit).
const U = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const NOW = Date.parse('2026-10-07T15:00:00Z');
const OH = '12 Main St, Milford, OH 45150';
const KY = '9 Dixie Hwy, Florence, KY 41042';
const lead0 = { userId: U, companyId: U, primaryEstimateId: 'E1', address: OH, state: 'OH', activeJobId: 'J1', firstName: 'Pat', jobType: 'cash', stage: 'estimate_sent' };
const signedEst = () => ({ userId: U, companyId: U, leadId: 'L1', grandTotal: 14500, subtotal: 14500, tax: 0, taxRate: 0, mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1,
  rows: [{ desc: 'Roof', qty: '1', retailTotal: 14500, total: 14500 }] });
const reprice = (e) => Object.assign({}, e, { grandTotal: 16200, subtotal: 16200,
  rows: e.rows.concat([{ desc: 'Upgrade', qty: '1', retailTotal: 1700, total: 1700 }]) });

// ── fake transactional Firestore (the money-getting-paid test's, + where/limit/orderBy) ──
function makeDb(seed) {
  const clone = (d) => (d === undefined ? undefined : JSON.parse(JSON.stringify(d)));
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, clone(v)]));
  const writes = [];
  const isSentinel = (v) => v && typeof v === 'object' && (v.__ts || v.__union || v.__inc != null || v.__del);
  const apply = (cur, patch) => {
    const d = Object.assign({}, cur);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      const keys = k.split('.');
      let o = d;
      for (let i = 0; i < keys.length - 1; i++) { o[keys[i]] = Object.assign({}, o[keys[i]] || {}); o = o[keys[i]]; }
      const last = keys[keys.length - 1];
      if (v && v.__union) o[last] = (Array.isArray(o[last]) ? o[last] : []).concat(v.__union);
      else if (v && v.__inc != null) o[last] = (Number(o[last]) || 0) + v.__inc;
      else if (v && v.__del) delete o[last];
      else if (v && v.__ts) o[last] = NOW;
      else o[last] = isSentinel(v) ? null : clone(v);
    }
    return d;
  };
  let seq = 0;
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    collection: (cn) => col(p + '/' + cn),
    async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); writes.push(['update', p, patch]); store.set(p, apply(store.get(p), patch)); },
    async set(data, opt) { writes.push(['set', p, data]); store.set(p, opt && opt.merge ? apply(store.get(p) || {}, data) : apply({}, data)); },
    async create(data) { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push(['create', p, data]); store.set(p, apply({}, data)); },
  });
  const query = (cn, filters, lim) => ({
    where: (f, op, v) => query(cn, filters.concat([[f, op, v]]), lim),
    limit: (n) => query(cn, filters, n),
    orderBy: () => query(cn, filters, lim),
    async get() {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length !== cn.split('/').length + 1 || !k.startsWith(cn + '/')) continue;
        if (filters.every(([f, op, val]) => (op === 'in' ? val.indexOf(v[f]) !== -1 : v[f] === val))) docs.push({ id: parts[parts.length - 1], data: () => clone(v) });
      }
      const out = docs.slice(0, lim || docs.length);
      return { docs: out, empty: !out.length, size: out.length, forEach: (f) => out.forEach(f) };
    },
  });
  const col = (cn) => Object.assign({ doc: (id) => ref(cn + '/' + (id || ('auto' + (++seq)))), async add(d) { const r = ref(cn + '/auto' + (++seq)); await r.set(d); return r; } }, query(cn, [], 0));
  return {
    store, writes, collection: col, doc: (p) => ref(p),
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 1; attempt++) {
        const pending = [];
        const tx = {
          get: (r) => r.get(),
          create: (r, d) => pending.push(() => { if (store.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push(['create', r.path, d]); store.set(r.path, apply({}, d)); }),
          set: (r, d, opt) => pending.push(() => { writes.push(['set', r.path, d]); store.set(r.path, opt && opt.merge ? apply(store.get(r.path) || {}, d) : apply({}, d)); }),
          update: (r, p) => pending.push(() => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); writes.push(['update', r.path, p]); store.set(r.path, apply(store.get(r.path), p)); }),
        };
        const out = await fn(tx);
        const snap = new Map(store); const wlen = writes.length;
        try { pending.forEach((f) => f()); } catch (e) { store.clear(); snap.forEach((v, k) => store.set(k, v)); writes.length = wlen; throw e; }
        return out;
      }
    },
  };
}
const FV = { serverTimestamp: () => ({ __ts: true }), arrayUnion: (...x) => ({ __union: x }), increment: (n) => ({ __inc: n }), delete: () => ({ __del: true }) };
const quiet = { info() {}, warn() {}, error() {} };
const deps = { FieldValue: FV, logger: quiet, now: () => NOW };
// The Cloud Functions logger prints structured JSON lines (some say "failed" —
// best-effort storage steps the fakes don't serve). Keep them out of the output.
for (const m of ['log', 'info', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{') && a[0].includes('"severity"')) return; orig(...a); };
}

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\nA. the signed-price helpers (customer-estimate-rows.js)');
  ok('the browser and server copies are byte-identical', read('functions/customer-estimate-rows.js') === read('docs/pro/js/customer-estimate-rows.js'));
  if (CER && CERB) {
    const e1 = signedEst();
    const sp = { fields: CER.signedPriceSnapshot(e1), fingerprint: CER.pricedFingerprint(e1), totalCents: 1450000 };
    const signed = Object.assign({}, e1, { signedPrice: sp, signatureStatus: 'signed' });
    const edited = Object.assign(reprice(signed), { signedPrice: sp });
    ok('an unchanged signed estimate has no unsigned changes', CER.hasUnsignedChanges(signed) === false && CER.hasSignedPrice(signed));
    ok('re-priced to $16,200 after signing → unsigned changes', CER.hasUnsignedChanges(edited) === true);
    const v = CER.signedView(edited);
    ok('signedView: $14,500, the signed rows only, non-price fields kept',
      v.grandTotal === 14500 && v.rows.length === 1 && v.addr === OH && v.jobId === 'J1' && v.signedPrice === sp);
    ok('signedTotalCents = 1,450,000', CER.signedTotalCents(edited) === 1450000);
    ok('the browser copy agrees (same fingerprint, same view)', CERB.pricedFingerprint(edited) === CER.pricedFingerprint(edited) && CERB.signedView(edited).grandTotal === 14500);
    const added = Object.assign({}, signed, { lineItems: [{ description: 'Added later', total: 900 }] });
    ok('a field the signed copy did not have (lineItems added later) is removed from the bill view', !('lineItems' in CER.signedView(added)) && CER.hasUnsignedChanges(added));
    ok('no signed price → signedView returns the estimate itself', CER.signedView(e1) === e1 && CER.hasUnsignedChanges(e1) === false && CER.signedTotalCents(e1) === null);
    ok('fingerprint: key order does not matter; a Timestamp hashes as its millis',
      CER.pricedFingerprint({ grandTotal: 1, subtotal: 1, rows: [{ a: 1, b: 2 }] }) === CER.pricedFingerprint({ rows: [{ b: 2, a: 1 }], subtotal: 1, grandTotal: 1 })
      && CER.pricedFingerprint({ grandTotal: 1, claim: { deductible: 1000 } }) === CER.pricedFingerprint({ grandTotal: 1, claim: { deductible: 1000, carrier: 'Acme' } }));
    ok('fingerprint ignores non-price edits (notes, viewCount) and the derived deposit stamp',
      CER.pricedFingerprint(Object.assign({}, e1, { notes: 'x', viewCount: 9, depositPlan: { v: 1 } })) === CER.pricedFingerprint(e1));
    ok('claim: the signed deductible wins, the carrier stays as saved',
      CER.signedView(Object.assign({}, e1, { claim: { carrier: 'Acme', deductible: 2000 }, signedPrice: { fields: { grandTotal: 14500, claim: { deductible: 1000, acv: null } } } })).claim.deductible === 1000);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nB. signed-price.js — the stamp decision and the deal price check');
  if (SP && CER) {
    const lead = Object.assign({ id: 'L1' }, lead0);
    const st = SP.planSignedStamp({ leadId: 'L1', lead, est: signedEst(), estimateId: 'E1', event: 'contract_signed', sourceId: 'doc_1', nowMs: NOW });
    ok('a contract signing stamps the estimate at $14,500', st.action === 'stamp' && st.signedPrice.totalCents === 1450000 && st.signedPrice.sourceId === 'doc_1'
      && st.signedPrice.fingerprint === CER.pricedFingerprint(signedEst()));
    const stamped = Object.assign(signedEst(), { signedPrice: st.signedPrice });
    ok('the same source again → no second stamp', SP.planSignedStamp({ leadId: 'L1', lead, est: stamped, estimateId: 'E1', event: 'contract_signed', sourceId: 'doc_1' }).reason === 'already_stamped');
    ok('a replayed (duplicate) event never overwrites a stamp', SP.planSignedStamp({ leadId: 'L1', lead, est: stamped, estimateId: 'E1', event: 'contract_signed', sourceId: 'doc_old', duplicate: true }).reason === 'duplicate');
    const re = SP.planSignedStamp({ leadId: 'L1', lead, est: Object.assign(reprice(stamped), { signedPrice: st.signedPrice }), estimateId: 'E1', event: 'contract_signed', sourceId: 'env_2', nowMs: NOW });
    ok('a RE-SIGN (new source) stamps the revision: $16,200', re.action === 'stamp' && re.signedPrice.totalCents === 1620000);
    const env = { kind: 'estimate', estimateId: 'E1', pricedSnapshot: CER.signedPriceSnapshot(signedEst()) };
    const viaEnv = SP.planSignedStamp({ leadId: 'L1', lead, est: reprice(signedEst()), estimateId: 'E1', event: 'contract_signed', sourceId: 'env_1', envelope: env });
    ok('an envelope signs the price it PRINTED ($14,500) even if the estimate moved to $16,200 while the link was out',
      viaEnv.action === 'stamp' && viaEnv.signedPrice.totalCents === 1450000 && viaEnv.signedPrice.from === 'envelope');
    ok('another tenant\'s estimate is never stamped',
      SP.planSignedStamp({ leadId: 'L1', lead, est: Object.assign(signedEst(), { userId: 'x', companyId: 'x' }), estimateId: 'E1', event: 'contract_signed', sourceId: 's' }).reason === 'estimate_other_tenant');
    ok('a line-item acceptance only RECORDED at another price (R6-2-3, not this lane) is not stamped',
      SP.planSignedStamp({ leadId: 'L1', lead, est: Object.assign(signedEst(), { acceptedTier: 'good', acceptedPrice: 9500 }), estimateId: 'E1', event: 'deal_accepted', sourceId: 'deal_D' }).reason === 'acceptance_not_applied');
    ok('a non-signing event does nothing', SP.planSignedStamp({ event: 'installed' }).action === 'skip');

    // R6-2-5 decision.
    const at12 = { userId: U, leadId: 'L1', priceMode: 'per-sq', prices: { good: 11500, better: 12000, best: 16000 }, tier: 'better', selectedTier: 'better', grandTotal: 12000, taxRate: 0, mode: 'cash' };
    const fp12 = CER.pricedFingerprint(at12);
    const at13 = Object.assign({}, at12, { prices: { good: 11500, better: 13000, best: 16000 }, grandTotal: 13000 });
    ok('unchanged estimate → accepted at the page price', SP.checkDealPrice({ est: at12, tier: 'better', offeredPrice: 12000, issuedFingerprint: fp12 }).ok === true);
    const r1 = SP.checkDealPrice({ est: at13, tier: 'better', offeredPrice: 12000, issuedFingerprint: fp12 });
    ok('re-saved at $13,000 → the $12,000 acceptance is REFUSED with the current price', r1.ok === false && r1.code === 'price_changed' && r1.tierPrice === 13000 && r1.currentPrices.best === 16000);
    ok('confirming the old price is still refused', SP.checkDealPrice({ est: at13, tier: 'better', offeredPrice: 12000, issuedFingerprint: fp12, confirmPrice: 12000 }).ok === false);
    const r2 = SP.checkDealPrice({ est: at13, tier: 'better', offeredPrice: 12000, issuedFingerprint: fp12, confirmPrice: 13000 });
    ok('confirming the CURRENT $13,000 → accepted at $13,000', r2.ok === true && r2.price === 13000 && r2.changedFrom === 12000);
    ok('a legacy link (no fingerprint) is still checked against the estimate\'s price', SP.checkDealPrice({ est: at13, tier: 'better', offeredPrice: 12000 }).ok === false);
    const li = { userId: U, rows: [{ desc: 'r', retailTotal: 10700 }], tier: 'better', grandTotal: 10700 };
    const r3 = SP.checkDealPrice({ est: Object.assign({}, li, { grandTotal: 11000 }), tier: 'good', offeredPrice: 9500, issuedFingerprint: CER.pricedFingerprint(li) });
    ok('a line-item estimate\'s other tier, after a re-save → refused with no price to offer (ask the rep)', r3.ok === false && r3.tierPrice === null);
    ok('…a line-item estimate that did not change → accepted', SP.checkDealPrice({ est: li, tier: 'good', offeredPrice: 9500, issuedFingerprint: CER.pricedFingerprint(li) }).ok === true);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nC. the job spine: signing stamps the price; the drafts bill it');
  if (SPINE && D && CER) {
    const db = makeDb({ 'leads/L1': lead0, 'estimates/E1': signedEst() });
    const r = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_c1', actor: 'test', meta: { docId: 'c1' } }, deps);
    const e = db.store.get('estimates/E1');
    ok('contract_signed stamps estimates/E1.signedPrice at $14,500', r.signedPrice && r.signedPrice.stamped === true && e.signedPrice && e.signedPrice.totalCents === 1450000, JSON.stringify(r.signedPrice));
    const draft = [...db.store.entries()].find(([k]) => k.startsWith('invoices/depdraft_'));
    ok('…and the deposit draft bills $14,500 with $7,250 due', !!draft && c(draft[1].total) === 1450000 && c(draft[1].depositAmount) === 725000, JSON.stringify(r.depositDraft));
    if (!draft) throw new Error('no deposit draft — cannot continue section C');
    // The rep reopens and saves at $16,200 (the edit keeps the server's signedPrice).
    const after = Object.assign(reprice(e), { signedPrice: e.signedPrice });
    db.store.set('estimates/E1', after);
    const signing = Object.assign({ id: draft[0] }, draft[1], { status: 'partial', amountPaid: 7250, balanceDue: 7250, depositPaid: true, createdAt: 2 });
    const fd = D.decideFinalDraft({ leadId: 'L1', lead: Object.assign({}, lead0), est: after, estimateId: 'E1', invoices: [signing] });
    ok('install-day final draft after the re-price: the signing invoice already bills the whole $14,500 → no +$1,700 bill',
      fd.action === 'use_existing' && fd.invoiceId === draft[0], JSON.stringify({ a: fd.action, r: fd.reason, t: fd.invoice && fd.invoice.total }));
    const fd2 = D.decideFinalDraft({ leadId: 'L1', lead: Object.assign({}, lead0), est: after, estimateId: 'E1',
      invoices: [Object.assign({}, signing, { items: [], total: 7250, balanceDue: 7250, depositAmount: 0 })] });
    ok('with only a $7,250 deposit invoice the final draft bills the signed balance: $7,250 (not $8,950)',
      fd2.action === 'create' && c(fd2.invoice.total) === 725000, JSON.stringify({ a: fd2.action, t: fd2.invoice && fd2.invoice.total }));
    const dd = D.decideDepositDraft({ leadId: 'L1', event: 'contract_signed', lead: Object.assign({}, lead0), est: after, estimateId: 'E1', existingInvoices: [] });
    ok('a deposit draft made after the re-price still bills the signed $14,500 / $7,250', dd.action === 'create' && c(dd.invoice.total) === 1450000 && c(dd.invoice.depositAmount) === 725000);
    const unsigned = D.decideDepositDraft({ leadId: 'L1', event: 'contract_signed', lead: Object.assign({}, lead0), est: reprice(signedEst()), estimateId: 'E1', existingInvoices: [] });
    ok('control: an estimate with no signed price bills as saved ($16,200)', unsigned.action === 'create' && c(unsigned.invoice.total) === 1620000);

    // A KY insurance job: still nothing due at signing (no deposit draft), stamp or not.
    const kyLead = Object.assign({}, lead0, { address: KY, state: 'KY', jobType: 'insurance', claimNumber: 'C-1' });
    const kyDb = makeDb({ 'leads/L1': kyLead, 'estimates/E1': Object.assign(signedEst(), { addr: KY, mode: 'insurance', claim: { deductible: 1000 } }) });
    const kr = await SPINE.recordJobEvent(kyDb, { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_k1', actor: 'test' }, deps);
    ok('Kentucky insurance job: the price is stamped but no deposit draft is made (KRS 367.626)',
      kr.signedPrice && kr.signedPrice.stamped === true && kr.depositDraft && kr.depositDraft.created === false && kr.depositDraft.reason === 'ky_insurance_hold', JSON.stringify(kr.depositDraft));

    // A stamp failure never blocks the deposit draft.
    const boom = await SPINE.recordJobEvent(makeDb({ 'leads/L1': lead0, 'estimates/E1': signedEst() }), { leadId: 'L1', event: 'contract_signed', sourceId: 'doc_b' },
      Object.assign({}, deps, { stampSignedPrice: async () => { throw new Error('boom'); } }));
    ok('a stamp that throws is reported, and the deposit draft still runs', boom.signedPrice && boom.signedPrice.reason === 'error' && boom.depositDraft && boom.depositDraft.created === true);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nD. the CRM invoice + "Paid in full?" (invoice-pipeline.js)');
  {
    const IP = req('docs/pro/js/invoice-pipeline.js');
    if (IP && CERB) {
      const e1 = signedEst();
      const sp = { fields: CER.signedPriceSnapshot(e1), fingerprint: CER.pricedFingerprint(e1), totalCents: 1450000 };
      const edited = Object.assign(reprice(e1), { signedPrice: sp });
      const store = new Map([['estimates/E1', edited], ['leads/L1', Object.assign({}, lead0)]].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
      const added = [];
      let seq = 0;
      global.window = {
        doc: (db, cn, id) => ({ path: cn + '/' + id, id }),
        collection: (db, cn) => ({ col: cn }),
        where: (f, op, v) => ({ f, op, v }),
        query: (cn, ...ws) => ({ col: cn.col, ws }),
        getDoc: async (r) => ({ exists: () => store.has(r.path), data: () => JSON.parse(JSON.stringify(store.get(r.path))) }),
        getDocs: async (q) => {
          const docs = [];
          for (const [k, v] of store) {
            const [cn, id] = k.split('/');
            if (cn !== q.col) continue;
            if ((q.ws || []).every((w) => v[w.f] === w.v)) docs.push({ id, data: () => JSON.parse(JSON.stringify(v)) });
          }
          return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
        },
        addDoc: async (cn, data) => { const id = 'new' + (++seq); added.push(Object.assign({ id }, data)); store.set(cn.col + '/' + id, JSON.parse(JSON.stringify(data))); return { id }; },
        updateDoc: async () => {}, setDoc: async () => {},
        _db: { fake: true }, db: { fake: true },
        NBDDepositRule: req('docs/pro/js/deposit-rule.js'),
        NBDCustomerEstimateRows: CERB,
        _auth: { currentUser: { uid: U, getIdToken: async () => 'tok' } },
        _user: { uid: U }, _userClaims: {}, _leads: [], showToast: () => {},
      };
      global.showToast = () => {};
      let r = null, err = null;
      try { r = await IP.createOrOpenJobInvoice('E1'); } catch (e) { err = e; }
      const inv = added[0] || {};
      ok('Create Invoice on the re-priced signed estimate bills the SIGNED $14,500 (lines foot to it), deposit $7,250',
        !err && r && r.reused === false && c(inv.total) === 1450000 && c(inv.depositAmount) === 725000
        && inv.items.reduce((s, i) => s + c(i.total), 0) + c(inv.tax) === 1450000, err ? err.message : JSON.stringify({ t: inv.total, d: inv.depositAmount, n: (inv.items || []).length }));
      const t = IP.recordPaymentTarget ? IP.recordPaymentTarget({ lead: lead0, estimateId: 'E1', estimate: CERB.signedView(edited), invoices: [] }) : null;
      ok('"Paid in full?" reads the estimate through the signed view ($14,500)',
        !!t && t.totalCents === 1450000 && /_signedViewOf\(Object\.assign\(\{ id \}, s\.data\(\)\)\)/.test(code('docs/pro/js/invoice-pipeline.js')));
      delete global.window;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nE. the portal card shows the signed price');
  if (SP && CER) {
    const e1 = signedEst();
    const sp = { fields: CER.signedPriceSnapshot(e1), fingerprint: CER.pricedFingerprint(e1), totalCents: 1450000 };
    const edited = Object.assign(reprice(e1), { signedPrice: sp, signatureStatus: 'signed' });
    ok('portalPriced: "✓ Signed" sits beside $14,500, not the re-priced $16,200', SP.portalPriced(edited).grandTotal === 14500);
    ok('portalPriced: a revision out for a NEW signature shows the revision being signed ($16,200)',
      SP.portalPriced(Object.assign({}, edited, { signatureStatus: 'sent' })).grandTotal === 16200);
    const src = code('functions/portal.js');
    ok('portal.js builds the card from portalPriced (total, tier name, deposit terms)',
      /const latestPriced = latest \? portalPriced\(latest\) : null;/.test(src)
      && /grandTotal:\s+latestPriced\.grandTotal \|\| latestPriced\.total \|\| null/.test(src)
      && /depositPlan: safeDepositPlan\(latestPriced\)/.test(src) && /tierName:\s+tierApplies\(latestPriced\)/.test(src));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nF. the deal room, run for real (firebase-admin replaced by a fake)');
  {
    let db = makeDb({});
    const fakeFirestore = {
      getFirestore: () => db,
      FieldValue: FV,
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }), now: () => ({ toMillis: () => NOW }) },
    };
    const fakeStorage = { getStorage: () => ({ bucket: () => ({ file: () => ({ download: async () => { throw new Error('no storage in test'); }, save: async () => {} }) }) }) };
    const fakeRate = { httpRateLimit: async () => true, enforceRateLimit: async () => {}, clientIp: () => '203.0.113.9' };
    const rateFile = path.join(FN, 'integrations', 'upstash-ratelimit.js');
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'firebase-admin/firestore') return fakeFirestore;
      if (request === 'firebase-admin/storage') return fakeStorage;
      if (request === 'firebase-admin/auth') return { getAuth: () => ({}) };
      try { if (Module._resolveFilename(request, parent, isMain) === rateFile) return fakeRate; } catch (_) { /* not a path */ }
      return origLoad.apply(this, arguments);
    };
    let DA = null;
    try { DA = require(path.join(FN, 'deal-acceptance.js')); } catch (e) { ok('loads functions/deal-acceptance.js with the fakes', false, e && e.message); }
    const submit = async (body) => {
      const res = { code: 200, body: null, headers: {}, statusCode: 200,
        status(n) { this.code = n; this.statusCode = n; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; },
        set() { return this; }, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, end() { return this; }, vary() { return this; }, on() {}, once() {}, removeListener() {} };
      const req2 = { method: 'POST', body, headers: { 'user-agent': 'test' }, get: (h) => (/user-agent/i.test(h) ? 'test' : ''), header: () => '', ip: '203.0.113.9', path: '/api/deal-accept', url: '/api/deal-accept' };
      await DA.submitDealAcceptance(req2, res);
      return res;
    };
    if (DA) {
      const est12 = { userId: U, companyId: U, leadId: 'L1', priceMode: 'per-sq', prices: { good: 11500, better: 12000, best: 16000 }, tier: 'better', selectedTier: 'better',
        grandTotal: 12000, subtotal: 12000, tax: 0, taxRate: 0, mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1 };
      const sig = 'data:image/png;base64,' + 'A'.repeat(400);
      const seedDeal = () => makeDb({
        'leads/L1': lead0,
        'estimates/E1': est12,
        'deal_rooms/DEAL0001': { userId: U, leadId: 'L1', estimateId: 'E1', status: 'sent', customerName: 'Pat', tiers: { good: { price: 11500 }, better: { price: 12000 }, best: { price: 16000 } } },
      });
      // 1. The rep mints the link (createDealAcceptToken, run for real).
      db = seedDeal();
      let mint = null, mintErr = null;
      try {
        mint = await DA.createDealAcceptToken.run({ auth: { uid: U, token: {} }, data: { dealId: 'DEAL0001' }, rawRequest: { headers: {} } });
      } catch (e) { mintErr = e; }
      const token = mint && mint.token;
      const tok = token ? db.store.get('deal_accept_tokens/' + token) : null;
      ok('createDealAcceptToken records the estimate and the price version the link is issued at',
        !!tok && tok.estimateId === 'E1' && tok.estimateFingerprint === CER.pricedFingerprint(est12) && tok.tierPrices.better === 12000, mintErr ? mintErr.message : JSON.stringify(tok && { e: tok.estimateId, f: tok.estimateFingerprint }));
      if (tok) {
        // 2. The rep re-saves the estimate at $13,000 and never re-sends.
        db.store.set('estimates/E1', Object.assign({}, est12, { prices: { good: 11500, better: 13000, best: 16000 }, grandTotal: 13000, subtotal: 13000 }));
        // 3. The homeowner accepts Preferred on the old page ($12,000).
        const r1 = await submit({ token, tier: 'better', signature: sig, consent: true, financing: -1 });
        ok('the stale $12,000 acceptance is REFUSED (409 price_changed) with the current $13,000',
          r1.code === 409 && r1.body && r1.body.code === 'price_changed' && r1.body.tierPrice === 13000 && /\$13,000\.00/.test(r1.body.error || ''), JSON.stringify({ code: r1.code, body: r1.body }));
        ok('…with what is due at signing at the new price ($6,500 on a cash job)', r1.body && r1.body.depositDue === 6500, JSON.stringify(r1.body && r1.body.depositDue));
        ok('…and nothing was written: the link is still live, the deal not accepted, the estimate still $13,000',
          db.store.get('deal_accept_tokens/' + token).status === 'pending' && db.store.get('deal_rooms/DEAL0001').status === 'sent' && db.store.get('estimates/E1').grandTotal === 13000);
        const r2 = await submit({ token, tier: 'better', signature: sig, consent: true, financing: -1, confirmPrice: 12000 });
        ok('confirming the OLD price is refused too', r2.code === 409);
        // 4. They saw $13,000 and accept it.
        const r3 = await submit({ token, tier: 'better', signature: sig, consent: true, financing: -1, confirmPrice: 13000 });
        const deal = db.store.get('deal_rooms/DEAL0001');
        const est = db.store.get('estimates/E1');
        ok('confirming the current $13,000 is accepted at $13,000', r3.code === 200 && deal.status === 'accepted' && deal.acceptedPrice === 13000
          && deal.acceptedEvidence && deal.acceptedEvidence.priceChangedFrom === 12000, JSON.stringify({ code: r3.code, body: r3.body, p: deal.acceptedPrice }));
        ok('the revised estimate is NOT rewritten back to $12,000 (prices{}, total)', est.grandTotal === 13000 && est.prices.better === 13000, JSON.stringify({ g: est.grandTotal, p: est.prices }));
        ok('the acceptance stamps the signed price at $13,000 (the job spine)', est.signedPrice && est.signedPrice.totalCents === 1300000 && est.signedPrice.source === 'deal_accepted', JSON.stringify(est.signedPrice && est.signedPrice.totalCents));
      }
      // An unchanged estimate is accepted first time, at the page price.
      db = seedDeal();
      let m2 = null;
      try { m2 = await DA.createDealAcceptToken.run({ auth: { uid: U, token: {} }, data: { dealId: 'DEAL0001' }, rawRequest: { headers: {} } }); } catch (_) { m2 = null; }
      if (m2 && m2.token) {
        const r = await submit({ token: m2.token, tier: 'better', signature: sig, consent: true, financing: -1 });
        ok('control: an unchanged estimate accepts at the page price ($12,000) on the first tap', r.code === 200 && db.store.get('deal_rooms/DEAL0001').acceptedPrice === 12000, JSON.stringify({ code: r.code, body: r.body }));
      } else ok('control mint ran', false);
      // A legacy link (minted before this change: no fingerprint) is checked too.
      db = seedDeal();
      db.store.set('deal_accept_tokens/LEGACYTOKEN1234', { dealId: 'DEAL0001', ownerUid: U, companyId: U, leadId: 'L1', status: 'pending', tierPrices: { good: 11500, better: 12000, best: 16000 }, expiresAt: null });
      db.store.set('estimates/E1', Object.assign({}, est12, { prices: { good: 11500, better: 13000, best: 16000 }, grandTotal: 13000 }));
      const rl = await submit({ token: 'LEGACYTOKEN1234', tier: 'better', signature: sig, consent: true, financing: -1 });
      ok('a legacy link (no fingerprint) at a stale price is refused too (via the deal\'s estimate)', rl.code === 409 && rl.body && rl.body.tierPrice === 13000, JSON.stringify({ code: rl.code, body: rl.body }));
      // Kentucky insurance job: the new price still asks nothing at signing.
      db = makeDb({
        'leads/L1': Object.assign({}, lead0, { address: KY, state: 'KY', jobType: 'insurance', claimNumber: 'C-1' }),
        'estimates/E1': Object.assign({}, est12, { addr: KY, mode: 'insurance', claim: { deductible: 1000 }, prices: { good: 11500, better: 13000, best: 16000 }, grandTotal: 13000 }),
        'deal_rooms/DEAL0001': { userId: U, leadId: 'L1', estimateId: 'E1', status: 'sent', tiers: { better: { price: 12000 } } },
        'deal_accept_tokens/KYTOKEN123456': { dealId: 'DEAL0001', ownerUid: U, companyId: U, leadId: 'L1', status: 'pending', tierPrices: { better: 12000 }, estimateId: 'E1', estimateFingerprint: CER.pricedFingerprint(Object.assign({}, est12, { addr: KY, mode: 'insurance', claim: { deductible: 1000 } })) },
      });
      const rk = await submit({ token: 'KYTOKEN123456', tier: 'better', signature: sig, consent: true, financing: -1 });
      ok('Kentucky insurance job: the refusal says $0 due at signing at the new price', rk.code === 409 && rk.body && rk.body.depositDue === 0, JSON.stringify(rk.body));
    }
    Module._load = origLoad;

    // The deal page shows the current price before anything is accepted.
    const dr = code('docs/pro/deal-room.js');
    ok('deal-room.js: a price_changed answer shows the current price and re-asks; the resubmit carries confirmPrice for that package only',
      /if \(j && j\.code === 'price_changed'\) \{ showPriceChanged\(j\); return; \}/.test(dr)
      && /confirmPrice: \(confirmed && confirmed\.tier === selectedTier\) \? confirmed\.price : null/.test(dr)
      && /confirmed = \{ tier: j\.tier, price: Number\(j\.tierPrice\) \};/.test(dr));
    ok('close-board.js serves the new deal-room.js (?v=5)', /pro\/deal-room\.js\?v=5"/.test(read('docs/pro/js/close-board.js')));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nG. e-sign: re-send only to re-sign a revision; the envelope keeps its price');
  {
    const src = code('functions/esign-envelope.js');
    ok('sendEstimateEnvelope refuses a signed estimate only when it has no unsigned changes',
      /if \(est\.signatureStatus === 'signed'\s*&& !require\('\.\/customer-estimate-rows'\)\.hasUnsignedChanges\(est\)\)/.test(src));
    ok('the envelope records the priced snapshot it printed', /pricedSnapshot: require\('\.\/customer-estimate-rows'\)\.signedPriceSnapshot\(est\)/.test(src));
    const js = code('functions/job-spine.js');
    const a = js.indexOf("require('./signed-price').stampSignedPrice");
    const b = js.indexOf("require('./deposit-draft').draftDepositAfterSign");
    ok('the job spine stamps the signed price BEFORE the deposit draft reads the estimate', a > 0 && b > a);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nH. the CRM says it; the rules keep it server-only');
  {
    const hub = code('docs/pro/js/customer-estimate-hub.js');
    ok('customer page: a re-priced signed estimate shows "Changed — not signed" and the signed price the bills follow',
      /✎ Changed — not signed/.test(hub) && /is not signed yet — the homeowner must re-sign it/.test(hub) && /html \+= signedNote\(est\);/.test(hub));
    const boot = code('docs/pro/js/dashboard-bootstrap.module.js');
    ok('saving a re-priced signed estimate warns the rep the bills stay at the signed price', /Saved — not signed yet\. Bills stay at the signed price/.test(boot));
    ok('Copy strips the signed price + signature state', /\['signedPrice', 'signatureStatus'/.test(boot));
    const rules = lf(read('firestore.rules'));
    const blk = rules.slice(rules.indexOf('match /estimates/{estimateId}'), rules.indexOf('match /supplements/{supplementId}'));
    ok('firestore.rules: signedPrice is frozen on update and refused on create',
      /didNotChange\(\[[^\]]*'signedPrice'\]\)/.test(blk) && /!\('signedPrice' in request\.resource\.data\)/.test(blk));
    const dpf = code('docs/pro/js/doc-preflight.js');
    ok('doc pre-flight: an invoice / receipt pre-fills from the signed price, and Save to estimate is refused for those lines',
      /\(type === 'invoice' \|\| type === 'receipt'\)/.test(dpf) && /estimate = _sp\.signedView\(estimate\);/.test(dpf) && /if \(state\.signedBill\) \{/.test(dpf));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
