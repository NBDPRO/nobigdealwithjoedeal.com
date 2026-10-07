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
 * is real on origin/main 332e635e and is pinned as `KNOWN BUG R6-<area>-<n>`:
 * the assertion holds TODAY's wrong behaviour exactly, so the suite is green,
 * and the PR that fixes a bug must flip its pin (to `FIXED (was KNOWN BUG …)`
 * with the correct behaviour) — with Jo's OK. The report with evidence,
 * effect and suggested fix: nbd-content/review-r6-2026-10-07.md.
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
    const upd = (env.writes[0] && env.writes[0].upd) || {};
    ok('R6-2-1 context: Save re-totals the estimate by the quote rule (#2198): $11,000 + $770 tax → $11,775',
      c(upd.grandTotal) === 1177500 && c(upd.subtotal) === 1100000 && c(upd.tax) === 77000, JSON.stringify({ g: upd.grandTotal, s: upd.subtotal, t: upd.tax }));
    const est2 = Object.assign({}, est, upd);
    const contract = CER.buildDisplayRows(est2);
    const inv = invoiceOf(est2);
    const linesPlusTax = sumCents(inv.items) + c(inv.tax);
    ok('KNOWN BUG R6-2-1 (reported 2026-10-07): "Save to estimate" on a V2 estimate writes lineItems but leaves rows, and every rows reader '
      + 'ignores the edit — the e-sign contract / estimate link print $10,775 of lines (no upgrade) under "Contract price $11,775", '
      + 'and the CRM invoice / deposit + final drafts carry $10,775 of lines + tax against a $11,775 total, so createStripePaymentLink '
      + 'refuses the pay link. Expected one set of lines that foots to the price on every surface',
      !('rows' in upd) && Array.isArray(upd.lineItems) && upd.lineItems.length === 3
        && sumCents(contract) === 1077500 && c(est2.grandTotal) === 1177500
        && !contract.some((r) => /upgrade/i.test(r.desc))
        && linesPlusTax === 1077500 && c(inv.total) === 1177500,
      JSON.stringify({ rowsWritten: 'rows' in upd, contract: sumCents(contract), price: est2.grandTotal, invoiceLinesPlusTax: linesPlusTax, invoiceTotal: inv.total }));
    // R6-2-7 (sibling path of R2-2-3): the re-total never reaches lead.jobValue.
    ok('KNOWN BUG R6-2-7 (reported 2026-10-07), Save half: the re-totalled estimate ($11,775) is the lead\'s primary, but Save writes '
      + 'ONLY the estimate — lead.jobValue stays $10,700 on the kanban, Home KPIs, Numbers and crm_summary (the R2-2-3 re-stamp lives '
      + 'only in _saveEstimate). Expected jobValue to follow a re-totalled primary estimate',
      env.writes.length === 1 && env.writes[0].ref.col === 'estimates', JSON.stringify(env.writes.map((w) => w.ref)));
  }
  {
    // R6-2-7, logged-estimate editor half (dashboard-widgets.js).
    const src = stripComments(rd('docs/pro/js/dashboard-widgets.js'));
    const body = blockAt(src, 'function _openLoggedEstimateEditor(est) {');
    ok('R6-2-7 anchor: _openLoggedEstimateEditor is found and still writes grandTotal from the edited amount',
      !!body && /grandTotal:\s*dollars/.test(body));
    ok('KNOWN BUG R6-2-7 (reported 2026-10-07), logged-estimate half: editing a logged estimate\'s amount rewrites its grandTotal but '
      + 'never the lead\'s jobValue, even when it is the primary estimate. Expected the same re-stamp as _saveEstimate\'s edit branch',
      !!body && !/jobValue/.test(body) && !/['"]leads['"]/.test(body));
  }

  // R6-2-2 ─ a SIGNED estimate can be re-saved at a new price
  {
    const src = stripComments(rd('docs/pro/js/dashboard-bootstrap.module.js'));
    const fn = blockAt(src, 'window._saveEstimate = async (data) => {');
    const editBranch = fn ? blockAt(fn, 'if (editId) {') : null;
    ok('R6-2-2 anchor: window._saveEstimate and its edit branch are found; the edit branch updates the estimate and re-stamps jobValue (R2-2-3)',
      !!editBranch && /updateDoc\(doc\(db,\s*'estimates',\s*editId\)/.test(editBranch) && /jobValue:\s*newVal/.test(editBranch));
    const v2 = stripComments(rd('docs/pro/js/estimate-v2-ui.js'));
    ok('KNOWN BUG R6-2-2 (reported 2026-10-07), save half: nothing refuses (or turns into a change order) a re-save of an estimate whose '
      + 'contract is signed (signatureStatus "signed") — the edit branch and the V2 builder never read signatureStatus — so after a $14,500 '
      + 'signature a reopened estimate saved at $16,200 moves jobValue, the portal card ("✓ Signed" beside $16,200) and the estimate link, '
      + 'while the locked signed contract says $14,500. Expected a signed estimate to be locked (or revised only through a change order)',
      !!editBranch && !/signatureStatus/.test(editBranch) && !/signatureStatus/.test(v2));
    // …and the install-day final draft bills the revision, crediting the
    // whole-job signing invoice as a "deposit".
    const lead = { userId: 'u', primaryEstimateId: 'E', address: OH, state: 'OH', activeJobId: 'J1' };
    const est1 = { userId: 'u', leadId: 'L', grandTotal: 14500, subtotal: 14500, tax: 0, taxRate: 0, mode: 'cash', jobId: 'J1', addr: OH, createdAt: 1,
      rows: [{ desc: 'Roof', qty: '1', retailTotal: 14500, total: 14500 }] };
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed', lead, est: est1, estimateId: 'E', existingInvoices: [] });
    const signing = Object.assign({ id: dd.invoiceId }, dd.invoice, { status: 'partial', amountPaid: 7250, balanceDue: 7250, depositPaid: true, createdAt: 2 });
    const est2 = Object.assign({}, est1, { grandTotal: 16200, subtotal: 16200,
      rows: est1.rows.concat([{ desc: 'Upgrade', qty: '1', retailTotal: 1700, total: 1700 }]) });
    const fd = DDL.decideFinalDraft({ leadId: 'L', lead, est: est2, estimateId: 'E', invoices: [signing] });
    const credit = fd.invoice && fd.invoice.items.find((i) => i.credit === true);
    ok('KNOWN BUG R6-2-2 (reported 2026-10-07), billing half: after the post-signature edit the install-day final draft bills $1,700 more '
      + '(total owed $16,200 against a $14,500 signature) and prints the $14,500 signing invoice as "Less deposit invoiced −$14,500" although '
      + 'its deposit was $7,250. Expected the signed price to stand until a change order is signed',
      dd.action === 'create' && dd.invoice.total === 14500 && dd.invoice.depositAmount === 7250
        && fd.action === 'create' && c(fd.invoice.total) === 170000 && !!credit && /^Less deposit invoiced/.test(credit.description) && c(credit.total) === -1450000,
      JSON.stringify({ dd: dd.action, fd: fd.action, total: fd.invoice && fd.invoice.total, credit: credit && [credit.description, credit.total] }));
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
    ok('KNOWN BUG R6-2-3 (reported 2026-10-07): on a line-item estimate the acceptance is only recorded (recorded-differs, #2245 kept '
      + 'line-item as record-only) and the automatic signing-day draft bills the REP\'s tier — $10,700 with a $5,350 deposit — while the '
      + 'homeowner accepted $9,500 / $4,750 and the "use it?" chip is still pending. Expected the draft to wait for the chip, or bill the accepted tier',
      plan.reason === 'recorded-differs' && dd.action === 'create' && c(dd.invoice.total) === 1070000 && c(dd.invoice.depositAmount) === 535000,
      JSON.stringify({ reason: plan.reason, action: dd.action, total: dd.invoice && dd.invoice.total, dep: dd.invoice && dd.invoice.depositAmount }));
  }

  // R6-2-4 ─ the chip's "Use it" on a line-item estimate
  {
    const chip = require(path.join(DG_DIR, 'accepted-tier-chip.js'));
    const est = v2LineItemEstimate({ id: 'E', acceptedTier: 'good', acceptedPrice: 9500 });
    const lead = { primaryEstimateId: 'E', jobValue: 10700, address: OH };
    const pick = chip.pendingPick(lead, [est]);
    const w = pick ? chip.usePatch(lead, pick, { depositRule: DR }) : { estimate: {} };
    const est2 = Object.assign({}, est, w.estimate);
    const contract = CER.buildDisplayRows(est2);
    const inv = invoiceOf(est2);
    ok('R6-2-4 context: "Use it" re-tiers the totals to $9,500 (subtotal $8,878.50 + tax $621.50) and moves jobValue',
      c(est2.grandTotal) === 950000 && c(est2.subtotal) === 887850 && c(est2.tax) === 62150 && w.lead && w.lead.jobValue === 9500);
    ok('KNOWN BUG R6-2-4 (reported 2026-10-07): "Use it" on a line-item estimate rewrites grandTotal / subtotal / tax but not the rows, '
      + 'so the contract and estimate link print $10,621.50 of lines (Preferred-priced rows + the new tax) under a $9,500 price and the '
      + 'invoice carries $10,621.50 of lines + tax against $9,500 — the pay link is refused. Expected the chip to re-price the rows (or '
      + 'refuse a line-item estimate and send the rep to the builder)',
      sumCents(contract) === 1062150 && sumCents(inv.items) + c(inv.tax) === 1062150 && c(inv.total) === 950000,
      JSON.stringify({ contract: sumCents(contract), inv: sumCents(inv.items) + c(inv.tax), total: inv.total }));
  }

  // R6-2-5 ─ a stale deal room overrides a re-saved estimate
  {
    // The deal went out at Preferred $12,000. The rep then re-saved the
    // per-SQ estimate at $13,000 without re-sending; the homeowner accepts
    // Preferred on the old link (deal_rooms tierPrices snapshot $12,000).
    const est = { userId: 'u', leadId: 'L', priceMode: 'per-sq', prices: { good: 11500, better: 13000, best: 16000 }, tier: 'better', selectedTier: 'better',
      grandTotal: 13000, subtotal: 12093.02, tax: 906.98, taxRate: 0.075, mode: 'cash', jobId: 'J1', addr: OH };
    const lead = { userId: 'u', primaryEstimateId: 'E', jobValue: 13000, address: OH, state: 'OH' };
    const plan = DAT.planAcceptedTier({ lead, estimate: est, estimateId: 'E', leadId: 'L', ownerUid: 'u', tier: 'better', price: 12000, dealId: 'D', now: 1 });
    const src = stripComments(rd('docs/pro/js/dashboard-bootstrap.module.js'));
    const fn = blockAt(src, 'window._saveEstimate = async (data) => {');
    const editBranch = fn ? blockAt(fn, 'if (editId) {') : null;
    ok('R6-2-5 anchor: _saveEstimate\'s edit branch is found', !!editBranch);
    ok('KNOWN BUG R6-2-5 (reported 2026-10-07; which price wins needs Jo): re-saving an estimate never refreshes its open deal room '
      + '(only "Send to homeowner" calls CloseBoard.createFromEstimate), so the homeowner\'s link keeps the old $12,000 while the estimate, '
      + 'jobValue and portal say $13,000 — and accepting the same tier at the stale price "applies" it, rewriting the revised estimate, '
      + 'prices{} and jobValue back to $12,000. Expected the deal page to follow a re-save (or a stale acceptance to stop for the rep)',
      !!editBranch && !/CloseBoard|deal_rooms|createFromEstimate/.test(editBranch)
        && plan.reason === 'applied' && plan.estimate.grandTotal === 12000 && plan.estimate.prices.better === 12000 && plan.lead.jobValue === 12000,
      JSON.stringify({ reason: plan.reason, grand: plan.estimate && plan.estimate.grandTotal, jv: plan.lead && plan.lead.jobValue }));
  }

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
    // balanceDue / depositPaid and leaves the link fields alone (pinned below).
    const after = Object.assign({}, minted, { status: 'partial', amountPaid: 6000, balanceDue: 6000, depositPaid: true });
    const card = IC.portalBalanceCard(after, after.stripePaymentLink);
    const s = stripComments(rd('functions/stripe.js'));
    const pi = s.indexOf("if (event.type === 'payment_intent.succeeded')");
    const upd = pi === -1 ? null : blockAt(s, 'tx.update(invRef, {', "if (event.type === 'payment_intent.succeeded')");
    ok('R6-2-6 anchor: the payment_intent.succeeded credit (tx.update(invRef, {…})) is found and still writes amountPaid / depositPaid',
      !!upd && /amountPaid:\s*newPaid/.test(upd) && /depositPaid:/.test(upd));
    ok('KNOWN BUG R6-2-6 (reported 2026-10-07): after the homeowner pays the $6,000 deposit online, the credit leaves stripePaymentLink / '
      + 'stripeChargeCents in place, and because the spent deposit charge ($6,000) equals the $6,000 balance, the portal\'s Balance Due '
      + 'card (and the tracker\'s "Pay your invoice") offers the SPENT deposit link as Pay Now — a single-use link that no longer opens, '
      + 'or the already-paid deposit invoice. Expected no Pay Now until a balance link is minted (stamp the kind, or clear the link on credit)',
      !!upd && !/stripePaymentLink|stripeChargeCents|stripeChargeKind|stripeHostedUrl/.test(upd)
        && card.kind === 'balance' && card.amountCents === 600000 && card.stripePaymentLink === 'https://buy.stripe.test/deposit',
      JSON.stringify(card));
  }

  // ── Dashboards (the second half of area 2) ─────────────────────────────
  console.log('\nArea 2 — dashboards');

  // R6-2-8 ─ catch-up "Paid in full?" + a Stripe payment assigned later
  {
    const IP = require(path.join(DG_DIR, 'invoice-pipeline.js'));
    const CL = require(path.join(DG_DIR, 'catchup-logic.js'));
    const SL = F('stripe-ledger-logic.js');
    const DAY = 86400000, NOW = Date.parse('2026-10-07T16:00:00Z');
    // A $12,000 job whose $6,000 card deposit sits unmatched in the Stripe
    // ledger's review queue, so the lead shows $0 collected and the deck asks.
    const est = { id: 'estI', leadId: 'I', grandTotal: 12000, subtotal: 12000, tax: 0, taxRate: 0, rows: [{ description: 'Roof', qty: 1, unitPrice: 12000, total: 12000 }] };
    const t = IP.recordPaymentTarget({ lead: { id: 'I', activeJobId: 'j1', jobValue: 12000 }, invoices: [], estimate: est, estimateId: 'estI', totalsOpts: { estimateValue: CER.estimateValue } });
    const plan = CL.paidInFullPlan(t);
    const inv0 = { id: 'iI', leadId: 'I', jobId: 'j1', status: 'draft', total: 12000, amountPaid: 0, balanceDue: 12000, payments: [] };
    const ap = IP.applyPaymentToInvoice(inv0, { amount: plan.cents / 100, at: new Date(NOW - 2 * DAY), method: 'check' });
    const invI = Object.assign({}, inv0, ap.patch);
    // Jo then assigns the Stripe deposit (paid 30 days ago) to the customer.
    const mv = { key: 'ch_dep', amountCents: 600000, atMs: NOW - 30 * DAY, method: 'card' };
    const dup = SL.findManualDuplicate([invI], mv);
    const pick = SL.pickInvoice([invI], { amountCents: 600000 });
    const mirror = SL.mirrorInvoice({ object: 'charge', id: 'ch_dep', amount: 600000, amount_captured: 600000, created: Math.floor((NOW - 30 * DAY) / 1000) }, { id: 'I' }, 'u1', NOW, null);
    const credit = SL.planCredit(mirror, mv);
    const mirrored = Object.assign({}, mirror, { payments: [credit.payment], amountPaid: credit.amountPaid, balanceDue: credit.balanceDue, status: credit.status });
    const win = { addEventListener() {} }; win.window = win;
    const sb = { window: win, console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Object };
    vm.createContext(sb);
    vm.runInContext(rd('docs/pro/js/collected-revenue.js'), sb, { filename: 'collected-revenue.js' });
    const byLead = win.NBDRevenue.collectedByLead([invI, mirrored], null, null);
    ok('R6-2-8 context: the deck offers "Paid in full?" for the estimate total ($12,000) and records it as one payment',
      plan.ok === true && plan.cents === 1200000 && invI.status === 'paid' && c(invI.amountPaid) === 1200000);
    ok('KNOWN BUG R6-2-8 (reported 2026-10-07): assigning the Stripe deposit afterwards finds no duplicate (amounts differ) and no open '
      + 'invoice, so it mirrors a NEW invoice — the $12,000 job reads $18,000 collected on Home, Numbers, the digest and collected_revenue. '
      + 'Expected the assignment to stop (or "Paid in full?" to wait) while the job is already paid in full',
      dup === null && pick && pick.invoiceId === null && byLead.I === 18000, JSON.stringify({ dup, pick, byLead }));
  }

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

  // R6-2-10 ─ agent job_profit drops a repeat customer's finished job
  {
    const L = F('agent-mcp-logic.js');
    const NOW = Date.parse('2026-10-07T16:00:00Z'), DAY = 86400000;
    const leads = [
      { id: 'A', userId: 'u1', firstName: 'A', stage: 'closed', jobValue: 10000, closedAt: NOW - 5 * DAY, createdAt: NOW - 30 * DAY, updatedAt: NOW - 5 * DAY, stageStartedAt: NOW - 5 * DAY },
      // G: first job finished and paid; the customer card now sits on its SECOND job (signed).
      { id: 'G', userId: 'u1', firstName: 'G', stage: 'contract_signed', jobValue: 8000, closedAt: NOW - 2 * DAY, createdAt: NOW - 90 * DAY, updatedAt: NOW - 2 * DAY, stageStartedAt: NOW - 2 * DAY, activeJobId: 'j2' },
    ];
    const pay = (amount, at) => ({ amount, at: new Date(at) });
    const invoices = [
      { id: 'iA', leadId: 'A', status: 'paid', total: 10000, amountPaid: 10000, balanceDue: 0, payments: [pay(10000, NOW - 5 * DAY)] },
      { id: 'iG1', leadId: 'G', jobId: 'j1', status: 'paid', total: 10000, amountPaid: 10000, balanceDue: 0, payments: [pay(10000, NOW - 45 * DAY)] },
    ];
    const expenses = [{ id: 'x1', leadId: 'G', costType: 'direct', amountCents: 600000, taxCents: 0 }];
    const jp = L.jobProfit(leads, invoices, expenses, NOW, { days: 365 });
    ok('KNOWN BUG R6-2-10 (reported 2026-10-07): the agent\'s job_profit lists only customers whose CARD is won, so a repeat customer '
      + 'whose card moved on to a signed second job loses the first, finished job — its $10,000 collected and $6,000 cost vanish from the '
      + 'totals. Expected job_profit to walk job records (#2247 jobRecords) like the other surfaces',
      Array.isArray(jp.jobs) && !jp.jobs.some((j) => j.lead_id === 'G') && jp.totals.collected === 10000, JSON.stringify({ rows: jp.jobs.map((j) => j.lead_id), totals: jp.totals }));
  }

  // R6-2-11 ─ the Team Leaderboard widget's "Booked (all time)" leaves out signed contracts
  {
    const src = stripComments(rd('docs/pro/js/widgets.js'));
    const at = src.indexOf("'<div class=\"wg-tiny\">Booked (all time)</div>'");
    const win = at === -1 ? '' : src.slice(Math.max(0, at - 2500), at);
    ok('R6-2-11 anchor: the widget labelled "Booked (all time)" is found with its won-job filter', at !== -1 && /byRep\[owner\]\.deals\+\+/.test(win));
    ok('KNOWN BUG R6-2-11 (reported 2026-10-07): the widget, labelled "Booked" by #2247, counts only stage roles won / job — a signed '
      + 'contract (role active) is left out, though since #2252 a signed contract is booked on Home, Analytics, the kanban, crm_summary and '
      + 'the digest. Expected the shared sale test (NBDNumbers.isSale)',
      /if \(role === 'won' \|\| role === 'job'\)/.test(win) && !/isSale|contract_signed/.test(win));
  }

  // R6-2-12 ─ Analytics and Money show different gross margins for the same jobs
  {
    const ak = stripComments(rd('docs/pro/js/analytics-kpi.js'));
    const blk = ak.slice(ak.indexOf('var wonRev = 0, wonDirect = 0, costedJobs = 0;'), ak.indexOf('var expGrossMargin'));
    const md = stripComments(rd('docs/pro/js/money-dashboard.js'));
    ok('R6-2-12 anchor: Analytics\' won-job gross margin block and the Money dashboard\'s job records are found',
      blk.length > 40 && /jobRecs/.test(md));
    ok('KNOWN BUG R6-2-12 (reported 2026-10-07): Analytics computes "gross margin" over won CUSTOMERS (leads.filter(_isWon), the card\'s '
      + 'jobValue) while the Money dashboard pools won JOB records — a repeat customer\'s second job, or a card on a later stage, makes the '
      + 'two pages print different margins for the same costs (50% vs 42% on the review fixture). Expected one pooling',
      /var wonCustomers = leads\.filter\(function \(l\) \{ return _isWon\(l\); \}\);/.test(blk) && !/recordsFor|jobRecs|jobRecords/.test(blk));
  }

  // R6-2-13 ─ Numbers' source table / lead-source ROI read customers, not jobs
  {
    const roi = stripComments(rd('docs/pro/js/lead-source-roi.js'));
    const nl = stripComments(rd('docs/pro/js/numbers-logic.js'));
    const wr = nl.indexOf('var allTable = sourceTable(');
    ok('R6-2-13 anchor: lead-source-roi.js and the week review call sourceTable', /Nn\.sourceTable\(/.test(roi) && wr !== -1);
    ok('KNOWN BUG R6-2-13 (reported 2026-10-07, low): the lead-source table and the week review\'s source table are fed customer cards, '
      + 'so a repeat customer\'s second booked job is missing ($89,500 vs the kanban\'s $99,500 on the review fixture). Expected job records '
      + 'for the booked figures (counts can stay per customer)',
      /Nn\.sourceTable\(leads \|\| \[\]/.test(roi) && /sourceTable\(i\.leads \|\| \[\]/.test(nl.slice(wr, wr + 120)));
  }

  // R6-2-14 ─ Leaderboard page "Deals" uses the old won test and the last edit date
  {
    const lb = stripComments(rd('docs/pro/js/pages/leaderboard.js'));
    const cm = blockAt(lb, 'function computeMetrics() {');
    ok('R6-2-14 anchor: computeMetrics is found and still counts totalDeals from wonLeads', !!cm && /const totalDeals = wonLeads\.length;/.test(cm));
    ok('KNOWN BUG R6-2-14 (reported 2026-10-07, low): the Leaderboard page counts a deal only on a WON stage role, dated by the lead\'s '
      + 'updatedAt — signed contracts are left out and an old win counts again when the card is edited. Expected isSale + closedAt, like Home',
      !!cm && /_stageRole === 'won'/.test(cm) && /isInPeriod\(l\.updatedAt\)\)/.test(cm) && !/isSale|closedAt/.test(cm));
  }

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
    ok('KNOWN BUG R6-3-1 (reported 2026-10-07): "Not interested. Stop.", "No thanks stop", "stop sending these" and "I no longer want texts '
      + 'from you" are NOT opt-outs — incomingSMS records nothing and writes an AI reply draft a rep can send. Expected a final / standalone '
      + 'STOP word and "stop sending…" / "no longer want…" to revoke consent',
      got.every((g) => g === null), JSON.stringify(got));
  }

  // R6-3-2 ─ pre-filled customer texts that never ask "may I text?"
  {
    const sites = [
      ['docs/pro/js/customer-gallery-share.js', /`sms:\$\{phone\}\?body=/],
      ['docs/pro/js/dashboard-api.js', /window\.open\('sms:' \+ cleanPhone/],
      ['docs/pro/js/customer-bootstrap.module.js', /smsBtn\.href = `sms:\$\{cleanPhone\}\?body=/],
      ['docs/pro/js/estimate-v2-ui.js', /const sms = _smsHref\(s\.phone, s\.text\);/],
      ['docs/pro/js/care-plan-crm.js', /smsHref\(o\.phone, text\)/],
    ];
    const found = sites.map(([f, re]) => [f, re.test(stripComments(rd(f)))]);
    ok('R6-3-2 anchor: each of the five customer sms: hand-offs is found', found.every((x) => x[1]), JSON.stringify(found));
    const unchecked = sites.filter(([f]) => !/NBDPhoneShare|checkText|phoneTextAction/.test(stripComments(rd(f))));
    ok('KNOWN BUG R6-3-2 (reported 2026-10-07; R2-3-2 only partly fixed): the Text Portal button, the portal-link share, Text Booking Link, '
      + 'the V2 estimate share box (incl. its automatic Messages hand-off) and the Care Plan "Text it" open Messages pre-filled without the '
      + 'server check #2246 added to NBDPhoneShare — a customer who replied STOP, is on the Do Not Text list, or it is 11pm for, still gets '
      + 'the link. Expected every customer hand-off to go through NBDPhoneShare.share / checkText',
      unchecked.length === 5, JSON.stringify(unchecked.map((x) => x[0])));
  }

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
    const failedBranch = blockAt(panel, "} else if (st === 'failed') {");
    ok('KNOWN BUG R6-3-3 (reported 2026-10-07): an error whose outcome is unknown (a dropped connection after Twilio took the message, or a '
      + 'failed note write after it was sent) marks the draft failed / twilio_error; the panel says "Did NOT send" and puts it back to '
      + 'pending, so the rep re-approves and the homeowner gets the reply twice. Expected an "unknown — check before re-sending" state and no auto-revert',
      first.status === 'failed' && first.failureReason === 'twilio_error' && w.twilioCalls.length === 2
        && !!failedBranch && /updateDoc\(ref, \{ status: 'pending' \}\)/.test(failedBranch),
      JSON.stringify({ first: [first.status, first.failureReason], twilio: w.twilioCalls.length }));
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
    ok('KNOWN BUG R6-3-5 (reported 2026-10-07): company A records "They replied STOP" (the reply reached the owner\'s own phone); the '
      + 'homeowner later texts START to NBD\'s shared Twilio number, and company A may text them again — START clears every company\'s '
      + 'STOP-sourced entry. Expected START on one line to lift only the opt-outs that line received',
      rec && rec.ok === true && before && before.ok === false && before.code === 'opted_out' && after && after.ok === true,
      JSON.stringify({ rec, before: before && before.code, after: after && after.ok }));
  }

  // R6-3-6 ─ the no-customer check path skips texting hours
  {
    const token = { uid: NBD, companyId: NBD, role: 'company_admin' };
    const w = W.makeWorld({ clockMs: LATE_ET, docs: { 'leads/L1': { userId: NBD, companyId: NBD, phone: '8595550134', state: 'KY', zip: '41011' } } });
    const m = W.load(w, 'phone-text-check.js');
    const withLead = await handle(m, token, { action: 'check', phone: '8595550134', leadId: 'L1', recipient: 'homeowner' });
    const numberOnly = await handle(m, token, { action: 'check', phone: '8595550134', recipient: 'number' });
    ok('KNOWN BUG R6-3-6 (reported 2026-10-07): at 11:30pm Eastern the check refuses the homeowner when the lead is passed (quiet_hours) '
      + 'but allows the same number through the no-customer path, which homeowner sends use (close-board deals with no lead, the '
      + 'nbd-comms Messages fallback). Expected the default 8am–9pm Eastern window unless the recipient is crew',
      withLead && withLead.ok === false && withLead.code === 'quiet_hours' && numberOnly && numberOnly.ok === true,
      JSON.stringify({ withLead: withLead && withLead.code, numberOnly: numberOnly && numberOnly.ok }));
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
  {
    const planted = 'window._saveEstimate = async (data) => { if (editId) { await updateDoc(doc(db,\'estimates\',editId)); if (data.signatureStatus === \'signed\') return; } }';
    const eb = blockAt(blockAt(planted, 'window._saveEstimate = async (data) => {'), 'if (editId) {');
    ok('S: R6-2-2 detector sees a planted signatureStatus guard in the edit branch', /signatureStatus/.test(eb));
    const commented = 'function _openLoggedEstimateEditor(est) { const patch = { grandTotal: dollars }; // TODO jobValue\n }';
    ok('S: R6-2-7 detector ignores jobValue that is only in a comment', !/jobValue/.test(blockAt(stripComments(commented), 'function _openLoggedEstimateEditor(est) {')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
