/**
 * tests/ky-insurance-invoice-split-2026-10-07.test.js
 *
 * Homeowner money audit 2026-10-07, H2. A Kentucky insurance job's invoice,
 * once the insurer's written decision + 5 business days had passed, billed
 * the WHOLE job: Create Invoice stamped depositAmount = deposit-rule.js
 * plan.depositCents, which is $0 for a KY job (nothing is due AT SIGNING),
 * so invoice-charge.js chargeDueNow saw no deposit and the pay link charged
 * $13,250 — while the estimate, deal room and portal plan all said
 * "$1,000 deductible + $8,000 first check after the decision, $4,250 on
 * completion". Before the decision the portal showed "BALANCE DUE
 * $13,250.00" with nothing to press.
 *
 * Contract (Jo's deposit rule, KY and OH alike): the invoice bills the
 * deductible + the carrier's first (ACV) check from the claim's numbers,
 * the rest at completion; missing numbers → "Waiting on the carrier's
 * numbers", nothing billed; the KY hold (ky-insurance-law.js) still decides
 * WHEN; during the hold the portal says "Nothing is due yet" with next steps.
 *
 * Worked example (the audit's): $13,250 job, deductible $1,000, ACV $9,000.
 *   before the decision: $0 due, no link
 *   after decision + 5 business days: $9,000 due
 *   after the $9,000 is paid (completion): $4,250
 *
 * Behaviour over the REAL modules: deposit-rule.js (both copies),
 * invoice-pipeline.js createOrOpenJobInvoice (fake Firestore),
 * invoice-charge.js, ky-insurance-law.js, the portal's balance build lifted
 * from functions/portal.js, and the portal page's card lifted from
 * docs/pro/js/portal.js.
 *
 * Run: node tests/ky-insurance-invoice-split-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
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
function code(p) { return lf(read(p)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1'); }

const DR = req('docs/pro/js/deposit-rule.js');
const DRF = req('functions/deposit-rule.js');
const J = req('functions/ky-insurance-law.js');
const IC = req('functions/invoice-charge.js');

const U = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const KY = '9 Dixie Hwy, Florence, KY 41042';
const OH = '12 Main St, Milford, OH 45150';
const NOW = new Date('2026-10-07T15:00:00Z');
const kyLead = () => ({ userId: U, companyId: U, address: KY, state: 'KY', zip: '41042', jobType: 'insurance', claimNumber: 'C-1', insCarrier: 'Acme Mutual', firstName: 'Pat', activeJobId: 'J1' });
const ohLead = () => ({ userId: U, companyId: U, address: OH, state: 'OH', zip: '45150', jobType: 'insurance', claimNumber: 'C-2', insCarrier: 'Acme Mutual', firstName: 'Sam', activeJobId: 'J1' });
const est = (addr, claim) => ({ userId: U, companyId: U, leadId: 'L1', jobId: 'J1', addr, mode: 'insurance', claim, createdAt: 1,
  grandTotal: 13250, subtotal: 13250, tax: 0, taxRate: 0,
  rows: [{ desc: 'Roof replacement', qty: '1', retailTotal: 13250, total: 13250 }] });

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\nA. deposit-rule.js invoiceDeposit (both copies)');
  for (const [name, M] of [['docs', DR], ['functions', DRF]]) {
    if (!M) continue;
    const has = typeof M.invoiceDeposit === 'function';
    ok(name + ': exports invoiceDeposit', has);
    if (!has) continue;
    const ky = M.compute({ totalCents: 1325000, mode: 'insurance', deductible: 1000, acv: 9000, address: KY });
    const d = M.invoiceDeposit(ky);
    ok(name + ': KY $13,250 — at signing still $0 (plan), the invoice asks $9,000 (deductible + first check)',
      ky.depositCents === 0 && ky.kyHold === true && d.depositCents === 900000 && d.awaitingCarrierNumbers === false, JSON.stringify(d));
    const oh = M.invoiceDeposit(M.compute({ totalCents: 1325000, mode: 'insurance', deductible: 1000, acv: 9000, address: OH }));
    ok(name + ': OH $13,250 — the invoice asks $9,000 too', oh.depositCents === 900000 && !oh.awaitingCarrierNumbers);
    const kyNoAcv = M.invoiceDeposit(M.compute({ totalCents: 1325000, mode: 'insurance', deductible: 1000, address: KY }));
    ok(name + ': KY with no ACV on the claim — waiting on the carrier, bills nothing', kyNoAcv.depositCents === 0 && kyNoAcv.awaitingCarrierNumbers === true && /carrier/.test(kyNoAcv.note));
    const ohNoDed = M.invoiceDeposit(M.compute({ totalCents: 1325000, mode: 'insurance', address: OH }));
    ok(name + ': OH with no deductible — waiting on the carrier, bills nothing (not the whole job)', ohNoDed.depositCents === 0 && ohNoDed.awaitingCarrierNumbers === true);
    const ohNoAcv = M.invoiceDeposit(M.compute({ totalCents: 1325000, mode: 'insurance', deductible: 1000, address: OH }));
    ok(name + ': OH deductible with no ACV yet — the deductible (always due, per the rule)', ohNoAcv.depositCents === 100000 && !ohNoAcv.awaitingCarrierNumbers);
    const kyUnder = M.invoiceDeposit(M.compute({ totalCents: 80000, mode: 'insurance', deductible: 1000, address: KY }));
    ok(name + ': KY job at or below the deductible — the whole $800 (no split)', kyUnder.depositCents === 80000 && !kyUnder.awaitingCarrierNumbers);
    const cash = M.invoiceDeposit(M.compute({ totalCents: 1200000, mode: 'cash' }));
    ok(name + ': cash $12,000 — unchanged, the 50% deposit', cash.depositCents === 600000 && !cash.awaitingCarrierNumbers);
  }
  ok('the two deposit-rule.js copies stay byte-identical', lf(read('docs/pro/js/deposit-rule.js')) === lf(read('functions/deposit-rule.js')));

  // ════════════════════════════════════════════════════════════════════
  console.log('\nB. Create Invoice (invoice-pipeline.js createOrOpenJobInvoice), run for real');
  const IP = req('docs/pro/js/invoice-pipeline.js');
  async function createInvoice(estimate, lead, existing) {
    const store = new Map([['estimates/E1', estimate], ['leads/L1', lead]].concat(existing || []).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
    const added = []; const updates = [];
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
      updateDoc: async (r, patch) => { updates.push({ path: r.path, patch }); },
      setDoc: async () => {},
      _db: { fake: true }, db: { fake: true },
      NBDDepositRule: DR,
      NBDJurisdiction: J,
      NBDCustomerEstimateRows: req('docs/pro/js/customer-estimate-rows.js'),
      _auth: { currentUser: { uid: U, getIdToken: async () => 'tok' } },
      _user: { uid: U }, _userClaims: {}, _leads: [], showToast: () => {},
    };
    global.showToast = () => {};
    let r = null, err = null;
    try { r = await IP.createOrOpenJobInvoice('E1'); } catch (e) { err = e; }
    delete global.window;
    return { r, err, inv: added[0] || null, updates };
  }

  let kyInv = null;
  if (IP && DR && J && IC) {
    const made = await createInvoice(est(KY, { deductible: 1000, acv: 9000 }), kyLead());
    kyInv = made.inv || {};
    ok('KY $13,250: the invoice bills the whole job ($13,250) with $9,000 due first — not $0 (which charged the whole job)',
      !made.err && c(kyInv.total) === 1325000 && c(kyInv.depositAmount) === 900000 && kyInv.kyInsuranceHold === true && kyInv.awaitingCarrierNumbers === false,
      made.err ? made.err.message : JSON.stringify({ t: kyInv.total, d: kyInv.depositAmount, h: kyInv.kyInsuranceHold, a: kyInv.awaitingCarrierNumbers }));
    const rows = IP.paymentSummaryRows ? IP.paymentSummaryRows(kyInv) : [];
    const dep = rows.find((x) => /^Deposit due/.test(x.label));
    const bal = rows.find((x) => x.label === 'Balance Due');
    ok('the invoice rows add up: $9,000 now + $4,250 later = $13,250', !!dep && !!bal && c(dep.amount) === 900000 && c(bal.amount) === 425000
      && c(dep.amount) + c(bal.amount) === c(kyInv.total), JSON.stringify(rows));

    // ── the three moments of the audit's example ──
    const before = kyLead();
    const holdBefore = J.payLinkHold(before, kyInv, NOW);
    const linked = Object.assign({}, kyInv, { stripePaymentLink: 'https://buy.stripe.test/ky', stripeChargeCents: 900000 });
    const cardBefore = IC.portalBalanceCard(linked, J.payUrlUnlessHeld(before, linked, NOW), holdBefore);
    ok('before the carrier decision: $0 due, no pay link, the card says what is next ($9,000)',
      holdBefore.held === true && cardBefore.amountCents === 0 && cardBefore.stripePaymentLink === null && cardBefore.kind === 'held' && cardBefore.nextCents === 900000,
      JSON.stringify(cardBefore));
    const after = Object.assign(kyLead(), { carrierDecisionAt: '2026-09-21' });
    const holdAfter = J.payLinkHold(after, kyInv, NOW);
    const cardAfter = IC.portalBalanceCard(linked, J.payUrlUnlessHeld(after, linked, NOW), holdAfter);
    const dueAfter = IC.chargeDueNow(kyInv);
    ok('after the decision + 5 business days: $9,000 due (the link charges $9,000, not $13,250)',
      holdAfter.held === false && dueAfter.kind === 'deposit' && dueAfter.chargeCents === 900000
      && cardAfter.amountCents === 900000 && cardAfter.stripePaymentLink === 'https://buy.stripe.test/ky', JSON.stringify({ dueAfter, cardAfter }));
    const paid = Object.assign({}, kyInv, { amountPaid: 9000, depositPaid: true, balanceDue: 4250, status: 'partial' });
    const dueDone = IC.chargeDueNow(paid);
    ok('at completion (after the $9,000): $4,250', dueDone.kind === 'balance' && dueDone.chargeCents === 425000, JSON.stringify(dueDone));

    // ── an Ohio insurance job ──
    const oh = await createInvoice(est(OH, { deductible: 1000, acv: 9000 }), ohLead());
    const ohInv = oh.inv || {};
    const ohHold = J.payLinkHold(ohLead(), ohInv, NOW);
    ok('OH $13,250: $9,000 due first, no Kentucky hold', !oh.err && c(ohInv.depositAmount) === 900000 && !ohInv.kyInsuranceHold && ohHold.held === false
      && IC.chargeDueNow(ohInv).chargeCents === 900000, oh.err ? oh.err.message : JSON.stringify({ d: ohInv.depositAmount }));

    // ── a job missing ACV ──
    const noAcv = await createInvoice(est(KY, { deductible: 1000 }), Object.assign(kyLead(), { carrierDecisionAt: '2026-09-21' }));
    const naInv = noAcv.inv || {};
    const naDue = IC.chargeDueNow(naInv);
    const naCard = IC.portalBalanceCard(Object.assign({}, naInv, { stripePaymentLink: 'https://buy.stripe.test/na' }), 'https://buy.stripe.test/na', { held: false, releaseDate: '' });
    ok('KY job missing the ACV: the invoice waits on the carrier — nothing charged, no link, the rep is told why',
      !noAcv.err && naInv.awaitingCarrierNumbers === true && c(naInv.depositAmount) === 0 && naDue.kind === 'awaiting' && naDue.chargeCents === 0
      && naCard.kind === 'awaiting' && naCard.amountCents === 0 && naCard.stripePaymentLink === null && /carrier/i.test(naInv.depositRepNote || ''),
      noAcv.err ? noAcv.err.message : JSON.stringify({ a: naInv.awaitingCarrierNumbers, d: naInv.depositAmount, naDue, naCard, note: naInv.depositRepNote }));
    // The rep enters the ACV and taps Create Invoice again → the same invoice gets the split.
    const waiting = Object.assign({}, naInv); delete waiting.id;
    const again = await createInvoice(est(KY, { deductible: 1000, acv: 9000 }), kyLead(), [['invoices/INV1', waiting]]);
    const up = again.updates.find((u) => u.path === 'invoices/INV1');
    ok('…ACV entered, Create Invoice again: the same invoice now asks $9,000 (no second invoice)',
      !again.err && again.r && again.r.reused === true && !again.inv && !!up && c(up.patch.depositAmount) === 900000 && up.patch.awaitingCarrierNumbers === false,
      again.err ? again.err.message : JSON.stringify({ r: again.r, up }));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nC. the server: Stripe refuses an invoice waiting on the carrier; the portal build');
  {
    const st = code('functions/stripe.js');
    const a = st.indexOf("if (due.kind === 'awaiting')");
    const b = st.indexOf('if (balanceDueCents < MIN_CENTS)');
    ok('createStripePaymentLink refuses an awaiting invoice before minting anything', a > 0 && b > a && /res\.status\(400\)/.test(st.slice(a, b)));

    const src = lf(read('functions/portal.js'));
    const s = src.indexOf('    // Pay link: stripePaymentLink OR stripeHostedUrl');
    const e = src.indexOf(': null;', src.indexOf('const _balance', s));
    const block = (s >= 0 && e > s) ? src.slice(s, e + 7) : '';
    ok('portal: the balance build is liftable', !!block);
    if (block && J && IC && kyInv) {
      const run = (lead, inv) => {
        const ctx = { KyLaw: J, InvoiceCharge: IC, lead, _unpaidInvoice: inv, kyTz: J.DEFAULT_TIME_ZONE, Date, Math, Number,
          tenantKey: 'co_other', require: (p) => require(path.join(ROOT, 'functions', p)) };
        vm.createContext(ctx);
        vm.runInContext(block + '\nthis.__b = _balance;', ctx);
        return ctx.__b;
      };
      const inv = Object.assign({}, kyInv, { status: 'sent', stripePaymentLink: 'https://buy.stripe.test/ky', stripeChargeCents: 900000 });
      const held = run(kyLead(), inv);
      ok('portal (KY, before the decision): kind held, $0, no link, no Zelle, release info carried', held && held.kind === 'held' && held.amountCents === 0
        && held.stripePaymentLink === null && held.zelle === null && held.nextCents === 900000, JSON.stringify(held));
      const rel = run(Object.assign(kyLead(), { carrierDecisionAt: '2026-09-21' }), inv);
      ok('portal (KY, released): $9,000 due with Pay Now', rel && rel.kind === 'deposit' && rel.amountCents === 900000 && rel.stripePaymentLink === 'https://buy.stripe.test/ky', JSON.stringify(rel));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nD. the portal page: "Nothing is due yet — here is what happens next"');
  {
    const pjs = lf(read('docs/pro/js/portal.js'));
    const s = pjs.indexOf('    // Nothing due yet (money audit H2');
    const e = pjs.indexOf('    // ── Booking embed ──');
    const block = (s >= 0 && e > s) ? pjs.slice(s, e) : '';
    ok('portal.js: the balance cards are liftable', !!block);
    if (block) {
      const render = (balance) => {
        const ctx = { view: { balance }, parts: [], esc: (x) => String(x).replace(/[&<>"']/g, (ch) => '&#' + ch.charCodeAt(0) + ';'), safeUrl: (u) => u, Number, String };
        vm.createContext(ctx);
        // The block calls the page's own pay-line / Payments-card builders
        // (#2309, R6-2-6 + audit M3): lift and run them too.
        const helpers = ['balancePayActionHtml', '_milestoneDateLabel', 'paidSoFarCents', 'fmtCents', 'paymentsCardHtml'].map((n) => {
          const m = pjs.match(new RegExp('\\n  function ' + n + '\\([\\s\\S]*?\\n  \\}\\n'));
          return m ? m[0] : '';
        }).join('\n');
        vm.runInContext(helpers + '\n' + block, ctx);
        return ctx.parts.join('');
      };
      const held = render({ kind: 'held', amountCents: 0, totalOwedCents: 0, stripePaymentLink: null, nextCents: 900000, releaseDate: 'September 29, 2026', zelle: null });
      ok('held: "Nothing is due yet" with the next steps and the $9,000 + release date', /Nothing is due yet/.test(held) && /what happens next/.test(held)
        && /written decision/.test(held) && /September 29, 2026/.test(held) && /\$9,000/.test(held) && /when the job is finished/.test(held), held);
      ok('held: no Balance Due, no $0 amount, no Pay Now', !/Balance Due|Deposit Due|Pay Now|\$0\.00/.test(held), held);
      const awaiting = render({ kind: 'awaiting', amountCents: 0, totalOwedCents: 0, stripePaymentLink: null });
      ok('awaiting: "Waiting on the carrier’s numbers", nothing due', /Nothing is due yet/.test(awaiting) && /Waiting on the carrier/.test(awaiting) && !/Pay Now|Balance Due/.test(awaiting), awaiting);
      const plain = render({ kind: 'deposit', amountCents: 900000, totalOwedCents: 1325000, stripePaymentLink: 'https://buy.stripe.test/ky', zelle: null });
      ok('control: a released $9,000 still renders Deposit Due + Pay Now', /Deposit Due/.test(plain) && /\$9,000/.test(plain) && /Pay Now/.test(plain) && !/Nothing is due yet/.test(plain), plain);
      // KY wording (KRS 367.620-.628): the homeowner files and owns the claim.
      const words = held + awaiting;
      ok('KY wording: no handle / negotiate / underpaid / recovered / assignment', !/handl|negotiat|underpaid|recover|assign/i.test(words));
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
