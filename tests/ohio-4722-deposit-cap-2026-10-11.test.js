/**
 * tests/ohio-4722-deposit-cap-2026-10-11.test.js — the Ohio ORC 4722.04
 * down-payment cap, proven on the pure rule (docs/pro/js/deposit-rule.js) and
 * then on every surface that prints or collects a deposit.
 *
 * Jo's decision (2026-10-11): on an Ohio PROPERTY, a contract at or above
 * $25,000 takes no more than 10% before work begins — plus up to 75% of any
 * special-order, non-returnable item, a milestone payment when materials are
 * delivered / work begins, no cap on a construction-loan job — and Kentucky
 * insurance jobs stay exactly as they were (nothing at signing, KRS 367.626).
 * Counsel should confirm; see documentation/projects/OHIO-4722-DEPOSIT-CAP-2026-10-11.md.
 *
 * Expected figures are written out by hand, never computed by the rule, so a
 * broken rule reddens the assertion that names the broken behaviour.
 *
 * Run: node tests/ohio-4722-deposit-cap-2026-10-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => String(s).replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.OH_VERBOSE) console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? ' -- ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

// Break-test hook: DEPOSIT_RULE_PATH points the suite at a mutated copy.
const RULE_PATH = process.env.DEPOSIT_RULE_PATH || path.join(ROOT, 'docs/pro/js/deposit-rule.js');
const R = require(RULE_PATH);
const OH = '12 Oak St, Cincinnati, OH 45202';
const KY = '1 Main St, Covington, KY 41011';
const IN = '5 Elm Ave, Lawrenceburg, IN 47025';

const cents = (p) => p.depositCents;
const sum = (rows) => rows.reduce((a, r) => a + (r.amountCents || 0), 0);
const rowOf = (p, k) => (p.rows || []).filter((r) => r.key === k)[0];
function invariants(name, p) {
  ok(name + ': deposit + balance === total', p.depositCents + p.balanceCents === p.totalCents, JSON.stringify([p.depositCents, p.balanceCents, p.totalCents]));
  ok(name + ': the rows add up to the total', sum(p.rows) === p.totalCents, sum(p.rows) + ' vs ' + p.totalCents);
  ok(name + ': whole cents throughout', p.rows.every((r) => r.amountCents == null || Number.isInteger(r.amountCents)));
}

// ── 1. Boundaries ────────────────────────────────────────────────────────
section('1. Ohio cash job — the $25,000 boundary');
{
  const below = R.compute({ total: 24999.99, address: OH });
  ok('$24,999.99 Ohio cash: not covered, 50% as before ($12,500)', cents(below) === 1250000, cents(below));
  ok('$24,999.99: no Ohio block, no warning', !below.ohio && !below.stateWarning);
  const at = R.compute({ total: 25000.00, address: OH });
  // ORC 4722.01(C): the covered contract is one "for an amount exceeding"
  // $25,000 (legal cross-check 2026-10-16), so exactly $25,000.00 is NOT capped.
  ok('$25,000.00 Ohio cash: not covered (4722.01(C) "exceeding"), 50% as before ($12,500)', cents(at) === 1250000, cents(at));
  ok('$25,000.00: no Ohio block, no warning', !at.ohio && !at.stateWarning);
  const over = R.compute({ total: 25000.01, address: OH });
  ok('$25,000.01 Ohio cash: covered, signing $2,500 (10% rounded DOWN to the $25 step, never over the cap)', cents(over) === 250000, cents(over));
  ok('$25,000.01: second payment $10,000 due on delivery / start', rowOf(over, 'milestone') && rowOf(over, 'milestone').amountCents === 1000000);
  ok('$25,000.01: cap is never exceeded', cents(over) <= Math.floor(2500001 * 10 / 100));
  invariants('$24,999.99', below); invariants('$25,000.00', at); invariants('$25,000.01', over);
  const odd = R.compute({ total: 27432.18, address: OH });
  ok('$27,432.18: signing $2,725 (10% = $2,743.21, down to the $25 step)', cents(odd) === 272500, cents(odd));
  ok('$27,432.18: second payment $11,000 (50% target $13,725 less the signing deposit)', rowOf(odd, 'milestone').amountCents === 1100000);
  invariants('$27,432.18', odd);
  ok('plan.kind says ohio-cap', odd.kind === 'ohio-cap' && odd.ohio && odd.ohio.applies === true && odd.ohio.reduced === true);
  ok('the customer summary names the due-on-delivery payment and the signing deposit', /10% deposit of \$2,725 due at signing/.test(odd.summary) && /due when your materials are delivered or work begins/.test(odd.summary), odd.summary);
  ok('payment 2 is never described as due at signing', rowOf(odd, 'milestone').due !== 'At signing');
}

// ── 2. Where the property is — not where the company is ──────────────────
section('2. Property state decides, never the company\'s home state');
{
  ok('Kentucky cash job $30,000: 50% unchanged', cents(R.compute({ total: 30000, address: KY })) === 1500000);
  ok('Indiana cash job $30,000: not capped', cents(R.compute({ total: 30000, address: IN })) === 1500000);
  ok('company state Ohio does not cap a Kentucky property', cents(R.compute({ total: 30000, address: KY, companyState: 'OH', state: '' })) === 1500000);
  ok('explicit state field OH caps with no street address', cents(R.compute({ total: 30000, state: 'OH' })) === 300000);
  ok('lead object supplies the Ohio address', cents(R.compute({ total: 30000, lead: { address: OH } })) === 300000);
  ok('ZIP-only Ohio (45202) caps', cents(R.compute({ total: 30000, zip: '45202' })) === 300000);
  const unk = R.compute({ total: 30000 });
  ok('no state at all: no cap (conservative) ...', cents(unk) === 1500000);
  ok('... but a visible warning on the deposit line', /Property state not readable/.test(unk.stateWarning || '') && /could not be checked/.test(unk.repNote), unk.repNote);
  ok('warning also says the deposit is above 10%', /above 10%/.test(unk.stateWarning));
  ok('small job with no state: no warning (below the threshold)', !R.compute({ total: 8000 }).stateWarning);
  ok('Kentucky job: no warning', !R.compute({ total: 30000, address: KY }).stateWarning);
  ok('warning never reaches the customer-facing summary', !/state not readable/i.test(unk.summary + unk.terms));
}

// ── 3. Special-order allowance ───────────────────────────────────────────
section('3. Special-order, non-returnable items (75% on top of the 10%)');
{
  const so = R.compute({ total: 30000, address: OH, specialOrder: 4000 });
  ok('$30,000 + $4,000 special order: signing = 10% $3,000 + 75% x $4,000 = $6,000', cents(so) === 600000, cents(so));
  ok('the special-order amount is its own visible row', rowOf(so, 'special-order').amountCents === 300000 && /75% of \$4,000/.test(rowOf(so, 'special-order').label));
  ok('second payment is the 50% target less the prepaid $6,000 = $9,000; balance stays $15,000', rowOf(so, 'milestone').amountCents === 900000 && rowOf(so, 'balance').amountCents === 1500000);
  invariants('special order', so);
  ok('special order bigger than the job is clamped to the job', cents(R.compute({ total: 30000, address: OH, specialOrder: 90000 })) <= 3000000);
  ok('zero / negative / junk special order changes nothing', [0, -500, 'abc', ''].every((v) => cents(R.compute({ total: 30000, address: OH, specialOrder: v })) === 300000));
  ok('specialOrderCents is accepted too', cents(R.compute({ total: 30000, address: OH, specialOrderCents: 400000 })) === 600000);
  ok('special order does nothing on a KY job', cents(R.compute({ total: 30000, address: KY, specialOrder: 4000 })) === 1500000);
  ok('the allowance can never lift a deposit above what the rule itself asked', cents(R.compute({ total: 30000, address: OH, specialOrder: 29000, overridePct: 20 })) <= 600000 + 2175000);
}

// ── 4. Milestone schedule ────────────────────────────────────────────────
section('4. Config-driven milestone schedule (10 / 40 / 50)');
{
  const off = R.compute({ total: 30000, address: OH, config: { OH_MILESTONE_ENABLED: 0 } });
  ok('milestone off: 10% at signing, the rest on completion', cents(off) === 300000 && !rowOf(off, 'milestone') && rowOf(off, 'balance').amountCents === 2700000);
  const sched = R.compute({ total: 30000, address: OH, config: { OH_MILESTONE_PCT: 30 } });
  ok('a 10 / 30 / 60 schedule', rowOf(sched, 'milestone').amountCents === 900000 && rowOf(sched, 'balance').amountCents === 1800000, JSON.stringify(sched.rows));
  const cap5 = R.compute({ total: 30000, address: OH, config: { OH_CAP_PCT: 5, OH_MILESTONE_PCT: 45 } });
  ok('cap pct is configurable (5%)', cents(cap5) === 150000);
  const cfg = R.config({ OH_CAP_PCT: 90, OH_MILESTONE_PCT: 90 });
  ok('config: schedule can never exceed the whole contract', cfg.OH_CAP_PCT + cfg.OH_MILESTONE_PCT <= 100, JSON.stringify(cfg));
  ok('config: junk falls back to the defaults per field', R.config({ OH_CAP_PCT: 'x', OH_CAP_MIN_CENTS: -1 }).OH_CAP_PCT === 10 && R.config({ OH_CAP_MIN_CENTS: -1 }).OH_CAP_MIN_CENTS === 2500000);
  ok('config: the cap can be switched off', cents(R.compute({ total: 30000, address: OH, config: { OH_CAP_ENABLED: 0 } })) === 1500000);
  ok('config: the threshold is configurable', cents(R.compute({ total: 15000, address: OH, config: { OH_CAP_MIN_CENTS: 1000000 } })) === 150000);
  ok('a tenant\'s own 0% / 5% rule is never raised by the milestone', cents(R.compute({ total: 30000, address: OH, config: { CASH_DEPOSIT_PCT: 5, CASH_NO_DEPOSIT_UNDER_CENTS: 0 } })) === 150000
    && !rowOf(R.compute({ total: 30000, address: OH, config: { CASH_DEPOSIT_PCT: 5, CASH_NO_DEPOSIT_UNDER_CENTS: 0 } }), 'milestone'));
  ok('DEFAULTS carry the Ohio keys', R.DEFAULTS.OH_CAP_PCT === 10 && R.DEFAULTS.OH_SPECIAL_ORDER_PCT === 75 && R.DEFAULTS.OH_MILESTONE_PCT === 40 && R.DEFAULTS.OH_CAP_MIN_CENTS === 2500000);
}

// ── 5. Construction loan ─────────────────────────────────────────────────
section('5. Construction-loan jobs are not capped');
{
  const loan = R.compute({ total: 30000, address: OH, constructionLoan: true });
  ok('loan flag: the rule\'s 50% stands', cents(loan) === 1500000);
  ok('loan flag is recorded and explained to the rep', loan.ohio && loan.ohio.loan === true && /Construction-loan/.test(loan.repNote));
  ok('loan flag does nothing to a plain Ohio job', cents(R.compute({ total: 30000, address: OH, constructionLoan: false })) === 300000);
}

// ── 6. Insurance ─────────────────────────────────────────────────────────
section('6. Insurance — the deductible stays the deposit; Kentucky untouched');
{
  const small = R.compute({ total: 30000, mode: 'insurance', deductible: 1500, acv: 24000, address: OH });
  ok('Ohio $30,000, deductible $1,500: $1,500 at signing', cents(small) === 150000, cents(small));
  ok('the ACV payment moves to the delivery / start milestone, not signing', rowOf(small, 'acv').amountCents === 2250000 && rowOf(small, 'acv').due !== 'At signing');
  invariants('insurance small ded', small);
  const big = R.compute({ total: 30000, mode: 'insurance', deductible: 5000, acv: 24000, address: OH });
  ok('deductible above the cap is capped at $3,000 at signing', cents(big) === 300000, cents(big));
  const dedRows = (big.rows || []).filter((r) => /deductible/.test(r.key)).reduce((a, r) => a + r.amountCents, 0);
  ok('the deductible is still collected in FULL ($5,000 across its rows)', dedRows === 500000, dedRows);
  ok('why is shown to the rep', /ORC 4722\.04/.test(big.repNote) && /never waived or reduced/.test(big.repNote));
  invariants('insurance big ded', big);
  const noDed = R.compute({ total: 30000, mode: 'insurance', address: OH });
  ok('no deductible entered: still needsDeductible, $0 printed as a number, Ohio note added', noDed.needsDeductible === true && /ORC 4722\.04/.test(noDed.repNote));
  ok('Ohio insurance under $25,000: unchanged (deductible + ACV up front)', cents(R.compute({ total: 12000, mode: 'insurance', deductible: 1000, acv: 9000, address: OH })) === 900000);
  // Kentucky — assert the advance-payment block is untouched.
  const ky = R.compute({ total: 30000, mode: 'insurance', deductible: 1500, acv: 24000, address: KY });
  ok('KY insurance: NOTHING at signing, kyHold true (KRS 367.626)', ky.depositCents === 0 && ky.kyHold === true && ky.rule === 'insurance-ky');
  ok('KY insurance: Ohio cap never touches it', !ky.ohio && ky.kind === 'insurance-ky');
  const kyUnknown = R.compute({ total: 30000, mode: 'insurance', deductible: 1500, acv: 24000, address: '', state: '' , lead: { jobType: 'insurance' } });
  ok('insurance with an unreadable state fails closed to the KY hold', kyUnknown.kyHold === true && kyUnknown.depositCents === 0);
  const kyOverride = R.compute({ total: 30000, mode: 'insurance', deductible: 1500, acv: 24000, address: KY, overrideAmount: 15000 });
  ok('a rep override cannot raise a KY insurance deposit', kyOverride.depositCents === 0 && /override ignored/i.test(kyOverride.repNote));
  const kyInv = R.invoiceDeposit(ky);
  ok('KY invoice deposit logic unchanged (deductible + ACV once the window runs)', kyInv.depositCents === 2400000 && kyInv.milestoneCents === 0, JSON.stringify(kyInv));
  // Ohio insurance: invoice deposit is the signing amount, milestone carried.
  const inv = R.invoiceDeposit(big);
  ok('Ohio capped insurance invoice: deposit = signing, milestone = the rest of the up-front ask', inv.depositCents === 300000 && inv.milestoneCents === 2100000, JSON.stringify(inv));
}

// ── 7. Overrides ─────────────────────────────────────────────────────────
section('7. Rep overrides cannot beat the statute');
{
  const hi = R.compute({ total: 30000, address: OH, overridePct: 60 });
  ok('60% override on an Ohio $30,000 job is held to $3,000', cents(hi) === 300000 && hi.kind === 'override');
  ok('...and says so', /ORC 4722\.04/.test(hi.repNote));
  const lo = R.compute({ total: 30000, address: OH, overridePct: 5 });
  ok('a 5% override is honoured (below the cap)', cents(lo) === 150000);
  ok('amount override over the cap is held', cents(R.compute({ total: 30000, address: OH, overrideAmount: 15000 })) === 300000);
  ok('override on a loan job is honoured', cents(R.compute({ total: 30000, address: OH, overrideAmount: 15000, constructionLoan: true })) === 1500000);
  invariants('override', hi);
}

// ── 8. fromEstimate / storage / invoice / policy text ────────────────────
section('8. fromEstimate, toStored, invoiceDeposit, policyText');
{
  const est = { grandTotal: 30000, mode: 'cash', addr: OH, specialOrderAmount: 4000 };
  const p = R.fromEstimate(est, {});
  ok('fromEstimate reads the estimate address and its special-order amount', cents(p) === 600000, cents(p));
  const p2 = R.fromEstimate({ grandTotal: 30000, mode: 'cash', address: OH, constructionLoan: true }, {});
  ok('fromEstimate reads constructionLoan', cents(p2) === 1500000);
  const p3 = R.fromEstimate({ grandTotal: 30000, mode: 'cash' }, { lead: { address: OH } });
  ok('fromEstimate takes the lead\'s address', cents(p3) === 300000);
  const st = R.toStored(R.compute({ total: 30000, address: OH }));
  ok('toStored carries the Ohio block (cents + pct only)', st.ohio && st.ohio.limitCents === 300000 && st.ohio.milestoneCents === 1200000 && st.ohio.capPct === 10);
  ok('toStored carries no cost / margin / state-warning internals', !/cost|margin|stateWarning|repNote/i.test(JSON.stringify(st)));
  ok('a non-Ohio stored plan has ohio:null', R.toStored(R.compute({ total: 30000, address: KY })).ohio === null);
  const invD = R.invoiceDeposit(R.compute({ total: 30000, address: OH }));
  ok('cash invoice: deposit = the 10% signing amount, milestone $12,000 held', invD.depositCents === 300000 && invD.milestoneCents === 1200000, JSON.stringify(invD));
  ok('non-Ohio invoice: no milestone', R.invoiceDeposit(R.compute({ total: 30000, address: KY })).milestoneCents === 0);
  const pol = R.policyText();
  ok('policyText states the Ohio limit with the threshold', /Ohio jobs over \$25,000:/.test(pol) && !/25,000 or more/.test(pol) && /limited to 10%/.test(pol) && /75%/.test(pol));
  ok('policyText keeps the KY and deductible sentences', /Kentucky insurance claims: nothing is due at signing/.test(pol) && /never waived or reduced/.test(pol));
  ok('policyText omits the Ohio sentence when the cap is off', !/Ohio jobs over/.test(R.policyText({ OH_CAP_ENABLED: 0 })));
}

// ── 9. Source-level guards ───────────────────────────────────────────────
section('9. One source, two byte-identical copies, no hard-coded Ohio numbers elsewhere');
{
  ok('functions/deposit-rule.js is identical to the browser copy', lf(read('functions/deposit-rule.js')) === lf(read('docs/pro/js/deposit-rule.js')));
  const cfg = {};
  new Function('window', read('docs/pro/js/estimate-config.js'))(cfg);
  const D = cfg.NBD_ESTIMATE_CONFIG.DEPOSIT_RULE;
  ok('estimate-config.js DEPOSIT_RULE equals the rule DEFAULTS (Ohio keys included)', JSON.stringify(D) === JSON.stringify(R.DEFAULTS), JSON.stringify(D));
  const src = lf(read('docs/pro/js/deposit-rule.js'));
  ok('the file cites ORC 4722 and flags the counsel question about delivery', /4722\.04/.test(src) && /COUNSEL/.test(src) && /performance begins/.test(src));
  ok('no cost / contractor / margin keys in the rule', !/\b(costCents|contractorCost|margin)\b/.test(src));
}

// ── 10. Invoices: the pay link charges the signing deposit only ──────────
section('10. Invoice hold — the link never charges past the cap before work begins');
{
  const IC = require(path.join(ROOT, 'functions/invoice-charge.js'));
  const inv = (o) => Object.assign({ total: 30000, depositAmount: 3000, amountPaid: 0, depositPaid: false,
    ohioHold: true, milestoneAmount: 12000, milestoneReleased: false }, o || {});
  const a = IC.chargeDueNow(inv());
  ok('deposit unmet: charge the $3,000 deposit', a.kind === 'deposit' && a.chargeCents === 300000, JSON.stringify(a));
  const b = IC.chargeDueNow(inv({ amountPaid: 3000, depositPaid: true }));
  ok('deposit met, next payment not released: $0 due, kind scheduled, next $12,000', b.kind === 'scheduled' && b.chargeCents === 0 && b.nextCents === 1200000, JSON.stringify(b));
  const c = IC.chargeDueNow(inv({ amountPaid: 3000, depositPaid: true, milestoneReleased: true }));
  ok('released: charge the $12,000 milestone, not the $27,000 balance', c.kind === 'milestone' && c.chargeCents === 1200000, JSON.stringify(c));
  const d = IC.chargeDueNow(inv({ amountPaid: 15000, depositPaid: true, milestoneReleased: true }));
  ok('milestone paid: the balance ($15,000) is charged', d.kind === 'balance' && d.chargeCents === 1500000, JSON.stringify(d));
  const e = IC.chargeDueNow(inv({ ohioHold: false, amountPaid: 3000, depositPaid: true }));
  ok('positive control: a non-Ohio invoice charges the balance straight after its deposit (unchanged)', e.kind === 'balance' && e.chargeCents === 2700000, JSON.stringify(e));
  const f = IC.chargeDueNow(inv({ milestoneAmount: 0, amountPaid: 3000, depositPaid: true }));
  ok('milestone switched off: still held until released, then the balance', f.kind === 'scheduled' && IC.chargeDueNow(inv({ milestoneAmount: 0, amountPaid: 3000, depositPaid: true, milestoneReleased: true })).kind === 'balance');
  const card = IC.portalBalanceCard(inv({ amountPaid: 3000, depositPaid: true }), 'https://pay.example/x', null);
  ok('portal card: scheduled, $0, no pay link, next amount carried', card.kind === 'scheduled' && card.amountCents === 0 && card.stripePaymentLink === null && card.nextCents === 1200000, JSON.stringify(card));
  const kyHeld = IC.portalBalanceCard(inv({ amountPaid: 0 }), 'https://pay.example/x', { held: true, releaseDate: 'Oct 20' });
  ok('KY hold still wins over everything (kind held)', kyHeld.kind === 'held' && kyHeld.amountCents === 0);

  // The signing-day server draft carries the hold.
  let D = null;
  try { D = require(path.join(ROOT, 'functions/deposit-draft-logic.js')); } catch (e) { ok('deposit-draft-logic loads', false, e.message); }
  if (D) {
    const lead = { userId: 'u1', companyId: 'u1', stage: 'estimate_sent_cash', firstName: 'Pat', lastName: 'Jones', email: 'pat@x.test', phone: '555', address: OH };
    const est = { leadId: 'L1', userId: 'u1', priceMode: 'per-sq', prices: { better: 30000 }, selectedTier: 'better', grandTotal: 30000, taxRate: 0, mode: 'cash' };
    const r = D.decideDepositDraft({ leadId: 'L1', event: 'contract_signed', sourceId: 'doc_o1', estimateId: 'E1', nowMs: Date.parse('2026-10-11T15:00:00Z'), lead, est });
    ok('signing-day draft on an Ohio $30,000 job: deposit $3,000, held, next payment $12,000',
      r.action === 'create' && r.invoice.depositAmount === 3000 && r.invoice.ohioHold === true && r.invoice.milestoneAmount === 12000 && r.invoice.milestoneReleased === false,
      JSON.stringify(r).slice(0, 240));
    const kyLead = Object.assign({}, lead, { address: KY });
    const r2 = D.decideDepositDraft({ leadId: 'L1', event: 'contract_signed', sourceId: 'doc_o2', estimateId: 'E1', nowMs: Date.parse('2026-10-11T15:00:00Z'), lead: kyLead, est });
    ok('positive control: the same job in Kentucky keeps its 50% and no hold', r2.action === 'create' && r2.invoice.depositAmount === 15000 && r2.invoice.ohioHold === false && r2.invoice.milestoneAmount === 0, JSON.stringify(r2).slice(0, 200));
    const insLead = Object.assign({}, lead, { address: KY, jobType: 'insurance', claimNumber: 'C-9', stage: 'scope_received' });
    const r3 = D.decideDepositDraft({ leadId: 'L1', event: 'contract_signed', sourceId: 'doc_o3', estimateId: 'E1', nowMs: Date.parse('2026-10-11T15:00:00Z'), lead: insLead,
      est: Object.assign({}, est, { mode: 'insurance', claim: { deductible: 1500, acv: 24000 } }) });
    ok('KY insurance job: still no draft at all (KRS 367.626)', r3.action === 'skip' && r3.reason === 'ky_insurance_hold');
  }
  // Wiring that has no unit seam: stripe.js refuses 'scheduled'; the rep's release control exists.
  const stripeSrc = lf(read('functions/stripe.js'));
  ok('stripe.js refuses to mint a link while the payment is scheduled', /due\.kind === 'scheduled'[\s\S]{0,260}res\.status\(400\)/.test(stripeSrc));
  const ip = lf(read('docs/pro/js/invoice-pipeline.js'));
  ok('invoice-pipeline: invoices are stamped ohioHold / milestoneAmount / milestoneReleased, and the release control is wired',
    /ohioHold: !!\(depositPlan && depositPlan\.ohio/.test(ip) && /milestoneReleased: false/.test(ip)
    && /case 'releaseMilestone'/.test(ip) && /data-ip-action="releaseMilestone"/.test(ip) && /releaseMilestoneUI,/.test(ip));
  const portalSrc = lf(read('docs/pro/js/portal.js'));
  ok('portal page: the scheduled kind gets the "nothing due yet" card', /kind === 'scheduled'/.test(portalSrc) && /data-portal-nothing-due/.test(portalSrc));
}

// ── 11. Builder + deal room + wizard wiring ──────────────────────────────
section('11. Builder inputs ride the V3 wizard, the save, the deal room and the engine');
{
  const ui = lf(read('docs/pro/js/estimate-v2-ui.js'));
  ok('V2 builder has the special-order and construction-loan inputs', /id="v2specialOrder"/.test(ui) && /id="v2constructionLoan"/.test(ui));
  ok('both are saved with the estimate and re-read on reopen', /specialOrderAmount: \(state\.specialOrderAmount > 0\)/.test(ui) && /state\.constructionLoan = doc\.constructionLoan === true/.test(ui));
  ok('both reach the rule through _depositPlanFor and the deal basis', /specialOrder: state\.specialOrderAmount/.test(ui) && /depositPlan: _ov \? \{ override: _ov \} : null,\s*\/\/[^\n]*\n[^\n]*\n\s*specialOrderAmount/.test(ui));
  const v3 = lf(read('docs/pro/js/estimate-v3-wizard.js'));
  ok('the V3 wizard shows the block on the Review step', /\['#v2ohioTerms', 'review'\]/.test(v3));
  ok('the inputs use delegated data-state handlers (no inline handlers)', !/on(click|change|input)=/.test(ui.slice(ui.indexOf('id="v2ohioTerms"'), ui.indexOf('id="v2ohioTerms"') + 900)));
  const cb = lf(read('docs/pro/js/close-board.js'));
  ok('close board snapshots the special-order amount + loan flag onto the deal', /specialOrderAmount: _num\(src\.specialOrderAmount\)/.test(cb) && /constructionLoan: src\.constructionLoan === true/.test(cb));
  // Engine adapter, run for real.
  const EB = require(path.join(ROOT, 'docs/pro/js/estimate-builder-v2.js'));
  const eng = EB.calcDeposit(30000, 'cash', { address: OH, specialOrder: 4000 });
  ok('engine calcDeposit: Ohio $30,000 + $4,000 special order = $6,000', eng && eng.amount === 6000 && eng.remainder === 24000, JSON.stringify(eng && { a: eng.amount, r: eng.remainder }));
  const engLoan = EB.calcDeposit(30000, 'cash', { address: OH, constructionLoan: true });
  ok('engine calcDeposit: loan flag leaves the 50%', engLoan.amount === 15000);
}

console.log('\n' + (failed ? 'FAILED' : 'OK') + ' -- ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
