/**
 * tests/review-r6-money-texting-2026-10-07.test.js
 *
 * Review round 6 (Jo's phased review), 2026-10-07: a re-run of round 2's two
 * areas after the money + texting fixes merged (#2245 #2246 #2247 #2198 #2200
 * #2252 #2266 #2268 #2286 #2273/#2274 #2159):
 *   area 2 — "same number everywhere" (one job's money on the estimate, the
 *            contract, the deal room, the portal, the invoice, Stripe, the
 *            deposit / final drafts and the dashboards);
 *   area 3 — texting compliance (STOP / DNC, quiet hours, consent, the
 *            company switch, caps, double sends, every send path).
 *
 * Review rule (Jo): find, verify, PIN and report — do NOT fix. Every bug here
 * was real on origin/main 332e635e and was pinned as `KNOWN BUG R6-<area>-<n>`:
 * the assertion holds the wrong behaviour exactly, so the suite is green.
 * The report with evidence, effect and suggested fix:
 * nbd-content/review-r6-2026-10-07.md.
 *
 * Close-out (2026-10-07, after the fix PRs merged): a pin whose fix merged is
 * now `FIXED R6-<area>-<n> (#PR)` — the SAME scenario and dollar example,
 * asserting the fixed behaviour; each was break-tested (the pre-fix file put
 * back → red). A pin is DROPPED where the fix PR's own test drives the same
 * scenario through the real path (noted at the pin's old place). Pins whose
 * fix has not merged stay `KNOWN BUG`, unchanged.
 *
 * Most of these bugs are INTERACTIONS between fixes that are each correct on
 * their own (e.g. #2198's re-total on "Save to estimate" × V2's rows shape ×
 * #2247's footing rows), so the pins drive the shipping modules end to end.
 * Source pins strip comments first, are brace-scoped to the one block they
 * are about, and assert their anchor was FOUND, so a moved or renamed block
 * fails loudly instead of passing on an empty string.
 *
 * Pure Node (functions/ modules are required directly; no install needed for
 * the ones used here): node tests/review-r6-money-texting-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const DG_DIR = path.join(ROOT, 'docs/pro/js');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const F = (rel) => require(path.join(FN, rel));

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}

// ── Source helpers ──────────────────────────────────────────────────────
// Line-oriented comment stripper: whole-line //, trailing // (not ://), and
// /* */ blocks. It never touches string literals, so it cannot swallow code;
// over-stripping can only make an anchor go missing, which fails loudly.
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of String(src).split(/\r?\n/)) {
    let s = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const e = line.indexOf('*/', i);
        if (e === -1) { i = line.length; break; }
        i = e + 2; inBlock = false; continue;
      }
      let sl = line.indexOf('//', i);
      while (sl > 0 && line[sl - 1] === ':') sl = line.indexOf('//', sl + 2);
      const bl = line.indexOf('/*', i);
      if (sl !== -1 && (bl === -1 || sl < bl)) { s += line.slice(i, sl); i = line.length; break; }
      if (bl !== -1) { s += line.slice(i, bl); i = bl + 2; inBlock = true; continue; }
      s += line.slice(i); i = line.length;
    }
    out.push(s);
  }
  return out.join('\n');
}
// The { … } block that opens at the first '{' at/after `from`. null if unbalanced.
function braceBlock(src, from) {
  const open = src.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}
// The block opened by the first `needle` (after `after`, when given).
function blockAt(src, needle, after) {
  const base = after ? src.indexOf(after) : 0;
  if (base === -1) return null;
  const at = src.indexOf(needle, base);
  return at === -1 ? null : braceBlock(src, at + needle.length - 1);
}
const c = (n) => Math.round(Number(n) * 100);
const sumCents = (rows) => rows.reduce((s, r) => s + c(r.total != null ? r.total : r.amount), 0);

// ── Shared fixtures (Ohio cash jobs; money in dollars as the docs store it) ──
const OH = '1 Main St, Cincinnati, OH 45202';
// A V2 LINE-ITEM estimate: rows at the retail price (post-sweep shape), 7%
// tax, nearest-$25 rounding. $10,000 + $700 tax = $10,700.
function v2LineItemEstimate(extra) {
  return Object.assign({
    id: 'EV2', userId: 'u', leadId: 'L', builder: 'v2', priceMode: 'line-item', prices: null,
    tier: 'better', selectedTier: 'better', materialMarkupPct: 0.25, overhead: 0, profit: 0,
    rows: [
      { code: 'RFG', desc: 'Shingles', qty: '30 SQ', retailTotal: 8000, total: 8000 },
      { code: 'LAB', desc: 'Labor', qty: '30 SQ', retailTotal: 2000, total: 2000 },
    ],
    subtotal: 10000, tax: 700, taxRate: 0.07, grandTotal: 10700, minJobApplied: false,
    mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1,
  }, extra || {});
}

