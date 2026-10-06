#!/usr/bin/env node
/**
 * tests/tenant-ready-2026-10-04.test.js — NBD Pro works for a new contractor
 * without Jo (Jo-approved scope, 2026-10-04). One behaviour test per item,
 * each with an NBD-unchanged control and, for every new read or write, a
 * cross-tenant check:
 *
 *   1  company-wide package prices (engine, V3 cards, Settings save)
 *   2  imports run on a one-time allowance, count shown before confirm
 *   3  NBD-only marketing defaults blank for other companies (docs)
 *   4  per-company business rules (tiers, names, warranty, shingle locks,
 *      deposit, tax / permit base); KY holds stay keyed to the property
 *   5  setup checklist + empty pipeline offers Import
 *   6  admin tenants list, signup alert + welcome email (stubbed queue)
 *   7  Connect Stripe prompt on the invoice screen
 *   8  homeowner email From / Reply-To show the contractor
 *   9  logo upload: EXIF stripped, first-party URL (never ?token=)
 *  10  full company export (company-named, cross-tenant clean) + grace
 *  11  server lead meter (rules are tested in firestore-rules.test.js §48)
 *  12  seat stepper stays dark; activation doc names the last step
 *
 * No network, no emulator, no email: Firestore / Auth / Storage are fakes.
 * Run: node tests/tenant-ready-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0; const fails = [];
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n' + t); }
// A section that throws (e.g. run against a tree without the change) is a
// recorded failure, not a crash that hides the other sections.
function safe(fn) { try { fn(); } catch (e) { ok('section threw: ' + (e && e.message), false); } }

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
let lazyDone = Promise.resolve(); // §5b's loader run
const OAKS = 'oaksOwnerUid000000000001';

// A browser-ish sandbox that loads the given docs/pro/js files in order.
function browser(files, setup) {
  const store = {};
  const win = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    addEventListener() {}, dispatchEvent() {},
  };
  win.window = win;
  if (setup) setup(win);
  const sandbox = {
    window: win, localStorage: win.localStorage,
    document: { getElementById: () => null, addEventListener() {}, querySelector: () => null, readyState: 'complete', createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} }, documentElement: { classList: { toggle() {} }, appendChild() {} } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, Date, Math, JSON, Promise, CustomEvent: function () {},
    MutationObserver: function () { this.observe = () => {}; },
  };
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(read('docs/pro/js/' + f), sandbox, { filename: f });
  return win;
}
const asNbd = (w) => { w._userClaims = { companyId: NBD }; w._user = { uid: NBD }; };
const asOaks = (profile) => (w) => {
  w._userClaims = { companyId: OAKS, role: 'company_admin' };
  w._user = { uid: OAKS };
  w._companyProfile = Object.assign({ brand: { legalName: 'Oaks Roofing LLC', displayName: 'Oaks Roofing' } }, profile || {});
};

// ═══════════════════════════════════════════════════════════════════════
section('4. Per-company business rules (tenant-rules.js + estimate-config.js)');
safe(() => {
  const CFG_NODE = require(path.join(ROOT, 'docs/pro/js/estimate-config.js')); // Node: no tenant rules
  const nbd = browser(['estimate-config.js', 'tenant-rules.js'], asNbd);
  const C = nbd.NBD_ESTIMATE_CONFIG, TR = nbd.NBDTenantRules;
  ok('NBD control: identified as the platform tenant', TR.isPlatformTenant() === true);
  ok('NBD control: all five tiers offered', C.tierOrder().join() === 'economy,good,better,best,beyond');
  ok('NBD control: tier labels byte-identical', TR.TIER_KEYS.every((t) => C.tierLabel(t) === CFG_NODE.tierLabel(t)));
  ok('NBD control: warranty sentences + blurbs byte-identical',
    TR.TIER_KEYS.every((t) => C.tierWarrantyText(t) === CFG_NODE.tierWarrantyText(t) && C.tierWarrantyBlurb(t) === CFG_NODE.tierWarrantyBlurb(t)));
  const gaf = [{ code: 'RFG 240-GAF-HDZ', name: 'GAF HDZ', sub: 'shingles-arch' }];
  ok('NBD control: Beyond still locked to TAMKO HailGuard', C.checkTierShingles('beyond', gaf).ok === false);
  ok('NBD control: deposit rule untouched (no override)', TR.depositConfig() === null);
  ok('NBD control: no neutral tax / permit base', TR.neutralFallbackTaxRate() === null && TR.neutralPermitCost() === null);

  const oaks = browser(['estimate-config.js', 'tenant-rules.js'], asOaks());
  const OC = oaks.NBD_ESTIMATE_CONFIG, OT = oaks.NBDTenantRules;
  ok('new company: not the platform tenant', OT.isPlatformTenant() === false);
  ok('new company: three tiers until it sets its own', OC.tierOrder().join() === 'good,better,best');
  ok('new company: plain tier names, never NBD\'s Standard/Preferred/Elite', OC.tierLabel('good') === 'Good' && OC.tierLabel('best') === 'Best');
  ok('new company: no "Lifetime workmanship" promise on its paper', !/lifetime/i.test(OC.tierWarrantyText('best')) && /written agreement/.test(OC.tierWarrantyText('best')));
  ok('new company: Beyond is NOT locked to HailGuard', OC.checkTierShingles('beyond', gaf).ok === true);
  ok('new company: no cash deposit until it sets one', OT.depositConfig().CASH_DEPOSIT_PCT === 0);
  ok('new company: 0% fallback tax and $0 permits until set', OT.neutralFallbackTaxRate() === 0 && OT.neutralPermitCost() === 0);

  const own = browser(['estimate-config.js', 'tenant-rules.js'], asOaks({ businessRules: {
    tiers: { enabled: ['better', 'good', 'bogus'], labels: { good: 'Classic' }, warranty: { good: '10-year Oaks workmanship warranty.' },
      shingleLocks: { good: { onlyCodes: ['RFG 240-GAF-HDZ'], onlyName: 'GAF HDZ' }, better: { no3Tab: true } } },
    deposit: { noDepositUnderCents: 100000, depositPct: 30, roundToCents: 100 } } }));
  const WC = own.NBD_ESTIMATE_CONFIG;
  ok('company list: its own tiers, canonical order, unknown keys dropped', WC.tierOrder().join() === 'good,better');
  ok('company names + warranty sentence used', WC.tierLabel('good') === 'Classic' && WC.tierWarrantyText('good') === '10-year Oaks workmanship warranty.');
  ok('company shingle lock enforced', WC.checkTierShingles('good', [{ code: 'X', name: 'Other', sub: 'shingles-arch' }]).ok === false
    && WC.checkTierShingles('good', gaf).ok === true);
  ok('company "never 3-tab" enforced', WC.checkTierShingles('better', [{ code: 'T', name: '3tab', sub: 'shingles-3tab' }]).ok === false);

  // NBD saving its own wording back must not change its short blurbs.
  const nbdSaved = browser(['estimate-config.js', 'tenant-rules.js'], (w) => {
    asNbd(w);
    w._companyProfile = { businessRules: { tiers: { warranty: { best: CFG_NODE.tierWarrantyText('best') }, labels: { best: 'Elite' } } } };
  });
  ok('NBD control: re-saving NBD\'s own sentence keeps the built-in blurb',
    nbdSaved.NBD_ESTIMATE_CONFIG.tierWarrantyBlurb('best') === CFG_NODE.tierWarrantyBlurb('best'));
  ok('an unprovisioned non-NBD account (NBD-looking brand) is still not NBD',
    browser(['tenant-rules.js'], (w) => { w._userClaims = { companyId: OAKS }; w._companyProfile = { brand: { legalName: 'No Big Deal Home Solutions' } }; }).NBDTenantRules.isPlatformTenant() === false);
  ok('V3 card notes and tenant-rules NBD notes are the same text',
    JSON.stringify(browser(['estimate-v3-wizard.js'], () => {}).EstimateV3._test.TIER_NOTES) === JSON.stringify(nbd.NBDTenantRules.NBD_NOTES));
});

section('4. Deposit rule per company — Kentucky stays keyed to the property');
safe(() => {
  const DR_NODE = require(path.join(ROOT, 'docs/pro/js/deposit-rule.js'));
  const nbd = browser(['estimate-config.js', 'deposit-rule.js', 'ky-insurance-law.js', 'tenant-rules.js'], asNbd);
  const D = nbd.NBDDepositRule;
  ok('NBD control: policy text byte-identical', D.policyText() === DR_NODE.policyText());
  ok('NBD control: $3,000 cash job → 50% at signing', D.compute({ total: 3000, mode: 'cash' }).depositCents === 150000);
  const oaks = browser(['estimate-config.js', 'deposit-rule.js', 'ky-insurance-law.js', 'tenant-rules.js'], asOaks());
  ok('new company: $3,000 cash job → no deposit', oaks.NBDDepositRule.compute({ total: 3000, mode: 'cash' }).depositCents === 0);
  ok('new company: policy text says no cash deposit', /^Cash jobs: no deposit/.test(oaks.NBDDepositRule.policyText()));
  const own = browser(['estimate-config.js', 'deposit-rule.js', 'ky-insurance-law.js', 'tenant-rules.js'],
    asOaks({ businessRules: { deposit: { noDepositUnderCents: 100000, depositPct: 30, roundToCents: 100 } } }));
  ok('company rule: $3,000 cash → 30% = $900', own.NBDDepositRule.compute({ total: 3000, mode: 'cash' }).depositCents === 90000);
  ok('company rule: $800 cash (under its $1,000) → none', own.NBDDepositRule.compute({ total: 800, mode: 'cash' }).depositCents === 0);
  ok('Kentucky insurance job: $0 at signing whatever the company rule',
    own.NBDDepositRule.compute({ total: 12000, mode: 'insurance', deductible: 1000, state: 'KY', zip: '41011' }).depositCents === 0);
});

// ═══════════════════════════════════════════════════════════════════════
section('1. Company-wide package prices');
safe(() => {
  const files = ['estimate-config.js', 'tenant-rules.js', 'estimate-builder-v2.js'];
  const oaks = browser(files, asOaks({ pricing: { tierRates: { good: 600, better: 700, best: 800 } } }));
  // A device copy saved under an OLD rate generation must not matter.
  oaks.localStorage.setItem('nbd_est_settings_v3', JSON.stringify({ tierRates: { good: 1 }, tierRatesVersion: 'old' }));
  const r = oaks.EstimateBuilderV2.effectiveTierRates();
  ok('engine quotes the COMPANY rates (pricing.tierRates)', r.good === 600 && r.better === 700 && r.best === 800);
  ok('a stale device copy is ignored', r.good !== 1);
  ok('new company: neutral fallback tax (0%) in the engine', oaks.EstimateBuilderV2.getFallbackTaxRate() === 0);
  const nbd = browser(files, asNbd);
  ok('NBD control: config rates + 7% tax unchanged', nbd.EstimateBuilderV2.effectiveTierRates().good === 550 && nbd.EstimateBuilderV2.getFallbackTaxRate() === 0.07);

  // V3 package cards: the company's tiers and $/SQ, starter hint only until set.
  function v3(profile, rates, claims) {
    const box = { innerHTML: '' };
    const w = browser(['estimate-config.js', 'tenant-rules.js', 'estimate-v3-wizard.js'], (win) => {
      if (claims === 'nbd') asNbd(win); else asOaks(profile)(win);
      win.EstimateBuilderV2 = { effectiveTierRates: () => rates };
      win.EstimateV2UI = { getState: () => ({ scope: [{ code: 'x' }], mode: 'per-sq', tier: 'good' }), tierTotals: () => ({ good: 1, better: 2, best: 3, economy: 4, beyond: 5 }) };
    });
    const T = w.EstimateV3._test;
    T.ui.modal = { querySelector: (s) => (s === '.v3-pkg' ? box : null) };
    T.paintPackage();
    return box.innerHTML;
  }
  const html = v3({ pricing: { tierRates: { good: 600 } } }, { good: 600, better: 700, best: 800 });
  ok('V3: shows the company\'s $/SQ', /\$600\/SQ/.test(html) && /\$800\/SQ/.test(html));
  ok('V3: only the company\'s three tiers', (html.match(/data-v3-act="tier"/g) || []).length === 3);
  ok('V3: no starter-price hint once prices are set', !/data-v3-starter-rates/.test(html));
  ok('V3: starter-price hint when the company never set prices', /data-v3-starter-rates/.test(v3({}, { good: 550, better: 660, best: 770 })));
  const nhtml = v3(null, { economy: 440, good: 550, better: 660, best: 770, beyond: 880 }, 'nbd');
  ok('V3 NBD control: five tiers, NBD notes, no hint', (nhtml.match(/data-v3-act="tier"/g) || []).length === 5 && /HailGuard/.test(nhtml) && !/starter/.test(nhtml));

  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  ok('Settings Save writes tier rates to the company profile (pricing.tierRates)', /if \(addonReady\) pricing\.tierRates = patch\.tierRates;/.test(boot));
  ok('Settings paints tier rates from the company profile', /_cpRates = \(window\._companyProfile && window\._companyProfile\.pricing && window\._companyProfile\.pricing\.tierRates\)/.test(boot));
  ok('factory reset clears the company tier rates too', /'pricing\.tierRates': \{\}/.test(boot));
  ok('close board offers the company\'s tiers (tierOrder)', /cfg\.tierOrder\(\)/.test(read('docs/pro/js/close-board.js')));
});

// ═══════════════════════════════════════════════════════════════════════
section('3. NBD-only marketing defaults blank for other companies');
safe(() => {
  const load = (setup) => browser(['deposit-rule.js', 'company-profile.js', 'tenant-rules.js'], setup);
  const oaks = load((w) => { w._userClaims = { companyId: OAKS }; });
  oaks._companyProfile = JSON.parse(JSON.stringify(oaks.NBD_COMPANY_PROFILE_DEFAULTS));
  oaks._companyProfile.brand.legalName = 'Oaks Roofing LLC';
  const L = oaks._legal();
  ok('Acorn Finance blanked', L.financePartner === '');
  ok('NBD services blanked', Array.isArray(L.services) && L.services.length === 0);
  ok('"Lifetime workmanship warranty on every tier" value prop blanked', Array.isArray(L.valueProps) && L.valueProps.length === 0);
  ok('NBD tagline blanked', L.tagline === '');
  ok('payment terms follow the company deposit rule', /^Cash jobs: no deposit/.test(L.paymentTermsContract));
  oaks._companyProfile.financePartner = 'Oaks Lending';
  ok('a company\'s own finance partner is kept', oaks._legal().financePartner === 'Oaks Lending');
  const nbd = load(asNbd);
  ok('NBD control: profile untouched (Acorn, services, value props)', nbd._legal().financePartner === 'Acorn Finance'
    && nbd._legal().services.length === 6 && /NBD Pledge — lifetime workmanship/.test(JSON.stringify(nbd._legal().valueProps)));

  // The renderers: Company Intro for a non-NBD company prints none of it.
  const tpl = read('docs/pro/js/document-generator-templates.js');
  ok('templates read the tenant-resolved profile (_legal) by default', /function tenantCp\(d\)[\s\S]{0,300}window\._legal\(\)/.test(tpl));
  ok('fallback finance partner / value props are NBD-only', /function defaultFinancePartner\(\) \{\s*if \(!isNbdDoc\(\)\) return '';/.test(tpl)
    && /function defaultValueProps\(\) \{\s*if \(!isNbdDoc\(\)\) return \[\];/.test(tpl));
  ok('financing block left out when there is no partner', /\$\{financePartner \? `<div class="finance-cta">/.test(tpl));
});

// ═══════════════════════════════════════════════════════════════════════
section('2 + 11. Imports, sample data and the server lead meter');
safe(() => {
  const L = require(path.join(ROOT, 'functions/lead-cap-logic.js'));
  const { _test: { PLAN_LIMITS } } = require(path.join(ROOT, 'functions/billing.js'));
  const now = new Date('2026-10-15T12:00:00Z');
  const sub = { plan: 'free', usage: { leads: 9, cycleStart: '2026-10-01T00:00:00Z' }, importAllowanceUsed: 0 };
  let o = L.meterPatch(sub, 'import', now, PLAN_LIMITS);
  ok('an import uses the one-time allowance, not the monthly count', o.counted === 'import' && o.patch.importAllowanceUsed === 1 && o.patch.usage.leads === 9);
  o = L.meterPatch(sub, 'manual', now, PLAN_LIMITS);
  ok('the 10th manual lead on Free reaches the cap → leadCap block until next month',
    o.patch.usage.leads === 10 && o.patch.leadCap && o.patch.leadCap.plan === 'free' && o.patch.leadCap.blockedUntil.toISOString() === '2026-11-01T00:00:00.000Z');
  o = L.meterPatch({ plan: 'free', importAllowanceUsed: L.IMPORT_ALLOWANCE, usage: { leads: 0, cycleStart: '2026-10-01' } }, 'import', now, PLAN_LIMITS);
  ok('past the allowance an import counts monthly', o.counted === 'monthly' && o.patch.usage.leads === 1);
  o = L.meterPatch({ plan: 'free', sampleAllowanceUsed: 3, usage: { leads: 9, cycleStart: '2026-10-01' } }, 'sample', now, PLAN_LIMITS);
  ok('Load Sample Data no longer eats Free\'s cap', o.counted === 'sample' && o.patch.usage.leads === 9 && o.patch.leadCap === null);
  o = L.meterPatch({ plan: 'free', usage: { leads: 10, cycleStart: '2026-09-01' } }, 'manual', now, PLAN_LIMITS);
  ok('a new month rolls the counter over', o.patch.usage.leads === 1 && o.patch.leadCap === null);
  o = L.meterPatch({ plan: 'growth', usage: { leads: 10, cycleStart: '2026-10-01' } }, 'manual', now, PLAN_LIMITS);
  ok('Growth is not blocked at 11', o.patch.leadCap === null);
  ok('rules allowances equal the logic constants', /importAllowanceUsed', 0\) < 1000/.test(read('firestore.rules')) && /sampleAllowanceUsed', 0\) < 20/.test(read('firestore.rules'))
    && L.IMPORT_ALLOWANCE === 1000 && L.SAMPLE_ALLOWANCE === 20);

  // The trigger: one company's lead touches only that company's meter.
  const { _test: LC } = require(path.join(ROOT, 'functions/lead-cap.js'));
  function fakeDb(docs) {
    const writes = [];
    return {
      writes,
      doc: (p) => ({ path: p }),
      runTransaction: async (fn) => fn({
        get: async (ref) => ({ exists: !!docs[ref.path], data: () => docs[ref.path] }),
        set: (ref, data) => writes.push([ref.path, data]),
      }),
    };
  }
  (async () => {
    const db = fakeDb({ 'subscriptions/co-a': { plan: 'free', usage: { leads: 2, cycleStart: '2026-10-01' } }, 'subscriptions/co-b': { plan: 'free' } });
    await LC.meterOne(db, { companyId: 'co-a', meter: 'manual' }, now);
    ok('meter writes ONLY the lead\'s own company (cross-tenant)', db.writes.length === 1 && db.writes[0][0] === 'subscriptions/co-a');
    const db2 = fakeDb({});
    const s1 = await LC.meterOne(db2, { companyId: NBD, meter: 'manual' }, now);
    const s2 = await LC.meterOne(db2, { companyId: 'co-a' }, now);
    ok('NBD control: never metered', s1.skipped === 'platform' && db2.writes.length === 0);
    ok('server-created leads (no meter) are skipped', s2.skipped === 'unmetered');
  })().catch((e) => ok('lead meter trigger threw: ' + e.message, false));

  // Client: billing-gate importCapacity + the import screen's count.
  const bg = browser(['billing-gate.js'], (w) => {
    w._user = { uid: 'u1' }; w._userClaims = { companyId: 'co-a' };
    w.db = {}; w.doc = () => ({}); w.getDoc = async () => ({ exists: () => true, data: () => ({ plan: 'free', status: 'none', usage: { leads: 10 }, importAllowanceUsed: 990 }) });
  });
  bg.NBDBilling.loadSubscription().then(() => {
    const cap = bg.NBDBilling.importCapacity();
    ok('Free at its monthly cap can still import (allowance left = 10)', cap.remaining === 10 && cap.allowanceLeft === 10 && cap.monthlyLeft === 0);
  });
  const imp = read('docs/pro/js/data-import.js');
  ok('import screen shows how many will be imported BEFORE confirm', /id="nbd-import-capnote"/.test(imp) && /Import \$\{capNote\.willImport\} lead/.test(imp));
  ok('import no longer stops at the monthly cap (enforceGate gone from runImport)', !/runImport[\s\S]{0,4000}enforceGate\('leads'/.test(imp));
  ok('imported leads carry meter: import', /meter: 'import'/.test(imp));
  ok('every client lead create path names its meter',
    /meter: *'manual'/.test(read('docs/pro/js/repos.js')) && /meter: 'sample'/.test(read('docs/pro/js/demo.js'))
    && (read('docs/pro/js/dashboard-bootstrap.module.js').match(/meter: 'manual'/g) || []).length >= 2
    && /meter: 'manual'/.test(read('docs/pro/js/d2d-tracker-core-2026b.js')));
  const billing = read('functions/billing.js');
  ok('trackUsage no longer double-counts leads (server meters them)', /if \(feature === 'leads'\) \{[\s\S]{0,400}meteredBy: 'server'/.test(billing));
});

// ═══════════════════════════════════════════════════════════════════════
section('5. Setup checklist + empty pipeline');
safe(() => {
  function cl(setup) {
    return browser(['tenant-rules.js', 'setup-checklist.js'], setup).NBDSetupChecklist;
  }
  const fresh = cl((w) => { asOaks()(w); w._companyProfileLoaded = true; w._brandOverride = () => ({ legalName: 'Oaks Roofing LLC' }); w._leads = []; w._estimates = []; });
  ok('a new company owner sees the checklist', fresh.eligible() === true);
  const steps = fresh.steps();
  ok('steps in order: brand → import → prices → team → stripe → estimate', steps.map((s) => s.id).join() === 'brand,import,prices,team,stripe,estimate');
  ok('publish-site step hidden while #2142\'s action is not in this build', !steps.some((s) => s.id === 'site'));
  ok('nothing done on day one', steps.every((s) => !s.done));
  const later = cl((w) => {
    asOaks({ pricing: { tierRates: { good: 600 } }, setupChecklist: { skipped: { team: true } } })(w);
    w._companyProfileLoaded = true;
    w._brandOverride = () => ({ legalName: 'Oaks', contact: { phone: '(513) 555-0100' } });
    w._leads = [{ id: 'a', isSample: true }, { id: 'b' }]; w._estimates = [{ id: 'e' }];
    w.__NBD_CALL_REGISTRY = { _publishSite: () => {} };
  });
  const s2 = later.steps();
  const done = (id) => (s2.find((s) => s.id === id) || {}).done;
  ok('brand / import / prices / team-skip / estimate detected', done('brand') && done('import') && done('prices') && done('team') && done('estimate'));
  ok('publish-site step appears when the publish action exists (feature-detected)', s2.some((s) => s.id === 'site'));
  ok('sample leads alone do not tick "import"', cl((w) => { asOaks()(w); w._brandOverride = () => ({}); w._leads = [{ id: 's', isSample: true }]; }).steps()[1].done === false);
  ok('NBD control: no checklist for NBD', cl((w) => { asNbd(w); w._companyProfileLoaded = true; }).eligible() === false);
  ok('a rep never sees it', cl((w) => { asOaks()(w); w._userClaims.role = 'sales_rep'; }).eligible() === false);
  const dash = read('docs/pro/dashboard.html');
  ok('empty pipeline offers Import first', /id="crmEmptyImportBtn" data-action="call" data-fn="openLeadImport"/.test(dash));
  ok('the empty-board copy leads with importing', /import your customer list from a CSV/.test(read('docs/pro/js/crm-pipeline.js')));
});

// ═══════════════════════════════════════════════════════════════════════
// Boot budget (2026-10-05): only tenant-rules.js is a dashboard boot tag.
// The settings editor + logo/export UI load with the Settings view, the
// checklist once a non-NBD company's profile lands — and each paints on
// arrival, because the events it listens for have already fired by then.
section('5b. Tenant-ready UI loads lazily, and still paints');
safe(() => {
  const dash = read('docs/pro/dashboard.html').replace(/<!--[\s\S]*?-->/g, '');
  ok('tenant-rules.js stays a boot tag (estimate-config / deposit-rule read it synchronously)', /<script defer src="js\/tenant-rules\.js\?v=\d+"><\/script>/.test(dash));
  ok('settings editor, checklist and logo/export UI are not boot tags',
    !/<script[^>]+(tenant-rules-settings|setup-checklist|tenant-account-ui)\.js/.test(dash));

  // The real loader, with a fake DOM that records what it injects.
  const injected = [];
  const doc = {
    baseURI: 'https://x.test/pro/dashboard.html',
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({}),
    head: { appendChild(el) { injected.push(el.src || el.href); setTimeout(() => el.onload && el.onload(), 0); } },
  };
  const sb = { window: {}, document: doc, console: { log() {}, warn() {}, group() {}, groupEnd() {} }, setTimeout, URL, Promise };
  sb.window.window = sb.window;
  vm.createContext(sb);
  vm.runInContext(read('docs/pro/js/script-loader.js'), sb, { filename: 'script-loader.js' });
  const SL = sb.window.ScriptLoader;
  ok('goTo(\'settings\') maps to the tenantsettings bundle', (SL.views.settings || []).indexOf('tenantsettings') !== -1);
  ok('docgen bundle lists doc-preflight.js once (a stale duplicate rode a merge)',
    SL.bundles.docgen.filter((s) => /doc-preflight\.js/.test(s)).length === 1);
  lazyDone = Promise.all([SL.loadBundle('tenantsettings'), SL.loadBundle('setup')]).then(() => {
    ok('tenantsettings injects the rules editor and the logo/export UI',
      injected.some((s) => /js\/tenant-rules-settings\.js/.test(s)) && injected.some((s) => /js\/tenant-account-ui\.js/.test(s)));
    ok('setup injects the checklist', injected.some((s) => /js\/setup-checklist\.js/.test(s)));
  });

  // Arriving late: the checklist queues its own first paint at load.
  const timers = [];
  const w = { addEventListener() {} };
  w.window = w;
  const csb = { window: w, document: { getElementById: () => null, addEventListener() {}, readyState: 'complete' },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, setInterval: () => 0, clearInterval() {},
    MutationObserver: function () { this.observe = () => {}; }, Promise, console: { log() {} } };
  vm.createContext(csb);
  vm.runInContext(read('docs/pro/js/setup-checklist.js'), csb, { filename: 'setup-checklist.js' });
  ok('a lazily loaded checklist schedules its first paint on arrival', timers.length >= 1);
  let painted = false;
  const rw = { addEventListener() {}, NBDTenantRules: { resolved: () => { painted = true; return null; } }, _companyProfileLoaded: false };
  rw.window = rw;
  const rsb = { window: rw, document: { getElementById: (id) => (id === 'tenantRulesPanel' ? { setAttribute() {}, set innerHTML(v) { painted = true; } } : null), addEventListener() {} }, setTimeout, console: { log() {} } };
  vm.createContext(rsb);
  vm.runInContext(read('docs/pro/js/tenant-rules-settings.js'), rsb, { filename: 'tenant-rules-settings.js' });
  ok('a lazily loaded rules editor paints the open panel on arrival', painted === true);

  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  const trig = (boot.match(/const _loadSetupChecklist = \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  ok('the checklist bundle loads only for a non-platform tenant, after the profile lands',
    /TR\.isPlatformTenant\(\)\) return;/.test(trig) && /SL\.loadBundle\('setup'\)/.test(trig)
    && /addEventListener\('nbd:company-profile-loaded', _loadSetupChecklist\)/.test(boot)
    && /if \(window\._companyProfileLoaded === true\) _loadSetupChecklist\(\);/.test(boot));
});

// ═══════════════════════════════════════════════════════════════════════
section('7. Connect Stripe prompt on the invoice screen');
safe(() => {
  const IP = require(path.join(ROOT, 'docs/pro/js/invoice-pipeline.js'));
  ok('shown on an unpaid invoice when the company cannot take cards', /data-ip-connect-note/.test(IP.connectStripeNoteHtml({ status: 'sent' }, false))
    && /data-ip-action="connectStripe"/.test(IP.connectStripeNoteHtml({ status: 'sent' }, false)));
  ok('NBD control (can collect): no prompt', IP.connectStripeNoteHtml({ status: 'sent' }, true) === '');
  ok('not on a paid invoice, one with a link, or a KY hold', IP.connectStripeNoteHtml({ status: 'paid' }, false) === ''
    && IP.connectStripeNoteHtml({ stripePaymentLink: 'x' }, false) === '' && IP.connectStripeNoteHtml({ kyInsuranceHold: true }, false) === '');
  ok('the invoice detail renders it before the send', /\$\{connectStripeNoteHtml\(inv, _canCollect\)\}/.test(read('docs/pro/js/invoice-pipeline.js')));
});

// ═══════════════════════════════════════════════════════════════════════
section('8. Homeowner emails show the contractor');
safe(() => {
  const T = require(path.join(ROOT, 'functions/tenant-ops-logic.js'));
  const base = 'Joe Deal <jd@nobigdealwithjoedeal.com>';
  const nbd = T.senderFor(NBD, { brand: { legalName: 'whatever', contact: { email: 'x@y.com' } } }, base);
  ok('NBD control: platform From unchanged, no company Reply-To', nbd.from === base && nbd.replyTo === null);
  const o = T.senderFor(OAKS, { brand: { displayName: 'Oaks Roofing', contact: { email: 'office@oaksroofing.com' } } }, base);
  ok('company name is the From display name on the platform address', o.from === '"Oaks Roofing" <jd@nobigdealwithjoedeal.com>');
  ok('company business email is the Reply-To', o.replyTo === 'office@oaksroofing.com');
  const evil = T.senderFor(OAKS, { brand: { displayName: 'A"\r\nBcc: x@evil.com <z>', contact: { email: 'bad\r\n@x' } } }, base);
  ok('header injection stripped from the name; bad reply-to dropped', !/[\r\n"<>]/.test(evil.from.slice(1, evil.from.lastIndexOf('"'))) && evil.replyTo === null);
  const ef = read('functions/email-functions.js');
  ok('sendEmail uses the tenant sender for From and Reply-To', /from: sender\.from,/.test(ef) && /if \(sender\.replyTo\) message\.reply_to = sender\.replyTo;/.test(ef));
});

// ═══════════════════════════════════════════════════════════════════════
section('6 / 9 / 10. Tenant functions (fake Firestore, Auth, Storage)');
const tenantOpsDone = (async () => {
  const T = require(path.join(ROOT, 'functions/tenant-ops-logic.js'));
  const { _test: O } = require(path.join(ROOT, 'functions/tenant-ops.js'));
  const { readZip } = require(path.join(ROOT, 'functions/zip-lite.js'));

  // Fake Firestore with collections + where(==) + doc get/create.
  function makeDb(data) {
    const created = {};
    const snapOf = (id, d) => ({ id, exists: !!d, data: () => d });
    const coll = (name) => {
      const rows = Object.keys(data).filter((p) => p.startsWith(name + '/') && p.split('/').length === 2).map((p) => [p.split('/')[1], data[p]]);
      const q = (filters) => ({
        where: (f, _op, v) => q(filters.concat([[f, v]])),
        limit: () => q(filters),
        get: async () => ({ docs: rows.filter(([, d]) => filters.every(([f, v]) => d[f] === v)).map(([id, d]) => snapOf(id, d)) }),
        count: () => ({ get: async () => ({ data: () => ({ count: rows.filter(([, d]) => filters.every(([f, v]) => d[f] === v)).length }) }) }),
      });
      return q([]);
    };
    return {
      created,
      collection: coll,
      doc: (p) => ({
        get: async () => snapOf(p.split('/').pop(), data[p]),
        create: async (d) => { if (data[p] || created[p]) { const e = new Error('already exists'); e.code = 6; throw e; } created[p] = d; },
      }),
    };
  }
  const auth = { getUser: async (uid) => ({ email: uid === OAKS ? 'owner@oaks.com' : 'x@y.com', metadata: { lastRefreshTime: '2026-10-03T10:00:00Z' } }) };

  // 6. signup alert + welcome — enqueued (email_queue), never sent here.
  const db = makeDb({});
  await O.handleCompanyCreated(db, auth, OAKS, { name: 'Oaks Roofing', ownerId: OAKS, plan: 'free' });
  ok('signup alert queued to Jo', db.created['email_queue/signup-alert-' + OAKS] && /jd@/.test(db.created['email_queue/signup-alert-' + OAKS].to));
  ok('welcome email queued to the NEW OWNER', db.created['email_queue/welcome-' + OAKS] && db.created['email_queue/welcome-' + OAKS].to === 'owner@oaks.com');
  ok('both are pending queue rows (the worker sends; tests send nothing)', Object.values(db.created).every((d) => d.status === 'pending'));
  const before = Object.keys(db.created).length;
  await O.handleCompanyCreated(db, auth, OAKS, { name: 'Oaks Roofing', ownerId: OAKS });
  ok('a retried trigger queues nothing twice', Object.keys(db.created).length === before);
  const dbN = makeDb({});
  await O.handleCompanyCreated(dbN, auth, NBD, { name: 'NBD', ownerId: NBD });
  ok('NBD control: no signup mail for NBD', Object.keys(dbN.created).length === 0);
  ok('welcome copy is contractor onboarding (no homeowner / claim language)', !/claim|homeowner/i.test(T.welcomeEmail({ name: 'Oaks' }).bodyPlain));

  // 6. admin tenants list.
  const adb = makeDb({
    'companies/co-a': { name: 'Oaks', ownerId: OAKS, status: 'active', sitePublished: false },
    'companies/co-b': { name: 'Elm', ownerId: 'u-b', status: 'active' },
    'subscriptions/co-a': { plan: 'team', status: 'trialing' },
    'connectAccounts/co-a': { accountId: 'acct_1', chargesEnabled: true, detailsSubmitted: true, livemode: true },
    'leads/l1': { companyId: 'co-a' }, 'leads/l2': { companyId: 'co-a' }, 'leads/l3': { companyId: 'co-b' },
    'estimates/e1': { companyId: 'co-a' }, 'invoices/i1': { companyId: 'co-b' },
  });
  const rows = await O.listTenants(adb, auth);
  const a = rows.find((r) => r.companyId === 'co-a'), b = rows.find((r) => r.companyId === 'co-b');
  ok('tenants list: plan, status, counts per company', a.plan === 'team' && a.status === 'trialing' && a.leads === 2 && a.estimates === 1 && b.leads === 1 && b.invoices === 1);
  ok('tenants list: Connect, last active, site published', a.connect === 'ready' && /^2026-10-03/.test(a.lastActive) && a.sitePublished === 'no' && b.sitePublished === 'yes (legacy)');
  ok('admin gate: platform admin claim or NBD owner only', O.isPlatformAdmin({ auth: { uid: 'x', token: { role: 'admin' } } })
    && O.isPlatformAdmin({ auth: { uid: NBD, token: {} } }) && !O.isPlatformAdmin({ auth: { uid: OAKS, token: { role: 'company_admin' } } }));

  // 10. export: only the company's records, named after it, token links gone.
  const edb = makeDb({
    'companies/co-a': { name: 'Oaks Roofing', ownerId: OAKS },
    'companyProfile/co-a': { brand: { legalName: 'Oaks Roofing LLC', displayName: 'Oaks Roofing' } },
    'leads/l1': { companyId: 'co-a', firstName: '=HYPERLINK("x")' },
    'leads/l9': { companyId: 'co-b', firstName: 'Other company' },
    'leads/legacy': { userId: OAKS, firstName: 'Legacy (no companyId)' },
    'photos/p1': { companyId: 'co-a', storagePath: 'photos/co-a/1.jpg', url: 'https://firebasestorage.googleapis.com/x?alt=media&token=abc' },
    'invoices/i1': { companyId: 'co-a', totalCents: 1000 },
  });
  const bucket = { file: () => ({ getSignedUrl: async () => ['https://storage.googleapis.com/signed?X-Goog-Expires=86400'] }) };
  const out = await O.buildCompanyExport(edb, bucket, 'co-a', { now: new Date('2026-10-04T00:00:00Z') });
  const files = readZip(out.zip);
  ok('zip is named after the company, not nbd-*', out.filename === 'oaks-roofing-export-2026-10-04.zip' && Object.keys(files).every((n) => !/^nbd-/.test(n)));
  const leads = JSON.parse(files['oaks-roofing-leads.json'].toString());
  ok('cross-tenant: another company\'s lead is not exported', !leads.some((l) => l.id === 'l9'));
  ok('legacy owner-only leads are included', leads.some((l) => l.id === 'legacy'));
  const photos = JSON.parse(files['oaks-roofing-photos.json'].toString());
  ok('permanent ?token= photo link removed, 24-hour signed link added', !JSON.stringify(photos).includes('token=abc') && /X-Goog-Expires/.test(photos[0].signedUrl24h));
  ok('CSV neutralizes formula injection', /'=HYPERLINK/.test(files['oaks-roofing-leads.csv'].toString()));
  ok('README + company file present', !!files['README.txt'] && !!files['oaks-roofing-company.json']);

  // 9. logo: EXIF stripped, PNG, first-party URL.
  const sharp = require(path.join(ROOT, 'functions/node_modules/sharp'));
  const jpg = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#BD5728' } })
    .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'GPS-SECRET', Artist: 'Phone' } } }).toBuffer();
  const before9 = await sharp(jpg).metadata();
  const png = await O.reencodeLogo(jpg);
  const after9 = await sharp(png).metadata();
  ok('positive control: the source image carries EXIF', !!before9.exif);
  ok('re-encoded logo is a PNG with NO EXIF', after9.format === 'png' && !after9.exif && !png.includes(Buffer.from('GPS-SECRET')));
  ok('decodeImage accepts only image data URLs', !!O.decodeImage({ image: 'data:image/jpeg;base64,' + jpg.toString('base64') }) && O.decodeImage({ image: 'data:text/html;base64,PGI+' }) === null);
  const url = O.logoUrlFor('co-a', 'ab'.repeat(16) + '.png');
  ok('stored logo URL is first-party, never a Storage ?token= link', url === 'https://nobigdealwithjoedeal.com/tenant-logo/co-a/' + 'ab'.repeat(16) + '.png' && !/token=/.test(url));
  const fb = JSON.parse(read('firebase.json'));
  ok('/tenant-logo/** is rewritten to the tenantLogo function', fb.hosting.rewrites.some((r) => r.source === '/tenant-logo/**' && r.function && r.function.functionId === 'tenantLogo'));
  ok('storage.rules default-deny still covers tenant-logos/ (no client path)', !/tenant-logos/.test(read('storage.rules')) && /match \/\{allPaths=\*\*\} \{\s*allow read, write: if false;/.test(read('storage.rules')));
})().catch((e) => ok('tenant functions threw: ' + (e && e.stack), false));

// ═══════════════════════════════════════════════════════════════════════
section('10. Cancellation grace + trial-ending email + company-named CSVs');
safe(() => {
  const T = require(path.join(ROOT, 'functions/tenant-ops-logic.js'));
  const until = T.readOnlyUntilFrom(Date.parse('2026-10-04T00:00:00Z'));
  ok('grace is 30 days', until.toISOString() === '2026-11-03T00:00:00.000Z');
  const stripe = read('functions/stripe.js');
  ok('a paid plan that ends gets readOnlyUntil; a never-paid trial does not',
    /const wasPaid = stored\.status && stored\.status !== 'trialing'[\s\S]{0,300}readOnlyUntil: graceUntil \|\| FieldValue\.delete\(\)/.test(stripe));
  ok('a new checkout ends the grace and the cap block', /readOnlyUntil: FieldValue\.delete\(\),\s*leadCap: FieldValue\.delete\(\),/.test(stripe));
  ok('trial_will_end queues one email to the contractor', /case 'customer\.subscription\.trial_will_end'[\s\S]{0,2500}email_queue\/trial-ending-/.test(stripe));
  const te = T.trialEndingEmail('Team', Date.parse('2026-10-20T15:00:00Z'), '$149.00');
  ok('trial email says when, how much, and how to cancel', /October 20, 2026/.test(te.subject) && /\$149\.00/.test(te.bodyPlain) && /Manage billing/.test(te.bodyPlain));
  const rg = browser(['role-gate.js'], (w) => { w.__nbdAccountReadOnlyUntil = Date.now() + 86400000; });
  ok('read-only grace makes the whole account view-only in the CRM', rg.NBDRole.isViewer({}) === true && rg.NBDRole.accountReadOnly() === true);
  ok('NBD control / no grace: not view-only', browser(['role-gate.js'], () => {}).NBDRole.isViewer({}) === false);
  ok('CSV exports are named after the company', browser(['tenant-rules.js'], asOaks()).NBDTenantRules.filePrefix() === 'oaks-roofing'
    && browser(['tenant-rules.js'], asNbd).NBDTenantRules.filePrefix() === 'nbd');
});

// ═══════════════════════════════════════════════════════════════════════
section('11 / 12. NBD-only features labelled; seat stepper dark');
safe(() => {
  const pricing = read('docs/pro/pricing.html');
  ok('pricing names the NBD-only features (auto-invoice after e-sign, Google Calendar sync)', /automatic invoice after a customer e-signs/i.test(pricing) && /Google Calendar sync/i.test(pricing));
  ok('Google Calendar stays NBD-only (single NBD Jobs calendar, owner-keyed)', /const OWNER = process\.env\.NBD_OWNER_UID/.test(read('functions/google-calendar.js')));
  ok('seat stepper hidden until NBD_SEAT_ADDON_ENABLED', /var seatAddonLive = window\.NBD_SEAT_ADDON_ENABLED === true;/.test(read('docs/pro/js/dashboard-team-tab.js')));
  ok('activation doc names the final switch', /NBD_SEAT_ADDON_ENABLED/.test(read('functions/SEAT_BILLING_ACTIVATION.md')));
  ok('onboarding placeholders are neutral', !/Cincinnati/.test(read('docs/pro/onboarding.html')));
});

Promise.all([tenantOpsDone, lazyDone]).then(() => new Promise((r) => setTimeout(r, 50))).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
});
