/**
 * tests/care-plan-crm-2026-10-05.test.js
 *
 * The Roof Care Plan in the CRM (PR 2 of 3, Jo 2026-10-05):
 *   A. the member discount rule + its cents (docs/pro/js/care-plan-discount.js)
 *   B. the V2/V3 builder on the REAL engines: a member's repair estimate gets
 *      the visible "Roof Care Plan member — 10% off repairs" line and pays
 *      90%; replacements, per-SQ, insurance and non-members never do; fees
 *      are never discounted; the save payload + reopen carry it
 *   C. Job Templates: same rule, after upgrades, deposit on the discounted total
 *   D. storm priority: members first on the existing storm lists
 *   E. the CRM surfaces: badge, platform-tenant gate, never auto-sends, wiring
 *
 * Pricing logic (CLAUDE.md rule e). vm sandbox like
 * estimate-pricing-paths-2026-10-05.test.js; synthetic data only.
 * Run: node tests/care-plan-crm-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
function section(t) { console.log('\n' + t); }
function safe(fn) { try { return fn(); } catch (e) { return { __threw: String(e && e.stack || e).slice(0, 300) }; } }
const j = (v) => JSON.stringify(v);

const D = require(path.join(ROOT, 'docs', 'pro', 'js', 'care-plan-discount.js'));
const MEMBER = { id: 'L1', firstName: 'Pat', carePlan: { carePlanId: 'cp1', status: 'active', member: true } };
const PAST_DUE = { id: 'L1', carePlan: { carePlanId: 'cp1', status: 'past_due', member: true } };
const ENDED = { id: 'L1', carePlan: { carePlanId: 'cp1', status: 'cancelled', member: false } };
const SPOOF = { id: 'L1', carePlan: { status: 'active' } };   // no member flag → not a member

// ════════════════════════════════════════════════════════════════════
section('A. the rule and its cents (care-plan-discount.js)');
// ════════════════════════════════════════════════════════════════════
{
  ok('10%, labelled exactly as Jo asked', D.PCT === 10 && D.LABEL === 'Roof Care Plan member — 10% off repairs');
  const dec = (lead, o) => D.decide(Object.assign({ lead, workKind: 'repair', jobMode: 'cash', priceMode: 'line-item' }, o || {}));
  ok('member + repair + cash + line-item → applies', dec(MEMBER).applies === true && dec(MEMBER).reason === 'applied');
  ok('past_due member (card being retried) keeps the benefit', dec(PAST_DUE).applies === true);
  ok('cancelled member → no', dec(ENDED).applies === false && dec(ENDED).reason === 'not_member');
  ok('a mirror without member:true is not a member', dec(SPOOF).applies === false);
  ok('no lead → no', dec(null).applies === false);
  ok('NEVER on a replacement (workKind replacement)', dec(MEMBER, { workKind: 'replacement' }).applies === false && dec(MEMBER, { workKind: 'replacement' }).reason === 'replacement');
  ok('NEVER on per-SQ pricing (that is a roof replacement)', dec(MEMBER, { priceMode: 'per-sq' }).applies === false);
  ok('NEVER on an insurance claim', dec(MEMBER, { jobMode: 'insurance' }).applies === false && dec(MEMBER, { jobMode: 'insurance' }).reason === 'insurance');
  ok('unmarked work → not applied, asks the rep to mark it', dec(MEMBER, { workKind: null }).applies === false && dec(MEMBER, { workKind: null }).reason === 'not_repair');

  // By hand: $550.00 at 7% → 10% = $55.00 off the total; pre-tax part
  // round(5500 / 1.07) = 5140, tax part 360. Member pays $495.00.
  const f = D.figures(55000, 0.07);
  ok('$550 at 7%: $55.00 off = $51.40 pre-tax + $3.60 tax', f.cents === 5500 && f.preTaxCents === 5140 && f.taxCents === 360, j(f));
  const est = { lines: [{ code: 'A', retailTotal: 500 }], subtotal: 500, tax: 35, taxRate: 0.07, total: 550, internal: { margin: 200, marginPct: 36.36 } };
  D.apply(est);
  const line = est.lines.find(D.isDiscountLine);
  ok('apply: total $495.00, subtotal $448.60, tax $31.40, one −$51.40 line', est.total === 495 && est.subtotal === 448.6 && est.tax === 31.4 && line && line.retailTotal === -51.4 && line.name === D.LABEL, j([est.total, est.subtotal, est.tax]));
  ok('the rounding gap ($15) is untouched: total − (subtotal + tax) stays $15', Math.round((est.total - est.subtotal - est.tax) * 100) === 1500);
  ok('the margin view drops by the discount', est.internal.margin === 145);
  D.apply(est);
  ok('apply is idempotent (never stacks)', est.total === 495 && est.lines.filter(D.isDiscountLine).length === 1);
  const floor = { lines: [], subtotal: 300, tax: 21, taxRate: 0.07, total: 500 };   // a $500 job minimum
  D.apply(floor);
  ok('a $500 minimum-job repair → member pays $450.00', floor.total === 450);
  const ins = D.figures(100000, 0);
  ok('no tax → the whole discount is pre-tax', ins.preTaxCents === 10000 && ins.taxCents === 0);
  const zero = { lines: [], subtotal: 0, tax: 0, taxRate: 0.07, total: 0 };
  D.apply(zero);
  ok('a $0 price gets no line', !zero.lines.length && !zero.memberDiscount);
  const saved = D.applyToSaved({ rows: [{ code: 'A', total: 500 }], grandTotal: 550, subtotal: 500, tax: 35, taxAmount: 35, taxRate: 0.07 });
  const srow = saved.rows.find(D.isDiscountLine);
  ok('applyToSaved: same cents on a saved-row payload, rate reads −$51.40', saved.grandTotal === 495 && saved.subtotal === 448.6 && saved.tax === 31.4 && saved.taxAmount === 31.4 && srow && srow.total === -51.4 && srow.rate === '−$51.40' && srow.source === 'care_plan_discount');
  ok('applyToSaved is idempotent', D.applyToSaved(saved).grandTotal === 495 && D.applyToSaved(saved).rows.filter(D.isDiscountLine).length === 1);
  ok('templates: all repair/emergency → repair; any replacement/install → replacement; maintenance → none',
    D.workKindOfTemplates([{ jobType: 'repair' }, { jobType: 'emergency' }]) === 'repair'
    && D.workKindOfTemplates([{ jobType: 'repair' }, { jobType: 'replacement' }]) === 'replacement'
    && D.workKindOfTemplates([{ jobType: 'install' }]) === 'replacement'
    && D.workKindOfTemplates([{ jobType: 'maintenance' }]) === null && D.workKindOfTemplates([]) === null);
}

// ════════════════════════════════════════════════════════════════════
// Sandbox — the real engine stack in a fake window.
// ════════════════════════════════════════════════════════════════════
function makeSandbox() {
  const byId = {};
  function el(tag) {
    const classes = new Set();
    return {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null, checked: false,
      classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); }, toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); } },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, setSelectionRange() {}, remove() {},
    };
  }
  const document = { head: el('head'), body: el('body'), createElement: el, getElementById(id) { return byId[id] || null; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {} };
  const store = {};
  const localStorage = { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } };
  const win = { localStorage, document };
  win.window = win;
  const sandbox = { window: win, document, localStorage, navigator: { userAgent: 'node' }, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test', search: '' }, URLSearchParams };
  vm.createContext(sandbox);
  return { win, sandbox };
}
const FILES = [
  'docs/pro/js/estimate-config.js', 'docs/pro/js/ky-insurance-law.js', 'docs/pro/js/deposit-rule.js',
  'docs/pro/js/product-data.js', 'docs/pro/js/roofivent-catalog.js', 'docs/pro/js/estimate-labor-catalog.js',
  'docs/pro/js/estimate-builder-v2.js', 'docs/pro/js/estimate-catalog-xactimate.js', 'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/care-plan-discount.js',
  'docs/pro/js/job-templates-data.js', 'docs/pro/js/job-templates.js', 'docs/pro/js/customer-estimate-rows.js',
  'docs/pro/js/estimate-finalization.js', 'docs/pro/js/estimate-v2-ui.js',
];
const env = makeSandbox();
FILES.forEach((f) => vm.runInContext(read(f), env.sandbox, { filename: path.basename(f) }));
const W = env.win;

// ════════════════════════════════════════════════════════════════════
section('B. the V2 / V3 builder on the real engines (estimate-v2-ui.js)');
// ════════════════════════════════════════════════════════════════════
{
  const V2 = W.EstimateV2UI && W.EstimateV2UI._test;
  ok('builder + discount module loaded', !!(V2 && W.NBDCarePlanDiscount && typeof W.EstimateV2UI.setWorkKind === 'function'));
  const priced = (lead, edit) => {
    W._leadDoc = lead ? Object.assign({ id: 'L1' }, lead) : { id: 'L1' };
    const st = V2.getState();
    st._reopenedClean = false; st._reopenedDoc = null;
    st.leadId = 'L1'; st.customer = { name: 'Pat', address: '1 Elm St', phone: '', email: '', leadId: 'L1' };
    st.mode = 'line-item'; st.jobMode = 'cash'; st.tier = 'better'; st.county = '';
    st.measurements = Object.assign({}, st.measurements, { rawSqft: 100, pitch: 6, cutUpRoof: false });
    st.scope = [{ code: 'LAB MOB' }, { code: 'LAB DTL-HR' }]; st.passThru = []; st.upgrades = []; st.minJobCharge = null;
    st.workKind = 'repair';
    if (edit) edit(st);
    return safe(() => V2.effectiveEstimate());
  };
  const plain = priced(null);
  const mem = priced(MEMBER);
  const dl = mem && mem.lines && mem.lines.find(W.NBDCarePlanDiscount.isDiscountLine);
  ok('control: a non-member repair has no discount line', !!plain && !plain.__threw && plain.total > 0 && !plain.lines.some(W.NBDCarePlanDiscount.isDiscountLine) && !plain.memberDiscount, j(plain && (plain.__threw || plain.total)));
  const want = Math.round(plain.total * 100) - Math.round(Math.round(plain.total * 100) * 0.10);
  ok('a MEMBER\'s repair pays exactly 90% of the non-member price, to the cent', !!mem && Math.round(mem.total * 100) === want, j([plain.total, mem && mem.total]));
  ok('…shown as the labelled line "Roof Care Plan member — 10% off repairs" (negative, Discounts)', !!dl && dl.name === 'Roof Care Plan member — 10% off repairs' && dl.retailTotal < 0 && dl.category === 'Discounts');
  ok('…and the subtotal + tax drop by its two parts', !!mem.memberDiscount && Math.round(plain.subtotal * 100) - Math.round(mem.subtotal * 100) === mem.memberDiscount.preTaxCents
    && Math.round(plain.tax * 100) - Math.round(mem.tax * 100) === mem.memberDiscount.taxCents);
  ok('the deposit is on the discounted total', !!mem.depositPlan && mem.depositPlan.totalCents === Math.round(mem.total * 100), j(mem.depositPlan));
  const pd = priced(PAST_DUE);
  ok('past_due member still gets it', !!pd.memberDiscount);
  const ended = priced(ENDED);
  ok('a cancelled member does not', !ended.memberDiscount && ended.total === plain.total);
  const repl = priced(MEMBER, (st) => { st.workKind = 'replacement'; });
  ok('a member\'s REPLACEMENT: no line, full price', !repl.memberDiscount && repl.total === plain.total && repl.memberDiscountReason === 'replacement');
  const unmarked = priced(MEMBER, (st) => { st.workKind = null; });
  ok('a member\'s unmarked estimate: no line, the note asks to mark it repair', !unmarked.memberDiscount && unmarked.memberDiscountReason === 'not_repair');
  const ins = priced(MEMBER, (st) => { st.jobMode = 'insurance'; });
  ok('a member\'s INSURANCE claim: never', !ins.memberDiscount && ins.memberDiscountReason === 'insurance');
  const perSq = priced(MEMBER, (st) => { st.mode = 'per-sq'; st.measurements.rawSqft = 2000; });
  ok('per-SQ (roof) pricing: never, even marked repair', !!perSq && perSq.priceMode === 'per-sq' && !perSq.memberDiscount && !perSq.lines.some(W.NBDCarePlanDiscount.isDiscountLine), j(perSq && (perSq.__threw || perSq.priceMode)));
  const fee = priced(MEMBER, (st) => { st.passThru = [{ code: 'SVC AERIAL', desc: 'Aerial measurement report', amount: 75, source: 'passthru' }]; });
  ok('a $75 pass-through fee is never discounted: member total = discounted job + $75', Math.round(fee.total * 100) === want + 7500, j(fee.total));

  // Save payload + reopen.
  const st = V2.getState();
  priced(MEMBER);
  const est = V2.effectiveEstimate();
  const pay = V2.buildSavePayload(est, st);
  const row = pay.rows.find((r) => r.source === 'care_plan_discount');
  ok('saved: grandTotal is the member price, workKind repair, memberDiscount in cents', pay.grandTotal === est.total && pay.workKind === 'repair' && pay.memberDiscount && pay.memberDiscount.cents === est.memberDiscount.cents);
  ok('saved row keeps its tag and reads −$X.XX', !!row && row.code === 'DSC CAREPLAN' && /^−\$\d+\.\d\d$/.test(row.rate) && row.total < 0, j(row));
  W._estimates = [Object.assign({ id: 'est_cp' }, pay)];
  W._leads = [Object.assign({ id: 'L1' }, MEMBER)];
  const re = V2.rehydrateFromSaved('est_cp');
  const st2 = V2.getState();
  ok('reopen: the discount row is not pushed into the catalog scope or the fees', re === true && !st2.scope.some((s) => s.code === 'DSC CAREPLAN') && !st2.passThru.some((p) => p.code === 'DSC CAREPLAN'));
  ok('reopen: workKind restored as repair, and re-pricing gives the same member total', st2.workKind === 'repair' && V2.effectiveEstimate().total === est.total);
  const draft = V2.collectDraft();
  ok('the autosave draft carries workKind', draft.workKind === 'repair');

  // Presets mark the kind.
  const src = read('docs/pro/js/estimate-v2-ui.js');
  ok('the two repair presets mark repair; every other preset a roof', /REPAIR_PRESET_KEYS = \['small-repair', 'shingle-patch'\]/.test(src) && /state\.workKind = REPAIR_PRESET_KEYS\.indexOf\(presetKey\) !== -1 \? 'repair' : 'replacement';/.test(src));
  ok('the discount runs BEFORE pass-through fees and after upgrades', src.indexOf('_applyUpgradeLines(estimate, items.length);') < src.indexOf('_applyMemberDiscount(estimate);')
    && src.indexOf('_applyMemberDiscount(estimate);') < src.indexOf('for (const p of (state.passThru || []))'));
  const v3 = read('docs/pro/js/estimate-v3-wizard.js');
  ok('V3: picking Repair / Full roof marks the work through setWorkKind', /api\.setWorkKind\(ui\.kind === 'repair' \? 'repair' : 'replacement'\)/.test(v3));
}

// ════════════════════════════════════════════════════════════════════
section('C. Job Templates (job-templates.js)');
// ════════════════════════════════════════════════════════════════════
{
  const JT = W.JobTemplates;
  const custom = (name, labor) => ({ custom: { name, unit: 'EA', qty: 1, category: 'roofing', materialCost: 0, laborCost: labor } });
  W.NBD_JOB_TEMPLATES = [
    { id: 'cp_rep', name: 'Leak repair', category: 'roof_repair', jobType: 'repair', warrantyKind: 'repair', items: [custom('Repair work', 1000)] },
    { id: 'cp_em', name: 'Emergency tarp', category: 'roof_repair', jobType: 'emergency', warrantyKind: 'repair', items: [custom('Tarp', 300)] },
    { id: 'cp_new', name: 'Reroof', category: 'roof_replacement', jobType: 'replacement', warrantyKind: 'roof', items: [custom('Roof work', 9000)] },
  ];
  W._leadDoc = Object.assign({}, MEMBER);
  W._leads = [Object.assign({}, MEMBER)];
  const run = (ids, opts) => {
    const o = Object.assign({ jobMode: 'cash', leadId: 'L1' }, opts || {});
    const r = JT.resolveSelection(ids.map((x) => ({ templateId: x })), o);
    const base = JT.buildEstimatePayload(r, o);
    return { r, base, out: JT.applyMemberDiscount(base, r, o) };
  };
  const rep = run(['cp_rep', 'cp_em']);
  const want = Math.round(rep.base.grandTotal * 100) - Math.round(Math.round(rep.base.grandTotal * 100) * 0.10);
  ok('a member\'s repair templates → the labelled row, 90% of the price, workKind repair', Math.round(rep.out.grandTotal * 100) === want
    && rep.out.rows.some((x) => x.source === 'care_plan_discount' && x.desc === 'Roof Care Plan member — 10% off repairs') && rep.out.workKind === 'repair', j([rep.base.grandTotal, rep.out.grandTotal]));
  const mix = run(['cp_rep', 'cp_new']);
  ok('repair + REPLACEMENT template together → no discount (workKind replacement)', !mix.out.memberDiscount && mix.out.grandTotal === mix.base.grandTotal && mix.out.workKind === 'replacement');
  const ins = run(['cp_rep'], { jobMode: 'insurance' });
  ok('insurance → no discount', !ins.out.memberDiscount && ins.out.grandTotal === ins.base.grandTotal);
  W._leadDoc = { id: 'L1' }; W._leads = [{ id: 'L1' }];
  const nm = run(['cp_rep']);
  ok('not a member → no discount', !nm.out.memberDiscount && nm.out.grandTotal === nm.base.grandTotal);
  W._leadDoc = Object.assign({}, MEMBER); W._leads = [Object.assign({}, MEMBER)];

  // createEstimate saves the discounted payload with the deposit restamped.
  let saved = null;
  W._saveEstimate = async (p) => { saved = p; return 'est_new'; };
  (async () => {
    await JT.createEstimate([{ templateId: 'cp_rep' }], { jobMode: 'cash', leadId: 'L1', name: 'T' });
    const ref = run(['cp_rep']).out;
    ok('createEstimate saves the SAME member total and row the preview function gives', !!saved && saved.grandTotal === ref.grandTotal && saved.rows.some((x) => x.source === 'care_plan_discount'));
    ok('…and the deposit plan is on the discounted total', !!saved && saved.depositPlan && saved.depositPlan.totalCents === Math.round(saved.grandTotal * 100), j(saved && saved.depositPlan));
    const ui = read('docs/pro/js/job-templates-ui.js');
    ok('the build-screen preview runs the same applyMemberDiscount and passes the lead', /JT\.applyMemberDiscount\(base, res, resolveOpts\(\)\)/.test(ui) && /leadId: state\.leadId \|\| null,/.test(ui));
    finish();
  })().catch((e) => { ok('createEstimate ran', false, String(e && e.stack || e)); finish(); });
}

function finish() {
  // ══════════════════════════════════════════════════════════════════
  section('D. storm priority — members first on the existing storm lists');
  // ══════════════════════════════════════════════════════════════════
  {
    const e2 = makeSandbox();
    vm.runInContext(read('docs/pro/js/storm-integration.js'), e2.sandbox, { filename: 'storm-integration.js' });
    const SI = e2.win.StormIntegration || e2.win.NBDStormIntegration;
    const fn = SI && (SI.findLeadsInZone || (SI._test && SI._test.findLeadsInZone));
    if (fn) {
      const zone = { polygon: [[39.0, -84.6], [39.0, -84.4], [39.2, -84.4], [39.2, -84.6]], center: [39.1, -84.5] };
      const leads = [
        { id: 'near', name: 'Near', lat: 39.1, lng: -84.5 },
        { id: 'far_member', name: 'Far member', lat: 39.19, lng: -84.59, carePlan: { member: true, status: 'active' } },
        { id: 'mid', name: 'Mid', lat: 39.15, lng: -84.55 },
      ];
      const out = fn(zone, leads);
      ok('findLeadsInZone: the member comes first even when farthest, then by distance', out.map((x) => x.id).join(',') === 'far_member,near,mid' && out[0].carePlanMember === true, j(out.map((x) => x.id)));
    } else {
      ok('storm-integration exposes findLeadsInZone', false, Object.keys(e2.win).filter((k) => /storm/i.test(k)).join(','));
    }
    const SB = require(path.join(ROOT, 'functions', 'integrations', 'storm-briefing.js'))._test;
    const scored = [{ id: 'a', _score: 3 }, { id: 'm', _score: 1, carePlan: { member: true, status: 'active' } }, { id: 'b', _score: 2 }, { id: 'x', _score: 9, carePlan: { member: false, status: 'cancelled' } }];
    ok('Slack storm briefing: members lead the call order, then score', scored.slice().sort(SB.byPriority).map((x) => x.id).join(',') === 'm,x,a,b');
    ok('…and the line says so', /Care Plan member — priority/.test(SB.formatLeadLine({ firstName: 'Pat', carePlan: { member: true, status: 'active' } }, 0)) && !/Care Plan/.test(SB.formatLeadLine({ firstName: 'Pat' }, 0)));
    const hail = read('functions/integrations/hail-cron.js');
    ok('hail-match Slack summary: members first', /\(b\.carePlanMember \? 1 : 0\) - \(a\.carePlanMember \? 1 : 0\)\) \|\| \(b\.sizeInches - a\.sizeInches\)/.test(hail));
  }

  // ══════════════════════════════════════════════════════════════════
  section('E. CRM surfaces (care-plan-crm.js, care-plan-members.js, wiring)');
  // ══════════════════════════════════════════════════════════════════
  {
    const crmSrc = read('docs/pro/js/care-plan-crm.js');
    const e3 = makeSandbox();
    e3.win.NBDTenantRules = { isPlatformTenant: () => false };
    e3.sandbox.setInterval = () => 0;   // no polling in the test
    vm.runInContext(crmSrc, e3.sandbox, { filename: 'care-plan-crm.js' });
    const CP = e3.win.NBDCarePlan;
    ok('badge on a member card; nothing on anyone else', /Care Plan/.test(CP.badgeHtml(MEMBER)) && CP.badgeHtml(ENDED) === '' && CP.badgeHtml(SPOOF) === '' && CP.badgeHtml({}) === '');
    e3.win._userClaims = { role: 'company_admin', companyId: 'other-co' };
    ok('another tenant\'s company_admin may not manage it (and never calls the callable)', CP.mayManage() === false);
    let called = 0;
    e3.win._httpsCallable = () => () => { called++; return Promise.resolve({ data: { mode: 'live' } }); };
    e3.win._functions = {};
    CP.mode().then((m) => {
      ok('…mode() is "off" for them without a call', m === 'off' && called === 0);
      e3.win.NBDTenantRules = { isPlatformTenant: () => true };
      e3.win._userClaims = { role: 'admin', owner: true, companyId: 'OWNER' };
      ok('the platform owner may', CP.mayManage() === true);
      const code = crmSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
      ok('never sends anything itself: no SMS/email/queue calls, only sms:/mailto: links', !/sendSMS|sendEmail|NBDComms|email_queue|addDoc|setDoc/.test(code) && /'sms:'/.test(code) && /'mailto:'/.test(code));
      // R6-3-2 (2026-10-07): "Text it" is a button now (the sms: link opens
      // only after the server's "ok to text?"), so no sms: href is
      // interpolated into the dialog any more — tests/r6-texting-links-2026-10-07.test.js.
      ok('every interpolated value is escaped in the dialog', /esc\(o\.url\)/.test(code) && /esc\(mailHref\(/.test(code)
        && !/href="' \+ (?!esc\()/.test(code) && /data-cp-dlg="text"/.test(code));
      const pipe = read('docs/pro/js/crm-pipeline.js');
      ok('kanban card renders the badge in its top row', /\$\{jobTypeBadge\}\$\{leadScoreBadge\}\$\{stageAgeBadge\}\$\{carePlanBadge\}/.test(pipe));
      const dash = read('docs/pro/dashboard.html');
      ok('dashboard: nav + mobile entries ship HIDDEN (shown only when the plan is on)', /id="nav-careplan" data-careplan-nav hidden/.test(dash) && /data-target="careplan" data-close-more data-careplan-nav hidden/.test(dash)
        && /\[data-careplan-nav\]\[hidden\] \{ display: none !important; \}/.test(read('docs/pro/css/care-plan.css')));
      ok('dashboard: view mount + care-plan-crm.js after tenant-rules.js + stylesheet', /id="view-careplan" data-view-template="tpl-view-careplan"/.test(dash)
        && dash.indexOf('js/tenant-rules.js') < dash.indexOf('js/care-plan-crm.js') && /css\/care-plan\.css/.test(dash));
      const cust = read('docs/pro/customer.html');
      ok('customer page loads care-plan-crm.js after tenant-rules.js + stylesheet', cust.indexOf('js/tenant-rules.js') < cust.indexOf('js/care-plan-crm.js') && /css\/care-plan\.css/.test(cust));
      const loader = read('docs/pro/js/script-loader.js');
      ok('estimates bundle: care-plan-discount.js loads before the V2 builder and the Job Templates engine', loader.indexOf("'js/care-plan-discount.js") > 0
        && loader.indexOf("'js/care-plan-discount.js") < loader.indexOf("'js/estimate-v2-ui.js") && loader.indexOf("'js/care-plan-discount.js") < loader.indexOf("'js/job-templates.js"));
      ok('the careplan view maps to its lazy bundle; routeConfig + goTo init exist', /careplan:\s*\['careplan'\]/.test(loader) && /'careplan':\s*\{\s*label:\s*'Care Plan'/.test(read('docs/pro/js/dashboard-state.js'))
        && /if\(name==='careplan'\)/.test(read('docs/pro/js/dashboard-actions.js')));
      const e4 = makeSandbox();
      vm.runInContext(read('docs/pro/js/care-plan-members.js'), e4.sandbox, { filename: 'care-plan-members.js' });
      const M = e4.win.NBDCarePlanMembers;
      const sorted = M._sortRows([{ id: '1', status: 'cancelled', memberName: 'A' }, { id: '2', status: 'pending', memberName: 'B' }, { id: '3', status: 'active', memberName: 'Z' }, { id: '4', status: 'past_due', memberName: 'C' }]);
      ok('members view: members first, then invited, then ended', sorted.map((r) => r.id).join(',') === '4,3,2,1');
      done();
    });
  }
}

function done() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
}