// The real doc pre-flight (doc-preflight.js + the doc generator), with a
// recording updateDoc — the harness tests/doc-preflight-invoice-tax-2026-10-05
// uses.
function preflightEnv(est) {
  const brand = { legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} };
  const win = { _brand: () => brand };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  for (const f of ['estimate-config.js', 'customer-estimate-rows.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(DG_DIR, f), 'utf8'), sandbox, { filename: f });
  }
  const writes = [];
  win.db = {};
  win.doc = (db, col, id) => ({ col, id });
  win.updateDoc = async (ref, upd) => { writes.push({ ref, upd: JSON.parse(JSON.stringify(upd)) }); };
  win._customerEstimates = [est];
  win._leadDoc = { primaryEstimateId: est.id, jobValue: est.grandTotal };
  return { pf: win.DocPreflight, writes };
}

(async () => {
  const DR = F('deposit-rule.js');
  const DAT = F('deal-accepted-tier.js');
  const DDL = F('deposit-draft-logic.js');
  const IFE = F('invoice-from-estimate.js');
  const CER = F('customer-estimate-rows.js');
  const IC = F('invoice-charge.js');
  const invoiceOf = (est) => IFE.invoiceTotalsFromEstimate(est, { estimateValue: CER.estimateValue });

  // ════════════════════════════════════════════════════════════════════
  // AREA 2 — same number everywhere
  // ════════════════════════════════════════════════════════════════════
  console.log('\nArea 2 — same number everywhere');

  // R6-2-1 ─ "Save to estimate" on a V2 (rows) estimate
  {
    const est = v2LineItemEstimate();
    const env = preflightEnv(est);
    const ctx = { lead: {}, estimate: est, photos: [], overrides: {}, depositDropped: [] };
    const lines = env.pf._resolveFieldValue({ key: 'lineItems', source: 'estimate.lineItems' }, ctx);
    ok('R6-2-1 context: the contract pre-flight shows the V2 estimate\'s rows (Shingles $8,000, Labor $2,000) and the 7% tax footing row',
      Array.isArray(lines) && lines.length === 3 && c(lines[0].total) === 800000 && lines[2].code === 'TAX', JSON.stringify(lines && lines.map((l) => [l.description, l.total])));
    // The rep adds a $1,000 upgrade line on the contract and taps "Save to estimate".
    const edited = JSON.parse(JSON.stringify(lines));
    edited.splice(2, 0, { description: 'Ridge vent upgrade', qty: 1, unit: 'ea', rate: 1000, total: 1000 });
    env.pf._state.values = { lineItems: edited };
    env.pf._state.estimate = est;
    await env.pf._saveLineItemsToEstimate('lineItems');
    const contract = CER.buildDisplayRows(est);
    const inv = invoiceOf(est);
    const linesPlusTax = sumCents(inv.items) + c(inv.tax);
    // #2295 chose the "disable" fix: a builder (rows) estimate is not
    // re-priced from the pre-flight; the rep changes it in the builder.
    ok('FIXED R6-2-1 (#2295; was KNOWN BUG 2026-10-07): "Save to estimate" on a V2 (rows) estimate writes NOTHING — no lineItems, no '
      + 're-total to $11,775 — so the e-sign contract, estimate link and CRM invoice keep one set of lines that foots to the $10,700 price '
      + '(was: $10,775 of lines under "Contract price $11,775" and a refused pay link)',
      env.writes.length === 0 && !('lineItems' in est) && c(est.grandTotal) === 1070000
        && sumCents(contract) === 1070000 && !contract.some((r) => /upgrade/i.test(r.desc))
        && linesPlusTax === 1070000 && c(inv.total) === 1070000,
      JSON.stringify({ writes: env.writes, contract: sumCents(contract), price: est.grandTotal, invoiceLinesPlusTax: linesPlusTax, invoiceTotal: inv.total }));
  }
  {
    // R6-2-7, Save half (sibling path of R2-2-3). A LOGGED estimate (lineItems,
    // no rows) is still re-priced by Save: the same $10,700 job, the same
    // $1,000 upgrade → $11,000 + $770 tax, nearest $25 → $11,775.
    const est = { id: 'ELOG', userId: 'u', leadId: 'L', lineItems: [
      { description: 'Shingles', quantity: 1, unit: 'ea', unitPrice: 8000, amount: 8000 },
      { description: 'Labor', quantity: 1, unit: 'ea', unitPrice: 2000, amount: 2000 },
    ], subtotal: 10000, tax: 700, taxRate: 0.07, grandTotal: 10700, minJobApplied: false, mode: 'cash', addr: OH, createdAt: 1 };
    const env = preflightEnv(est);
    const ctx = { lead: {}, estimate: est, photos: [], overrides: {}, depositDropped: [] };
    const lines = env.pf._resolveFieldValue({ key: 'lineItems', source: 'estimate.lineItems' }, ctx);
    const edited = JSON.parse(JSON.stringify(lines || [])).filter((l) => l.code !== 'TAX');
    edited.push({ description: 'Ridge vent upgrade', qty: 1, unit: 'ea', rate: 1000, total: 1000 });
    env.pf._state.values = { lineItems: edited };
    env.pf._state.estimate = est;
    await env.pf._saveLineItemsToEstimate('lineItems');
    const estW = env.writes.find((w) => w.ref.col === 'estimates');
    const leadW = env.writes.find((w) => w.ref.col === 'leads');
    ok('FIXED R6-2-7, Save half (#2295; was KNOWN BUG 2026-10-07): the re-totalled primary estimate ($11,775) re-stamps lead.jobValue '
      + '($10,700 → $11,775) on leads/L, so the kanban, Home KPIs, Numbers and crm_summary follow (was: Save wrote ONLY the estimate)',
      !!estW && c(estW.upd.grandTotal) === 1177500 && !!leadW && leadW.ref.id === 'L' && c(leadW.upd.jobValue) === 1177500,
      JSON.stringify(env.writes.map((w) => [w.ref.col, w.ref.id, w.upd.grandTotal, w.upd.jobValue])));
  }
  // R6-2-7, logged-estimate editor half (dashboard-widgets.js). DROPPED
  // (fixed by #2311): the old pin was a source scan that stayed green on the
  // fix (the re-stamp lives in a helper). tests/dashboards-agree-r6-2026-10-07
  // .test.js runs the real editor against a fake DOM: re-pricing the primary
  // logged estimate $10,700 → $11,775 moves lead.jobValue to $11,775.

  // R6-2-2 ─ a SIGNED estimate re-saved at a new price
  // Jo's rule (2026-10-07, #2299): a signed estimate stays editable, but the
  // SIGNED price wins on every bill until the homeowner re-signs. The signing
  // stamps estimates/{id}.signedPrice (signed-price.js planSignedStamp, run
  // by the job spine before the deposit draft reads the estimate).
  {
    const SP = F('signed-price.js');
    const lead = { userId: 'u', primaryEstimateId: 'E', address: OH, state: 'OH', activeJobId: 'J1' };
    const est1 = { userId: 'u', leadId: 'L', grandTotal: 14500, subtotal: 14500, tax: 0, taxRate: 0, mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1,
      rows: [{ desc: 'Roof', qty: '1', retailTotal: 14500, total: 14500 }] };
    const stamp = SP.planSignedStamp({ leadId: 'L', lead, est: est1, estimateId: 'E', event: 'contract_signed', sourceId: 'doc_1', nowMs: 1 });
    const signed = Object.assign({}, est1, { signatureStatus: 'signed', signedPrice: stamp.signedPrice });
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed', lead, est: signed, estimateId: 'E', existingInvoices: [] });
    const signing = Object.assign({ id: dd.invoiceId }, dd.invoice, { status: 'partial', amountPaid: 7250, balanceDue: 7250, depositPaid: true, createdAt: 2 });
    // The rep reopens the signed estimate and saves it at $16,200.
    const est2 = Object.assign({}, signed, { grandTotal: 16200, subtotal: 16200,
      rows: est1.rows.concat([{ desc: 'Upgrade', qty: '1', retailTotal: 1700, total: 1700 }]) });
    const fd = DDL.decideFinalDraft({ leadId: 'L', lead, est: est2, estimateId: 'E', invoices: [signing] });
    const extra = fd.action === 'create' && fd.invoice ? c(fd.invoice.total) : 0;
    ok('R6-2-2 context: signing stamps the $14,500 price and the signing-day draft bills $14,500 with $7,250 due',
      stamp.action === 'stamp' && stamp.signedPrice.totalCents === 1450000 && dd.action === 'create' && c(dd.invoice.total) === 1450000 && c(dd.invoice.depositAmount) === 725000,
      JSON.stringify({ stamp: stamp.action, dd: dd.action, total: dd.invoice && dd.invoice.total }));
    ok('FIXED R6-2-2 (#2299; was KNOWN BUG 2026-10-07): after the $14,500 signature the estimate re-saved at $16,200 is flagged as '
      + 'unsigned changes, the portal card keeps "✓ Signed" beside $14,500, and the install-day final draft bills nothing extra — the '
      + 'signing invoice already bills the whole signed $14,500 (was: +$1,700 and "Less deposit invoiced −$14,500")',
      CER.hasUnsignedChanges(est2) === true && CER.signedTotalCents(est2) === 1450000
        && SP.portalPriced(est2).grandTotal === 14500 && extra === 0,
      JSON.stringify({ unsigned: CER.hasUnsignedChanges(est2), portal: SP.portalPriced(est2).grandTotal, fd: fd.action, reason: fd.reason, total: fd.invoice && fd.invoice.total }));
  }

  // R6-2-3 ─ a LINE-ITEM estimate accepted at another tier in the deal room
  {
    const est = v2LineItemEstimate();
    const lead = { userId: 'u', primaryEstimateId: 'EV2', jobValue: 10700, address: OH, state: 'OH', activeJobId: 'J1' };
    // The deal room offers every tier (estimate-v2-ui _dealPricesFor → triTierTotals);
    // the homeowner accepts Standard at $9,500.
    const plan = DAT.planAcceptedTier({ lead, estimate: est, estimateId: 'EV2', leadId: 'L', ownerUid: 'u', tier: 'good', price: 9500, dealId: 'D', now: 1 });
    const dealRoomDue = DR.fromEstimate(est, { totalCents: 950000, lead }).depositCents;
    const est2 = Object.assign({}, est, plan.estimate || {});
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'deal_accepted', lead, est: est2, estimateId: 'EV2',
      deal: { estimateId: 'EV2', acceptedTier: 'good', acceptedPrice: 9500 }, existingInvoices: [] });
    ok('R6-2-3 context: the deal room told the homeowner $4,750 is due at signing for Standard $9,500 (deposit-rule on the accepted price)',
      dealRoomDue === 475000, dealRoomDue);
    ok('FIXED R6-2-3 (#2305; was KNOWN BUG 2026-10-07): while the homeowner\'s Standard $9,500 pick on a line-item estimate is unresolved, '
      + 'the automatic signing-day draft WAITS (skip accepted_tier_pending) instead of billing the rep\'s $10,700 / $5,350 — and the deal '
      + 'room no longer offers a tier this estimate cannot rebuild',
      dd.action === 'skip' && dd.reason === 'accepted_tier_pending' && DAT.tierOffered(est, 'good') === false && DAT.tierOffered(est, 'better') === true,
      JSON.stringify({ reason: plan.reason, action: dd.action, why: dd.reason, total: dd.invoice && dd.invoice.total }));
  }

  // R6-2-4 ─ "Use it" on a line-item estimate
  // #2305 removed the chip's client-side usePatch: "Use it" is the server's
  // planUseAcceptedTier, which rebuilds the rows from the V2 build stored for
  // that tier, or refuses.
  {
    const est = v2LineItemEstimate({ id: 'E', acceptedTier: 'good', acceptedPrice: 9500 });
    const lead = { primaryEstimateId: 'E', jobValue: 10700, address: OH };
    const none = DAT.planUseAcceptedTier({ lead, estimate: est, estimateId: 'E', depositRule: DR });
    // The same estimate with the Standard build V2 stored beside it at save:
    // $6,878.50 + $2,000 = $8,878.50 + 7% tax $621.50 = $9,500.
    const good = { rows: [
      { code: 'RFG', desc: 'Shingles', qty: '30 SQ', retailTotal: 6878.5, total: 6878.5 },
      { code: 'LAB', desc: 'Labor', qty: '30 SQ', retailTotal: 2000, total: 2000 },
    ], grandTotal: 9500, subtotal: 8878.5, tax: 621.5, taxRate: 0.07, minJobApplied: false };
    const built = Object.assign({}, est, { tierRows: { v: 1, basis: { tier: 'better', totalCents: 1070000, rowsKey: DAT.rowsKey(est.rows) }, tiers: { good } } });
    const w = DAT.planUseAcceptedTier({ lead, estimate: built, estimateId: 'E', depositRule: DR });
    const est2 = Object.assign({}, built, w.estimate || {});
    const contract = CER.buildDisplayRows(est2);
    const inv = invoiceOf(est2);
    ok('FIXED R6-2-4 (#2305; was KNOWN BUG 2026-10-07): "Use it" on a line-item estimate with no Standard build refuses (needs-builder) '
      + 'and writes nothing; with the build it rebuilds the rows, so the contract and the invoice foot to the $9,500 price and jobValue '
      + 'follows (was: $10,621.50 of lines under $9,500 and a refused pay link)',
      none.reason === 'needs-builder' && none.estimate === null && none.lead === null
        && w.reason === 'applied' && c(est2.grandTotal) === 950000 && sumCents(contract) === 950000
        && sumCents(inv.items) + c(inv.tax) === 950000 && c(inv.total) === 950000 && w.lead && c(w.lead.jobValue) === 950000,
      JSON.stringify({ none: none.reason, used: w.reason, contract: sumCents(contract), inv: sumCents(inv.items) + c(inv.tax), total: inv.total }));
  }

  // R6-2-5 ─ a stale deal room overrode a re-saved estimate. DROPPED (fixed by
  // #2299): tests/signed-price-r6-2026-10-07.test.js section F runs the same
  // scenario (deal out at Preferred $12,000, estimate re-saved at $13,000)
  // through the real createDealAcceptToken + submitDealAcceptance and checks
  // the stale acceptance is refused (409 price_changed, $13,000 offered) and
  // nothing is rewritten back to $12,000.

  // R6-2-6 ─ after an online deposit, the portal's Pay Now is the spent deposit link
  {
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed',
      lead: { userId: 'u', primaryEstimateId: 'E', address: OH, state: 'OH', activeJobId: 'J1' },
      est: { userId: 'u', leadId: 'L', grandTotal: 12000, subtotal: 12000, tax: 0, taxRate: 0, mode: 'cash', jobId: 'J1', addr: OH,
        rows: [{ desc: 'Roof', qty: '1', retailTotal: 12000, total: 12000 }] }, estimateId: 'E', existingInvoices: [] });
    const sent = Object.assign({}, dd.invoice, { status: 'sent' });
    const due0 = IC.chargeDueNow(sent);
    // createStripePaymentLink stamps what it charged; the CRM stores the URL.
    // The payment link is single-use (restrictions.completed_sessions.limit 1);
    // NBD's own path is a Stripe invoice for exactly the deposit.
    const minted = Object.assign({}, sent, { stripePaymentLink: 'https://buy.stripe.test/deposit', stripeInvoiceId: 'plink_dep',
      stripeChargeCents: due0.chargeCents, stripeChargeKind: due0.kind });
    // invoiceWebhook payment_intent.succeeded writes status / amountPaid /
    // balanceDue / depositPaid and leaves the link fields alone; #2309's fix is
    // in portalBalanceCard (the link's stamped kind must be the kind due now).
    const after = Object.assign({}, minted, { status: 'partial', amountPaid: 6000, balanceDue: 6000, depositPaid: true });
    const card = IC.portalBalanceCard(after, after.stripePaymentLink);
    // Control: a link minted for THIS balance is still offered.
    const balDue = IC.chargeDueNow(after);
    const reminted = Object.assign({}, after, { stripePaymentLink: 'https://buy.stripe.test/balance', stripeChargeCents: balDue.chargeCents, stripeChargeKind: balDue.kind });
    const card2 = IC.portalBalanceCard(reminted, reminted.stripePaymentLink);
    ok('FIXED R6-2-6 (#2309; was KNOWN BUG 2026-10-07): after the $6,000 deposit is paid online, the portal\'s Balance Due $6,000 card '
      + 'does NOT offer the spent deposit link as Pay Now, although the two amounts are equal (was: the single-use deposit link)',
      card.kind === 'balance' && card.amountCents === 600000 && card.stripePaymentLink === null,
      JSON.stringify(card));
    ok('R6-2-6 control: once a balance link is minted for the $6,000, the card offers it',
      card2.kind === 'balance' && card2.amountCents === 600000 && card2.stripePaymentLink === 'https://buy.stripe.test/balance', JSON.stringify(card2));
  }

  // ── Dashboards (the second half of area 2) ─────────────────────────────
  console.log('\nArea 2 — dashboards');

  // R6-2-8 ─ catch-up "Paid in full?" + a Stripe payment assigned later
  // counted the deposit twice. DROPPED (fixed by #2296): the old pin
  // hand-built the payment and called the ledger helpers itself, so it could
  // not see the fix (it stayed green on #2296). The real path is in
  // tests/catchup-stripe-double-count-2026-10-07.test.js section 1: catchup.js
  // paidInFull records $12,000, then functions/stripe-ledger.js assign books
  // the $6,000 deposit, and collected reads $12,000 (not $18,000) on Home /
  // Numbers and the agent's collected_revenue.

  // R6-2-9 ─ "Paid in full?" on an insurance job with an approved supplement
  {
    const IP = require(path.join(DG_DIR, 'invoice-pipeline.js'));
    const CL = require(path.join(DG_DIR, 'catchup-logic.js'));
    const t = IP.recordPaymentTarget({ lead: { id: 'C2', jobValue: 14000 }, invoices: [],
      estimate: { id: 'estC', grandTotal: 14000, subtotal: 14000, tax: 0, taxRate: 0, mode: 'insurance', rows: [{ description: 'Roof', qty: 1, unitPrice: 14000, total: 14000 }] },
      estimateId: 'estC', totalsOpts: { estimateValue: CER.estimateValue } });
    const plan = CL.paidInFullPlan(t);
    const ipSrc = stripComments(rd('docs/pro/js/invoice-pipeline.js'));
    ok('R6-2-9 anchor: the invoice made from the estimate folds approved supplements into its total (applySupplementsToTotals)',
      /const folded = applySupplementsToTotals\(\{ items, subtotal, tax, total \}, supplements\);/.test(ipSrc));
    const rpt = blockAt(ipSrc, 'function recordPaymentTarget(ctx) {');
    ok('KNOWN BUG R6-2-9 (reported 2026-10-07): "Paid in full?" records the estimate total BEFORE supplements ($14,000), while the invoice it '
      + 'makes folds the approved $2,000 supplement in ($16,000) — the "paid in full" job then shows $2,000 owed in Collections. '
      + 'Expected the payment to be the invoice\'s own total (open / make the invoice first)',
      t.kind === 'estimate' && plan.ok === true && plan.cents === 1400000 && !!rpt && !/supplement/i.test(rpt), JSON.stringify(plan));
  }

  // R6-2-10 … R6-2-14 ─ the dashboards. DROPPED (fixed by #2311): each is
  // flipped, on the same R6 review fixture (nine card sales = $89,500 plus
  // customer G's finished $10,000 first job → ten sales / $99,500), in
  // tests/dashboards-agree-r6-2026-10-07.test.js, which runs the real modules:
  //   R6-2-10 agent job_profit lists G's finished first job ($10,000 / $6,000);
  //   R6-2-11 the widget's "Booked (all time)" = 10 deals, $99.5k;
  //   R6-2-12 Analytics and Money print the same 42% margin;
  //   R6-2-13 sourceTable over job records books $99,500 / 10 won;
  //   R6-2-14 the Leaderboard page counts 10 deals, dated by the sale, not
  //           updatedAt.
  // The old pins here were source scans of the pre-fix shapes.

  // ════════════════════════════════════════════════════════════════════
  // AREA 3 — texting compliance
  // ════════════════════════════════════════════════════════════════════
  console.log('\nArea 3 — texting compliance');
  const W = require(path.join(ROOT, 'tests/lib/sms-compliance-world.js'));
  const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
  const NOON_ET = Date.parse('2026-10-05T16:00:00Z');
  const LATE_ET = Date.parse('2026-10-06T03:30:00Z'); // 11:30pm EDT on 10-05
  const handle = async (mod, token, data) => {
    try { return await mod._test.handle({ auth: { uid: token.uid, token }, data }); } catch (e) { return { threw: e.code || e.message }; }
  };

  // R6-3-1 ─ plain revocations the STOP classifier misses
  {
    const SI = F('sms-stop-intent.js');
    const misses = ['Not interested. Stop.', 'No thanks stop', 'stop sending these', 'I no longer want texts from you'];
    const got = misses.map((m) => SI.classifyInbound(m).intent);
    ok('R6-3-1 context: the bare keyword and the listed phrases still opt out ("Stop!", "Stop contacting me")',
      SI.classifyInbound('Stop!').intent === 'stop' && SI.classifyInbound('Stop contacting me').intent === 'stop');
    ok('FIXED R6-3-1 (#2298; was KNOWN BUG 2026-10-07): "Not interested. Stop.", "No thanks stop", "stop sending these" and "I no longer '
      + 'want texts from you" are opt-outs (was: null — incomingSMS recorded nothing and drafted an AI reply)',
      got.every((g) => g === 'stop'), JSON.stringify(got));
    ok('R6-3-1 control: "can you stop by Tuesday" is still an ordinary customer message, not an opt-out',
      SI.classifyInbound('can you stop by Tuesday').intent === null, JSON.stringify(SI.classifyInbound('can you stop by Tuesday')));
  }

  // R6-3-2 ─ pre-filled customer texts that never asked "may I text?".
  // DROPPED (fixed by #2298): the old pin was a source scan. The five
  // hand-offs now run for real in tests/r6-texting-2026-10-07.test.js C1–C4
  // (Text Portal, portal-link share, Text Booking Link, Care Plan "Text it":
  // STOP / Do Not Text / hours → Messages not opened; check unavailable →
  // blocked) and tests/close-flow-2026-10-03.test.js section D (the V2
  // estimate share box, incl. its automatic hand-off).

  // R6-3-3 ─ an approved AI reply whose send outcome is unknown is sent again
  {
    const err = new Error('socket hang up'); err.code = 'ECONNRESET';
    const w = W.makeWorld({ clockMs: NOON_ET, twilioError: err,
      docs: { 'leads/L1': { userId: NBD, companyId: NBD, phone: '(859) 555-0134', state: 'KY', zip: '41011' } } });
    const m = W.load(w, 'sms-functions.js');
    const h = m.onAiDraftApproved.__handler;
    const draftPath = 'leads/L1/ai_drafts/D1';
    const base = { userId: NBD, companyId: NBD, customerPhone: '+18595550134', draftText: 'Thanks — see you Tuesday.' };
    const ev = () => ({ params: { leadId: 'L1', draftId: 'D1' }, data: { before: { data: () => Object.assign({ status: 'pending' }, base) }, after: { data: () => Object.assign({ status: 'approved' }, base) } } });
    w.store.set(draftPath, Object.assign({ status: 'approved' }, base));
    await h(ev());
    const first = w.store.get(draftPath) || {};
    w.opts.twilioError = null;
    await h(ev());
    const panel = stripComments(rd('docs/pro/js/customer-ai-drafts-panel.js'));
    const uncertainBranch = blockAt(panel, "} else if (st === 'send_uncertain') {");
    ok('FIXED R6-3-3 (#2300; was KNOWN BUG 2026-10-07): a dropped connection mid-send (ECONNRESET) marks the draft send_uncertain, not '
      + 'failed / twilio_error; the same approval event again sends nothing more (ONE Twilio call, was 2), and the panel\'s send_uncertain '
      + 'branch never reverts the draft to pending',
      first.status === 'send_uncertain' && first.failureReason !== 'twilio_error' && w.twilioCalls.length === 1
        && !!uncertainBranch && !/status: 'pending'/.test(uncertainBranch),
      JSON.stringify({ first: [first.status, first.failureReason], twilio: w.twilioCalls.length, branch: !!uncertainBranch }));
    // Still open from round 2: no per-recipient daily cap on AI replies.
    const w2 = W.makeWorld({ clockMs: NOON_ET, docs: { 'leads/L1': { userId: NBD, companyId: NBD, phone: '8595550134', state: 'KY' } } });
    const m2 = W.load(w2, 'sms-functions.js');
    for (let i = 0; i < 7; i++) {
      const b = { userId: NBD, companyId: NBD, customerPhone: '+18595550134', draftText: 'reply ' + i };
      w2.store.set('leads/L1/ai_drafts/D' + i, Object.assign({ status: 'approved' }, b));
      await m2.onAiDraftApproved.__handler({ params: { leadId: 'L1', draftId: 'D' + i }, data: { before: { data: () => Object.assign({ status: 'pending' }, b) }, after: { data: () => Object.assign({ status: 'approved' }, b) } } });
    }
    ok('KNOWN BUG R6-3-11 (reported 2026-10-05 as still open, re-confirmed 2026-10-07): approved AI replies have no per-recipient daily cap — '
      + '7 replies to one homeowner in one day all go out with no limiter call (sendSMS stops at 5). Expected the same 5/day cap',
      w2.twilioCalls.length === 7 && w2.events.filter((e) => String(e).startsWith('limit:')).length === 0,
      JSON.stringify({ sent: w2.twilioCalls.length }));
  }

  // R6-3-4 ─ a replayed offline text at the daily cap still opens Messages
  {
    const ctx = { toasts: [], opened: [] };
    const win = { _user: { uid: 'u1', getIdToken: async () => 'tok' }, showToast: (msg, t) => ctx.toasts.push([t, msg]), dispatchEvent: () => {},
      NBDPhoneShare: { checkText: async () => ({ ok: true, to: '+18595550134' }) } };
    const sb = { window: win, document: { createElement: () => ({ click() { ctx.opened.push(this.href); }, remove() {}, style: {} }), body: { appendChild() {} }, addEventListener() {} },
      location: { hostname: 'nobigdealwithjoedeal.com' }, navigator: { onLine: true },
      fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: 'This recipient has received the maximum SMS for today.', code: 'recipient_daily_cap' }) }),
      AbortController, setTimeout, clearTimeout, CustomEvent: function () {}, console: { log() {}, warn() {}, error() {} } };
    win.window = win;
    vm.createContext(sb);
    vm.runInContext(rd('docs/pro/js/nbd-comms.js'), sb, { filename: 'nbd-comms.js' });
    const live = await win.NBDComms.sendSMS({ to: '8595550134', message: 'hi', leadId: 'L1' });
    const q = await win.NBDComms.sendQueued({ id: 'q1', to: '8595550134', body: 'hi', leadId: 'L1', createdAt: Date.now() - 1000 });
    const ob = stripComments(rd('docs/pro/js/sms-outbox.js'));
    ok('R6-3-4 context: a LIVE send at the per-recipient cap is refused and opens nothing (R2-3-4 fix)', live && live.success === false && ctx.opened.length === 0);
    ok('KNOWN BUG R6-3-4 (reported 2026-10-07; R2-3-4 only partly fixed): a REPLAYED offline text that hits the same cap comes back '
      + 'held / rate_limited, which the outbox tray treats as hand-off-able ("Open in Messages", no checkText) — the 6th text of the day '
      + 'still goes out from the rep\'s phone. Expected recipient_daily_cap to be refused on the replay path too',
      q && q.outcome === 'held' && q.reason === 'rate_limited' && /const HANDOFF_OK = \{[^}]*rate_limited: 1/.test(ob), JSON.stringify(q));
  }

  // R6-3-5 ─ START to the business line lifts an owner-recorded STOP for another company
  {
    const tokA = { uid: 'ownerA', companyId: 'coA', role: 'company_admin' };
    const w = W.makeWorld({ clockMs: NOON_ET, docs: { 'leads/LA': { userId: 'ownerA', companyId: 'coA', phone: '8595550134', phoneDigits: '8595550134', state: 'KY' } } });
    let m = W.load(w, 'phone-text-check.js');
    const rec = await handle(m, tokA, { action: 'stop', leadId: 'LA' });
    const before = await handle(m, tokA, { action: 'check', phone: '8595550134', leadId: 'LA' });
    const s = W.load(w, 'sms-functions.js');
    await W.invoke(s.incomingSMS.__handler, { body: { From: '+18595550134', Body: 'START', MessageSid: 'SMx1' }, headers: { 'x-twilio-signature': 'sig' } });
    m = W.load(w, 'phone-text-check.js');
    const after = await handle(m, tokA, { action: 'check', phone: '8595550134', leadId: 'LA' });
    ok('FIXED R6-3-5 (#2300; was KNOWN BUG 2026-10-07): company A records "They replied STOP" (the reply reached the owner\'s own phone); '
      + 'a later START to NBD\'s shared Twilio number does NOT lift it — company A is still refused (was: ok to text again)',
      rec && rec.ok === true && before && before.ok === false && before.code === 'opted_out' && after && after.ok === false,
      JSON.stringify({ rec, before: before && before.code, after: after && [after.ok, after.code] }));
  }

  // R6-3-6 ─ the no-customer check path skips texting hours
  {
    const token = { uid: NBD, companyId: NBD, role: 'company_admin' };
    const w = W.makeWorld({ clockMs: LATE_ET, docs: { 'leads/L1': { userId: NBD, companyId: NBD, phone: '8595550134', state: 'KY', zip: '41011' } } });
    const m = W.load(w, 'phone-text-check.js');
    const withLead = await handle(m, token, { action: 'check', phone: '8595550134', leadId: 'L1', recipient: 'homeowner' });
    const numberOnly = await handle(m, token, { action: 'check', phone: '8595550134', recipient: 'number' });
    ok('FIXED R6-3-6 (#2300; was KNOWN BUG 2026-10-07): at 11:30pm Eastern the check refuses the homeowner both with the lead and through '
      + 'the no-customer path (quiet_hours — the default 8am–9pm Eastern window; was: allowed without the lead)',
      withLead && withLead.ok === false && withLead.code === 'quiet_hours' && numberOnly && numberOnly.ok === false && numberOnly.code === 'quiet_hours',
      JSON.stringify({ withLead: withLead && withLead.code, numberOnly: numberOnly && [numberOnly.ok, numberOnly.code] }));
  }

  // R6-3-8 ─ storm alerts de-duplicate per sign-up, not per phone
  {
    const w = W.makeWorld({ clockMs: NOON_ET, docs: {
      'storm_alert_subscribers/s1': { phone: '8595550134', zip: '41011', active: true, tcpaConsent: true },
      'storm_alert_subscribers/s2': { phone: '(859) 555-0134', zip: '41011', active: true, tcpaConsent: true },
    } });
    const G = W.load(w, 'storm-sms-guard.js');
    let sends = 0;
    for (const id of ['s1', 's2']) {
      await G.sendGuardedStormText({ db: w.db, subscriberRef: w.db.doc('storm_alert_subscribers/' + id), phone: '+18595550134',
        claimRef: w.db.doc('storm_alerts_sent/' + G.claimDocId('ALERT-1', id)), claimData: { alertId: 'ALERT-1', subscriberId: id },
        source: 'checkStormAlerts', companyId: NBD, eventKey: 'ALERT-1', recipient: { zip: '41011' }, nowMs: NOON_ET,
        send: async () => { sends++; return { sid: 'SM' + sends }; } });
    }
    ok('KNOWN BUG R6-3-8 (reported 2026-10-07, low-med): a homeowner who signed up twice ("859…" and "(859) …") gets TWO texts for one '
      + 'storm alert — the claim key is alert × sign-up doc. Expected one text per alert per phone number',
      sends === 2, sends);
  }

  // R6-3-9 ─ a phone saved with an extension is checked against the wrong STOP key
  {
    const token = { uid: NBD, companyId: NBD, role: 'company_admin' };
    const w = W.makeWorld({ clockMs: NOON_ET, docs: {
      'sms_opt_outs/8595550134': { phone: '+18595550134', keyword: 'STOP' },
      'leads/L1': { userId: NBD, companyId: NBD, phone: '(859) 555-0134 x5', state: 'KY' },
    } });
    const m = W.load(w, 'phone-text-check.js');
    const OptOut = F('sms-optout.js');
    const ext = await handle(m, token, { action: 'check', phone: '(859) 555-0134 x5', leadId: 'L1' });
    const plain = await handle(m, token, { action: 'check', phone: '(859) 555-0134', leadId: 'L1' });
    ok('KNOWN BUG R6-3-9 (reported 2026-10-07, low): "(859) 555-0134 x5" keys as 5955501345, so the check says OK for a number that '
      + 'replied STOP (the plain number is refused). Expected an 11+-digit number not starting with 1 to be refused as unverifiable',
      OptOut.optOutKey('(859) 555-0134 x5') === '5955501345' && ext && ext.ok === true && plain && plain.ok === false,
      JSON.stringify({ ext: ext && ext.ok, plain: plain && plain.code }));
  }

  // R6-3-10 ─ STOP / HELP / START replies are NBD's for every company (still open from round 2)
  {
    const s = stripComments(rd('functions/sms-functions.js'));
    ok('KNOWN BUG R6-3-10 (reported 2026-10-05 as still open, re-confirmed 2026-10-07): the STOP / HELP / START TwiML replies are '
      + 'literals that say "NBD Pro" and give Joe\'s number, whichever company the homeowner was texting with. Expected the tenant\'s '
      + 'name and support line',
      /You\\'ve been unsubscribed from NBD Pro SMS\./.test(s) && /NBD Pro: Msg & data rates may apply\. Reply STOP to ' \+\s*'unsubscribe\. Support: \(859\) 420-7382\./.test(s)
        && /Welcome back to NBD Pro SMS\./.test(s));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nS — self-checks');
  // ════════════════════════════════════════════════════════════════════
  ok('S: the stripper removes trailing, whole-line and block comments (CRLF input)',
    stripComments('a(); // x\r\n// whole\r\n/* b\r\n c */ d();') === 'a(); \n\n\n d();');
  ok('S: the stripper keeps a URL inside a string literal', /https:\/\/x\.test/.test(stripComments("const u = 'https://x.test'; // c")));
  ok('S: braceBlock scopes to the matching brace', braceBlock('f() { a { b } c } d', 0) === '{ a { b } c }');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
