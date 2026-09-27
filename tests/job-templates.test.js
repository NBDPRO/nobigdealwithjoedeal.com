/**
 * tests/job-templates.test.js — JOB TEMPLATES harness (data + engine).
 *
 * Validates the two files being authored in parallel:
 *   docs/pro/js/job-templates-data.js  → window.NBD_JOB_TEMPLATES (~107
 *     templates) + window.NBD_JOB_TEMPLATE_CATEGORIES
 *   docs/pro/js/job-templates.js       → window.JobTemplates engine
 *     (resolveSelection / buildEstimatePayload per the v1 spec)
 *
 * Sections:
 *   1. DATA VALIDATION  — schema rules over every template (ids, taxonomy,
 *      jobType enum, tags, item shapes, catalog code resolution incl.
 *      brandOptions, custom-item cost sanity, measurement-key whitelist,
 *      repair-family conventions, total count ≥ 100).
 *   2. RESOLUTION SMOKE — resolveSelection per template at tier 'better':
 *      no throw, finite positive totals.total, finite non-negative line
 *      quantities, retailTotal stamped ≥ 0 on every line.
 *   3. PAYLOAD CONTRACT — buildEstimatePayload for 3 representative
 *      selections (repair, full roof, multi-select repair pair):
 *      builder 'template', grandTotal === totals.total, classic row shape
 *      (code/desc/qty-string/'$'-rate/total===retailTotal) + the B-8
 *      reconstruction fields, and the cost-leak trap: with markup > 0 a
 *      material-bearing row's customer total must EXCEED its cost basis
 *      (money-math sweep 2026-07-18 — rows[].rate/total = RETAIL).
 *   4. OVERHEAD DEDUPE  — a two-repair selection merges shared overhead
 *      codes (LAB MOB / LAB DEMOB / LAB CLN-M / DSP HAUL / PRM RES-OH)
 *      down to at most one each; exactly one LAB MOB.
 *   5. CHOICE CONTRACT — canonical itemChoices keys: brandCode swaps the
 *      resolved line to the PICKED catalog item (default code absent);
 *      unitPriceOverride IS the customer's per-unit retail (retailPerUnit
 *      === typed, retailTotal === qty × typed) on coded AND custom items.
 *   6. UI KEY GUARD    — static scan of job-templates-ui.js: emits
 *      'brandCode' + 'unitPriceOverride', never legacy 'priceOverride'
 *      (the key-drift class of bug, review 2026-07-19).
 *   7. SINGLETON MAX-QTY — colliding singleton codes (DSP HAUL 1 vs 2)
 *      keep ONE line at the MAX fixed qty, in either selection order.
 *   8. MEASUREMENTS OVERLAY — context = engine defaults ← template
 *      partials ← opts.measurements (user wins). Partial-measurement
 *      reroofs resolve real scope with NO opts; every formula/partial
 *      template clears a scale floor (kills the zero-scope class).
 *   9. CUSTOM-ITEM REGISTRATION — 'JT <template-slug>-<index>' codes are
 *      registered at module load (NOT insertIntoV2) so saved estimates
 *      resolve on reopen in any session; same-named customs in different
 *      templates get distinct codes. MUST run before section 10.
 *  10. INSERT-INTO-V2 MERGE — colliding non-singleton fixed qtys SUM into
 *      one entry; fixed+formula collisions carry NO qty override + a
 *      'measurement-driven' warning; price overrides warn they don't
 *      carry; result exposes warnings[].
 *  11. PAYLOAD COUNTY/META — county defaults NEUTRAL ('' → 7% fallback
 *      tax, payload stamps null; V2 "Other / My county" parity); explicit
 *      county persists; meta.owner/addr pass through; minJobApplied
 *      surfaced in totals + payload when the floor binds.
 *  12. USAGE TRACKING  — createEstimate (fake _saveEstimate) and
 *      insertIntoV2 stamp {n, last} into 'nbd_jt_usage_v1'; list()
 *      overlays useCount/lastUsedAt (defaults 0/null); a FAILED save does
 *      not stamp; persisted customs never carry the overlay fields.
 *  13. CLOUD HYDRATION — hydrateFromCloud() pull-once LWW merge of
 *      users/{uid}/jobTemplates (fake getDocs): strictly-newer cloud doc
 *      wins, newer local wins AND mirrors back up (fake writeBatch),
 *      cloud-only doc lands (new device), the '_usage' doc id is routed
 *      to the usage map (per-entry LWW by .last, local-newer mirrors up
 *      via fake setDoc) and NEVER into the template list; JT codes of
 *      cloud-pulled custom items re-register.
 *
 * SOFT-SKIP: while either job-templates file is missing (parallel
 * buildout), prints 'SKIP (files not present yet)' and exits 0 so CI
 * never hard-crashes mid-buildout. Once both files exist, every failure
 * is real and exits non-zero.
 *
 * Run: node tests/job-templates.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs', 'pro', 'js');

const JT_DATA_PATH = path.join(PRO_JS, 'job-templates-data.js');
const JT_ENGINE_PATH = path.join(PRO_JS, 'job-templates.js');

// ── Soft-skip while the parallel authors haven't landed the files ──
if (!fs.existsSync(JT_DATA_PATH) || !fs.existsSync(JT_ENGINE_PATH)) {
  console.log('SKIP (files not present yet)');
  process.exit(0);
}

// ════════════════════════════════════════════════════════════════════
// Load the whole browser stack into ONE shared vm context (same window,
// same order the estimates bundle uses) so cross-file references
// (NBD_PRODUCTS → NBD_LABOR → EstimateBuilderV2.CATALOG → xact bridge →
// EstimateLogic → JobTemplates) all resolve exactly like in the app.
// ════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// TWO PASSES OVER THE SAME STACK (2026-08-18).
//
// Custom-item costs left the published data file — they are tenant-owned now
// (catalogCosts/{companyId}.jtCosts). This harness has no window.db and no
// _resolveCompanyKey, so by construction it IS "a tenant with no cost book".
// That is the state most of this suite should run in, and §9's inference lock
// depends on it.
//
// But three checks are cost-DEPENDENT and go vacuous or red without numbers:
// §3's cost-leak trap (needs materialTotal > 0 to have anything to compare),
// §8's scale floor (measured: with no costs jt_ex_siding_replace_elevation
// resolves 2525 against a 3750 floor), and §9's "the tenant's own numbers
// reach the bridge" direction. So the whole browser stack is booted TWICE:
// once bare, once with a fixture book installed as window.NBDCatalogCosts.
//
// The fixture values are INVENTED (flat 1/2) and live in tests/ only, never
// under docs/. Flat {1,2} was measured to clear every scale floor.
// ════════════════════════════════════════════════════════════════════
const JT_FIXTURE_MATERIAL = 1;
const JT_FIXTURE_LABOR = 2;

function makeSandbox() {
  const win = {};
  win.window = win;
  const store = {};
  const localStorageStub = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    clear: function () { Object.keys(store).forEach(function (k) { delete store[k]; }); },
  };
  win.localStorage = localStorageStub;
  const sandbox = {
    window: win,
    localStorage: localStorageStub,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: {
      createElement: function () { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} }; },
      addEventListener() {}, removeEventListener() {},
      getElementById: function () { return null; },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
    },
    navigator: {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  vm.createContext(sandbox);
  return { win, sandbox };
}

// estimate-config.js is loaded first when present — it's what the browser
// does (estimate-builder-v2.js reads window.NBD_ESTIMATE_CONFIG, falling
// back to inline constants otherwise). Guarded: absence is non-fatal.
const CONFIG_PATH = path.join(PRO_JS, 'estimate-config.js');
const LOAD_ORDER = [
  CONFIG_PATH,
  path.join(PRO_JS, 'product-data.js'),
  path.join(PRO_JS, 'roofivent-catalog.js'),
  path.join(PRO_JS, 'estimate-labor-catalog.js'),
  path.join(PRO_JS, 'estimate-builder-v2.js'),
  path.join(PRO_JS, 'estimate-catalog-xactimate.js'),
  path.join(PRO_JS, 'estimate-logic-engine.js'),
  JT_DATA_PATH,
  JT_ENGINE_PATH,
];

/**
 * Boot the whole browser stack in a fresh context.
 * `book` (optional) is installed as window.NBDCatalogCosts BEFORE
 * job-templates.js evaluates — its load-time registerAllCustomItems() is what
 * reads jobItem(), so installing it afterwards would prove nothing.
 */
function loadStack(book) {
  const { win, sandbox } = makeSandbox();
  if (book) win.NBDCatalogCosts = book;
  for (const file of LOAD_ORDER) {
    if (file === CONFIG_PATH && !fs.existsSync(file)) continue; // optional
    let src;
    try { src = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      console.log('FATAL: cannot read ' + path.basename(file) + ' — ' + e.message);
      process.exit(1);
    }
    try { vm.runInContext(src, sandbox, { filename: path.basename(file) }); }
    catch (e) {
      // A file that EXISTS but throws at load is a real defect (a missing
      // file already soft-skipped above) — surface it loudly.
      console.log('FATAL: ' + path.basename(file) + ' threw during load — ' + e.message);
      process.exit(1);
    }
  }
  return { win, sandbox };
}

// PASS 1 — bare. No cost book: the state every tenant except the imported one
// is in on deploy day. This is the stack the whole suite runs against unless a
// section says otherwise.
const { win, sandbox } = loadStack(null);

// ── Contract globals ──
const TPLS = win.NBD_JOB_TEMPLATES;
const CATS = win.NBD_JOB_TEMPLATE_CATEGORIES;
const JT = win.JobTemplates;
const EL = win.EstimateLogic;
const XACT = win.NBD_XACT_CATALOG;
const LABOR = win.NBD_LABOR;
const V2 = win.EstimateBuilderV2;

// PASS 2 — priced. The fixture book is keyed with the SHARED jtKey() from
// functions/job-template-cost-logic.js, deliberately: if the client's
// jtCostKey() and the module's jtKey() ever drift, this book resolves nothing
// and the §9 priced assertion goes red — which is the drift alarm.
const { jtKey: JT_KEY } = require(path.join(ROOT, 'functions', 'job-template-cost-logic.js'));
const JT_FIXTURE_BOOK = {};
if (Array.isArray(TPLS)) {
  TPLS.forEach(function (t) {
    if (!t || !t.id || !Array.isArray(t.items)) return;
    t.items.forEach(function (it, i) {
      if (it && it.custom && it.custom.name) {
        JT_FIXTURE_BOOK[JT_KEY(t.id, i)] = { materialCost: JT_FIXTURE_MATERIAL, laborCost: JT_FIXTURE_LABOR };
      }
    });
  });
}
const PRICED = loadStack({
  __sentinel: 'test-fixture-book',
  jobItem: function (k) { return JT_FIXTURE_BOOK[k] || null; },
  jobItemKeys: function () { return Object.keys(JT_FIXTURE_BOOK); },
  recordJobItems: function () { return Promise.resolve(false); },
  hydrate: function () { return Promise.resolve(null); },
});
const JT_P = PRICED.win.JobTemplates;
const XACT_P = PRICED.win.NBD_XACT_CATALOG;

// ════════════════════════════════════════════════════════════════════
// Test scaffold — ✗ lines only + per-section counts + grand summary.
// ════════════════════════════════════════════════════════════════════
let passed = 0, failed = 0; const fails = [];
let curSection = null, secPassed = 0, secFailed = 0;
const sectionResults = [];
function flushSection() {
  if (curSection !== null) {
    sectionResults.push({ name: curSection, passed: secPassed, failed: secFailed });
    console.log('  → ' + secPassed + ' passed, ' + secFailed + ' failed');
  }
}
function section(name) {
  flushSection();
  curSection = name; secPassed = 0; secFailed = 0;
  console.log('\n' + name);
}
function ok(name, cond, detail) {
  if (cond) { passed++; secPassed++; }
  else {
    failed++; secFailed++; fails.push(name);
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}
function listOffenders(arr, max) {
  arr.slice(0, max || 12).forEach(function (m) { console.log('      - ' + m); });
  if (arr.length > (max || 12)) console.log('      … and ' + (arr.length - (max || 12)) + ' more');
}

// ── Bootstrap sanity: the contract globals must exist before anything
//    else is worth checking. ──
section('BOOTSTRAP — contract globals');
ok('window.NBD_JOB_TEMPLATES is a non-empty array', Array.isArray(TPLS) && TPLS.length > 0);
ok('window.NBD_JOB_TEMPLATE_CATEGORIES is an object', CATS && typeof CATS === 'object' && !Array.isArray(CATS));
ok('window.JobTemplates exposes resolveSelection()', JT && typeof JT.resolveSelection === 'function');
ok('window.JobTemplates exposes buildEstimatePayload()', JT && typeof JT.buildEstimatePayload === 'function');
ok('supporting stack loaded (EstimateLogic / NBD_XACT_CATALOG / NBD_LABOR / EstimateBuilderV2)',
  !!(EL && XACT && LABOR && V2));
if (!Array.isArray(TPLS) || !JT || typeof JT.resolveSelection !== 'function' || !EL) {
  flushSection();
  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed (aborted — contract globals missing)');
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════════
// 1. DATA VALIDATION
// ════════════════════════════════════════════════════════════════════
section('DATA VALIDATION — ' + TPLS.length + ' templates');

const SPEC_CATEGORIES = [
  'roof_repair', 'leak_flashing', 'gutters_repair', 'gutters_install',
  'soffit_fascia', 'ventilation', 'roof_replacement', 'specialty_roofing',
  'storm_emergency', 'exterior', 'maintenance',
];
const JOB_TYPES = ['repair', 'replacement', 'install', 'maintenance', 'inspection', 'emergency'];
// Read the whitelist straight off the engine export (estimate-logic-engine.js).
const MEASUREMENT_VARS = EL.MEASUREMENT_VARS || [];
ok('engine exports MEASUREMENT_VARS whitelist', Array.isArray(MEASUREMENT_VARS) && MEASUREMENT_VARS.length > 0);

// Merged-catalog code resolver: xactimate index (find), labor catalog
// (get), or any EstimateBuilderV2.CATALOG entry carrying that .code
// (the xact bridge also lands there; native V2 keys count too).
const V2_CODES = new Set(
  Object.keys(V2.CATALOG || {})
    .map(function (k) { return V2.CATALOG[k] && V2.CATALOG[k].code; })
    .filter(Boolean)
);
function codeResolves(code) {
  if (typeof code !== 'string' || !code) return false;
  if (XACT && typeof XACT.find === 'function' && XACT.find(code)) return true;
  if (LABOR && typeof LABOR.get === 'function' && LABOR.get(code)) return true;
  if (V2_CODES.has(code)) return true;
  return false;
}

const eId = [], eDupId = [], eCat = [], eJobType = [], eText = [], eTags = [],
      eItemsMin = [], eItemShape = [], eCode = [], eBrand = [], eBrandFirst = [],
      eCustom = [], eMeas = [], eConvention = [];
const seenIds = new Set();
// Non-vacuity counter for the inverted custom-item guard below. Without it,
// "no custom item carries a cost key" passes trivially the day custom items
// stop existing — the exact way an inverted assertion rots.
let nCustomScanned = 0;

TPLS.forEach(function (t, idx) {
  const id = (t && t.id) ? t.id : '<template #' + idx + '>';

  // id: unique + /^jt_[a-z0-9_]+$/
  if (!t || typeof t.id !== 'string' || !/^jt_[a-z0-9_]+$/.test(t.id)) eId.push(id);
  if (t && t.id) {
    if (seenIds.has(t.id)) eDupId.push(t.id);
    seenIds.add(t.id);
  }
  if (!t) return;

  // category: must exist in BOTH the data file's categories object and
  // the spec taxonomy ("one of the taxonomy keys below (exact)").
  if (!CATS || !Object.prototype.hasOwnProperty.call(CATS, t.category) ||
      SPEC_CATEGORIES.indexOf(t.category) === -1) {
    eCat.push(id + ' (category=' + t.category + ')');
  }

  // jobType enum
  if (JOB_TYPES.indexOf(t.jobType) === -1) eJobType.push(id + ' (jobType=' + t.jobType + ')');

  // description + scopeNotes non-empty
  if (typeof t.description !== 'string' || !t.description.trim() ||
      typeof t.scopeNotes !== 'string' || !t.scopeNotes.trim()) eText.push(id);

  // tags: 1–8 lowercase non-empty strings
  if (!Array.isArray(t.tags) || t.tags.length < 1 || t.tags.length > 8 ||
      !t.tags.every(function (tag) { return typeof tag === 'string' && tag.length > 0 && tag === tag.toLowerCase(); })) {
    eTags.push(id);
  }

  // items: array with >= 2 entries
  const items = t.items;
  if (!Array.isArray(items) || items.length < 2) { eItemsMin.push(id); return; }

  items.forEach(function (it, i) {
    const label = id + ' items[' + i + ']';
    if (!it || typeof it !== 'object') { eItemShape.push(label + ' (not an object)'); return; }
    const isCoded = typeof it.code === 'string' && it.code.length > 0;
    const isCustom = it.custom && typeof it.custom === 'object';
    if (isCoded === isCustom) { // neither, or both
      eItemShape.push(label + ' (must be exactly one of {code} / {custom})');
      return;
    }
    if (isCoded) {
      if (!codeResolves(it.code)) eCode.push(label + ' code "' + it.code + '" not in merged catalog');
      // qty when present must at least be a finite non-negative number
      if (it.qty != null && (!Number.isFinite(Number(it.qty)) || Number(it.qty) < 0)) {
        eItemShape.push(label + ' qty "' + it.qty + '" not a finite number >= 0');
      }
      if (it.brandOptions != null) {
        if (!Array.isArray(it.brandOptions) || it.brandOptions.length < 1) {
          eBrand.push(label + ' brandOptions not a non-empty array');
        } else {
          it.brandOptions.forEach(function (b, bi) {
            if (!b || typeof b.code !== 'string' || !codeResolves(b.code)) {
              eBrand.push(label + ' brandOptions[' + bi + '] code "' + (b && b.code) + '" not in merged catalog');
            }
          });
          if (!it.brandOptions[0] || it.brandOptions[0].code !== it.code) {
            eBrandFirst.push(label + ' (first brandOption ' + (it.brandOptions[0] && it.brandOptions[0].code) + ' != item code ' + it.code + ')');
          }
        }
      }
    } else { // custom
      const c = it.custom;
      const qty = Number(c.qty);
      if (typeof c.name !== 'string' || !c.name.trim()) eCustom.push(label + ' custom name empty');
      if (typeof c.unit !== 'string' || !c.unit.trim()) eCustom.push(label + ' custom unit empty');
      if (!Number.isFinite(qty) || qty <= 0) eCustom.push(label + ' custom qty must be > 0 (got ' + c.qty + ')');
      // 2026-08-18: this assertion is INVERTED from what it used to be.
      //
      // It used to read "materialCost/laborCost >= 0, at least one > 0" — i.e.
      // it REQUIRED contractor cost data to be present in a file served
      // unauthenticated from the Hosting root of a public repo. 84 items, 146
      // non-zero values, for a month. Cost data is tenant-owned now
      // (catalogCosts/{companyId}.jtCosts); the "at least one > 0" invariant
      // did not disappear, it moved to validateJtCostOverlay(), where it runs
      // at extract time AND again at import time against the real book.
      // documentation/audit/JOB-TEMPLATE-COST-LEAK-2026-08-18.md
      if ('materialCost' in c) eCustom.push(label + ' custom carries materialCost — cost data is tenant-owned');
      if ('laborCost' in c) eCustom.push(label + ' custom carries laborCost — cost data is tenant-owned');
      nCustomScanned++;
    }
  });

  // measurements: null (or absent = measurement-driven) OR an object whose
  // keys all sit inside the engine's MEASUREMENT_VARS whitelist.
  if (t.measurements != null) {
    if (typeof t.measurements !== 'object' || Array.isArray(t.measurements)) {
      eMeas.push(id + ' (measurements is not an object/null)');
    } else {
      const bad = Object.keys(t.measurements).filter(function (k) { return MEASUREMENT_VARS.indexOf(k) === -1; });
      if (bad.length) eMeas.push(id + ' (off-whitelist keys: ' + bad.join(', ') + ')');
    }
  }

  // Spec convention: fixed-scope jobTypes carry baked measurements + a
  // trip-charge floor (repairs/installs 350–1500 typical).
  if (['repair', 'maintenance', 'inspection', 'emergency'].indexOf(t.jobType) !== -1) {
    if (t.measurements == null) eConvention.push(id + ' (' + t.jobType + ' needs measurements != null)');
    if (!Number.isFinite(Number(t.minJobCharge)) || Number(t.minJobCharge) <= 0) {
      eConvention.push(id + ' (' + t.jobType + ' needs minJobCharge set, got ' + t.minJobCharge + ')');
    }
  }
});

ok('total template count >= 100 (got ' + TPLS.length + ')', TPLS.length >= 100);
ok('every id matches /^jt_[a-z0-9_]+$/', eId.length === 0); listOffenders(eId);
ok('ids are globally unique', eDupId.length === 0); listOffenders(eDupId);
ok('every category is a spec taxonomy key present in NBD_JOB_TEMPLATE_CATEGORIES', eCat.length === 0); listOffenders(eCat);
ok('every jobType is in the spec enum', eJobType.length === 0); listOffenders(eJobType);
ok('description + scopeNotes non-empty on every template', eText.length === 0); listOffenders(eText);
ok('tags: 1-8 lowercase non-empty strings on every template', eTags.length === 0); listOffenders(eTags);
ok('every template has >= 2 items', eItemsMin.length === 0); listOffenders(eItemsMin);
ok('every item is exactly one of coded {code} / {custom} with sane qty', eItemShape.length === 0); listOffenders(eItemShape);
ok('every coded item resolves in the merged catalog (xact.find / NBD_LABOR.get / V2 CATALOG codes)', eCode.length === 0); listOffenders(eCode);
ok('every brandOption code resolves in the merged catalog', eBrand.length === 0); listOffenders(eBrand);
ok('first brandOption equals the item\'s own code (the default)', eBrandFirst.length === 0); listOffenders(eBrandFirst);
ok('custom items: name/unit non-empty, qty > 0, NO cost keys (tenant-owned)', eCustom.length === 0); listOffenders(eCustom);
ok('custom-item guard is non-vacuous (' + nCustomScanned + ' custom items scanned)', nCustomScanned >= 80);
ok('measurements: null or keys ⊆ engine MEASUREMENT_VARS whitelist', eMeas.length === 0); listOffenders(eMeas);
ok('repair/maintenance/inspection/emergency templates bake measurements + minJobCharge', eConvention.length === 0); listOffenders(eConvention);

// ════════════════════════════════════════════════════════════════════
// 2. RESOLUTION SMOKE — every template, tier 'better'
// ════════════════════════════════════════════════════════════════════
section('RESOLUTION SMOKE — resolveSelection per template (tier better)');

// Measurements handed to measurement-driven templates (reroofs etc. that
// author measurements: null and expect the rep to type real numbers).
const SMOKE_MEASUREMENTS = {
  rawSqft: 2400, pitch: 6, ridgeLf: 40, eaveLf: 120, rakeLf: 60,
  valleyLf: 20, pipes: 3, stories: 1, tearOffLayers: 1,
};

const smokeErrs = [];
const smokeWarnings = [];
let smokeRan = 0;
TPLS.forEach(function (t) {
  if (!t || typeof t.id !== 'string') return; // already flagged in DATA
  smokeRan++;
  let res;
  try {
    const opts = { tier: 'better' };
    if (t.measurements == null) opts.measurements = SMOKE_MEASUREMENTS;
    res = JT.resolveSelection([{ templateId: t.id }], opts);
  } catch (e) {
    smokeErrs.push(t.id + ': resolveSelection THREW — ' + e.message);
    return;
  }
  if (!res || typeof res !== 'object') { smokeErrs.push(t.id + ': resolveSelection returned ' + res); return; }
  // warnings: empty or explained. 'Unknown catalog code' / 'Unknown
  // template' mean the engine DROPPED a line (understated totals — the
  // silent-money-bug class) → hard failure. Anything else is printed as
  // info so a benign bridge notice doesn't redline the whole catalog.
  if (Array.isArray(res.warnings) && res.warnings.length) {
    res.warnings.forEach(function (w) {
      if (/^Unknown (catalog code|template)/.test(String(w))) {
        smokeErrs.push(t.id + ': DROPPED LINE — ' + w);
      } else {
        smokeWarnings.push(t.id + ': ' + w);
      }
    });
  }
  const totals = res.totals;
  if (!totals || typeof totals !== 'object') { smokeErrs.push(t.id + ': no totals object on result'); return; }
  const total = Number(totals.total);
  if (!Number.isFinite(total) || total <= 0) {
    smokeErrs.push(t.id + ': totals.total not finite/positive (got ' + totals.total + ')');
  }
  const lines = res.lines;
  if (!Array.isArray(lines) || lines.length === 0) { smokeErrs.push(t.id + ': no lines[] on result'); return; }
  lines.forEach(function (ln, i) {
    const q = Number(ln && ln.quantity);
    if (!Number.isFinite(q) || q < 0) {
      smokeErrs.push(t.id + ' lines[' + i + '] (' + (ln && ln.code) + '): quantity not finite >= 0 (got ' + (ln && ln.quantity) + ')');
    }
    const rt = Number(ln && ln.retailTotal);
    if (!Number.isFinite(rt) || rt < 0) {
      smokeErrs.push(t.id + ' lines[' + i + '] (' + (ln && ln.code) + '): retailTotal not stamped >= 0 (got ' + (ln && ln.retailTotal) + ')');
    }
  });
});
ok('resolveSelection clean for all ' + smokeRan + ' templates (no throw, finite totals.total > 0, line qty finite >= 0, retailTotal stamped >= 0)',
  smokeErrs.length === 0, smokeErrs.length + ' failure(s)');
listOffenders(smokeErrs, 25);
if (smokeWarnings.length) {
  console.log('  (info) ' + smokeWarnings.length + ' template(s) resolved with warnings:');
  listOffenders(smokeWarnings, 15);
}

// ════════════════════════════════════════════════════════════════════
// 3. PAYLOAD CONTRACT — 3 representative selections
// ════════════════════════════════════════════════════════════════════
section('PAYLOAD CONTRACT — buildEstimatePayload (repair / full roof / multi-select)');

// `engine` defaults to the BARE stack; §3 passes the PRICED one so the
// cost-leak trap below has material-bearing rows to bite on.
function resolveAndBuild(label, selection, opts, engineOverride) {
  const E = engineOverride || JT;
  try {
    const res = E.resolveSelection(selection, opts);
    const payload = E.buildEstimatePayload(res, {
      name: 'Harness ' + label,
      customer: { name: 'Test Customer', address: '1 Test St' },
    });
    ok(label + ': resolve + buildEstimatePayload does not throw', true);
    return { res: res, payload: payload };
  } catch (e) {
    ok(label + ': resolve + buildEstimatePayload does not throw', false, e.message);
    return null;
  }
}

function checkPayload(label, built) {
  if (!built || !built.payload) { ok(label + ': payload produced', false); return; }
  const p = built.payload;
  const totals = (built.res && built.res.totals) || {};
  ok(label + ": builder === 'template'", p.builder === 'template', 'got ' + p.builder);
  ok(label + ': grandTotal === totals retail total (' + totals.total + ')',
    Number.isFinite(Number(p.grandTotal)) && Math.abs(Number(p.grandTotal) - Number(totals.total)) < 0.01,
    'grandTotal=' + p.grandTotal + ' totals.total=' + totals.total);
  const rows = p.rows;
  ok(label + ': rows[] present and non-empty', Array.isArray(rows) && rows.length > 0);
  if (!Array.isArray(rows)) return;

  const markup = Number(totals.materialMarkupPct != null ? totals.materialMarkupPct : 0.25);
  const rowErrs = [];
  let nMaterialRows = 0;
  rows.forEach(function (r, i) {
    const rid = 'row[' + i + '] ' + ((r && r.code) || '?');
    if (!r || typeof r !== 'object') { rowErrs.push(rid + ': not an object'); return; }
    if (typeof r.code !== 'string' || !r.code) rowErrs.push(rid + ': code missing');
    if (typeof r.desc !== 'string' || !r.desc) rowErrs.push(rid + ': desc missing');
    if (typeof r.qty !== 'string') rowErrs.push(rid + ': qty must be a string (got ' + typeof r.qty + ')');
    if (typeof r.rate !== 'string' || r.rate.charAt(0) !== '$') rowErrs.push(rid + ": rate must be a string starting '$' (got " + r.rate + ')');
    if (typeof r.total !== 'number' || !Number.isFinite(r.total)) rowErrs.push(rid + ': total must be a finite number (got ' + r.total + ')');
    if (!Number.isFinite(Number(r.retailTotal)) || Number(r.retailTotal) < 0) rowErrs.push(rid + ': retailTotal must be stamped >= 0 (got ' + r.retailTotal + ')');
    if (Number.isFinite(r.total) && Number.isFinite(Number(r.retailTotal)) && Math.abs(r.total - Number(r.retailTotal)) > 0.01) {
      rowErrs.push(rid + ': total (' + r.total + ') !== retailTotal (' + r.retailTotal + ')');
    }
    // B-8 reconstruction fields (estimate-v2-ui.js save contract)
    if (typeof r.quantity !== 'number' || !Number.isFinite(r.quantity)) rowErrs.push(rid + ': B-8 quantity (number) missing');
    if (typeof r.unit !== 'string' || !r.unit) rowErrs.push(rid + ': B-8 unit missing');
    ['materialTotal', 'laborTotal', 'materialCostPerUnit', 'laborCostPerUnit'].forEach(function (f) {
      if (typeof r[f] !== 'number' || !Number.isFinite(r[f])) rowErrs.push(rid + ': B-8 ' + f + ' missing/non-numeric (got ' + r[f] + ')');
    });
    // THE cost-leak trap: rows[].total is CUSTOMER retail. With material
    // markup > 0, any material-bearing row priced at exactly
    // materialTotal + laborTotal is leaking the internal cost basis.
    // A catalog line with a FIXED customer price (fixedRetail — 'MAT DEL',
    // $150 per job, Jo 2026-09-27) is priced on purpose, not cost-plus; it
    // may sit below its modelled cost. Its own test is in estimate-pricing.
    const _fx = (XACT && typeof XACT.find === 'function') ? XACT.find(r.code) : null;
    if (_fx && _fx.fixedRetail != null) return;
    if (markup > 0 &&
        Number.isFinite(r.materialTotal) && r.materialTotal > 0 &&
        Number.isFinite(r.laborTotal) && Number.isFinite(r.total)) {
      nMaterialRows++;
      if (!(r.total > r.materialTotal + r.laborTotal + 0.005)) {
        rowErrs.push(rid + ': COST LEAK — total ' + r.total + ' does not exceed cost basis ' +
          (r.materialTotal + r.laborTotal) + ' despite markup ' + markup);
      }
    }
  });
  ok(label + ': every row satisfies classic shape + B-8 fields + retail/cost-leak rules (' + rows.length + ' rows)',
    rowErrs.length === 0, rowErrs.length + ' row error(s)');
  listOffenders(rowErrs, 20);
  // The trap is `materialTotal > 0`-gated, so a zero-cost design would make it
  // pass by never firing. Say out loud how many rows it actually bit on.
  ok(label + ': cost-leak trap was non-vacuous (' + nMaterialRows + ' material-bearing rows checked)',
    nMaterialRows > 0);
}

// Representative picks.
const repairA = TPLS.find(function (t) { return t && t.jobType === 'repair'; });
const fullRoof = TPLS.find(function (t) { return t && t.category === 'roof_replacement'; }) ||
                 TPLS.find(function (t) { return t && t.jobType === 'replacement'; });
// For the pair, prefer two repairs that EACH carry LAB MOB so the dedupe
// assertion ("exactly one") is well-posed.
const repairsWithMob = TPLS.filter(function (t) {
  return t && t.jobType === 'repair' && Array.isArray(t.items) &&
    t.items.some(function (it) { return it && it.code === 'LAB MOB'; });
});

ok('found a repair template', !!repairA, 'no jobType "repair" template in the data');
ok('found a full-roof template', !!fullRoof, 'no roof_replacement/replacement template in the data');
ok('found two repair templates carrying LAB MOB (for the dedupe check)', repairsWithMob.length >= 2,
  'got ' + repairsWithMob.length);

// PRICED PASS. The cost-leak trap compares a row's customer total against its
// cost basis; with no cost book every JT custom row is 0/0 and the trap has
// nothing to bite on. Run the payload contract against a tenant that HAS a
// book, which is also the configuration a real customer document is produced
// in. (The bare stack's behaviour is covered by §9's inference lock.)
if (repairA) {
  const built = resolveAndBuild('repair (' + repairA.id + ')', [{ templateId: repairA.id }], { tier: 'better' }, JT_P);
  checkPayload('repair (' + repairA.id + ')', built);
}
if (fullRoof) {
  const opts = { tier: 'better' };
  if (fullRoof.measurements == null) opts.measurements = SMOKE_MEASUREMENTS;
  const built = resolveAndBuild('full roof (' + fullRoof.id + ')', [{ templateId: fullRoof.id }], opts, JT_P);
  checkPayload('full roof (' + fullRoof.id + ')', built);
}

// ════════════════════════════════════════════════════════════════════
// 4. MULTI-SELECT — shared-overhead dedupe on a two-repair selection
// ════════════════════════════════════════════════════════════════════
section('MULTI-SELECT — overhead dedupe (two repair templates)');
const DEDUPE_CODES = ['LAB MOB', 'LAB DEMOB', 'LAB CLN-M', 'DSP HAUL', 'PRM RES-OH', 'MAT DEL'];

// MAT DEL (2026-08-19) carries the supplier delivery + fuel charge on every
// reroof. It MUST dedupe: merging two reroofs into one estimate is one trip to
// the site, and billing the homeowner twice for it is a real overcharge — the
// mirror of the under-charge that created the line. The pair used by the
// generic dedupe check above is two REPAIRS, which carry no MAT DEL at all, so
// that assertion would pass vacuously for this code. This one uses reroofs.
(function () {
  const reroofs = TPLS.filter((t) => t && (t.items || []).some((i) => i && i.code === 'MAT DEL'));
  ok('reroof templates carry MAT DEL (' + reroofs.length + ' of them)', reroofs.length >= 15);
  if (reroofs.length >= 2) {
    const sel = [{ templateId: reroofs[0].id }, { templateId: reroofs[1].id }];
    const merged = JT.resolveSelection(sel, { tier: 'better' });
    const n = (merged.lines || []).filter((l) => l && l.code === 'MAT DEL').length;
    ok('TWO reroofs merged bill delivery ONCE (' + reroofs[0].id + ' + ' + reroofs[1].id + ')',
      n === 1, 'got ' + n + ' MAT DEL lines — the homeowner is being charged twice for one trip');
  }
  // ...and a template that is not a reroof must not carry it at all.
  const repair = TPLS.find((t) => t && t.jobType === 'repair');
  if (repair) {
    const n = (JT.resolveSelection([{ templateId: repair.id }], { tier: 'better' }).lines || [])
      .filter((l) => l && l.code === 'MAT DEL').length;
    ok('a repair template carries no delivery line (' + repair.id + ')', n === 0, 'got ' + n);
  }
})();
if (repairsWithMob.length >= 2) {
  const a = repairsWithMob[0], b = repairsWithMob[1];
  const pairLabel = 'pair (' + a.id + ' + ' + b.id + ')';
  const built = resolveAndBuild(pairLabel, [{ templateId: a.id }, { templateId: b.id }], { tier: 'better' }, JT_P);
  if (built) {
    checkPayload(pairLabel, built);
    const countIn = function (arr, code) {
      return (arr || []).filter(function (x) { return x && x.code === code; }).length;
    };
    ok(pairLabel + ': exactly one LAB MOB line in resolved lines',
      countIn(built.res.lines, 'LAB MOB') === 1,
      'got ' + countIn(built.res.lines, 'LAB MOB'));
    ok(pairLabel + ': exactly one LAB MOB row in the payload',
      countIn(built.payload.rows, 'LAB MOB') === 1,
      'got ' + countIn(built.payload.rows, 'LAB MOB'));
    const dupes = DEDUPE_CODES.filter(function (c) { return countIn(built.res.lines, c) > 1; });
    ok(pairLabel + ': no shared overhead code appears more than once (' + DEDUPE_CODES.join(', ') + ')',
      dupes.length === 0, 'duplicated: ' + dupes.join(', '));
  }
} else {
  ok('multi-select dedupe exercised', false, 'fewer than 2 repair templates with LAB MOB — cannot pose the check');
}

// ════════════════════════════════════════════════════════════════════
// 5. CHOICE CONTRACT — canonical itemChoices keys (review 2026-07-19).
//    selection = [{templateId, itemChoices: {<i>: {include, qty,
//    brandCode, unitPriceOverride}}}]. brandCode swaps the resolved line
//    to the PICKED catalog item; unitPriceOverride is the customer's
//    per-unit retail (engine prices it as labor so retailPerUnit lands
//    exactly on the typed value; OH&P/tax still apply at rollup).
// ════════════════════════════════════════════════════════════════════
section('CHOICE CONTRACT — brandCode / unitPriceOverride (resolveSelection)');

function nearly(a, b, eps) {
  return Number.isFinite(Number(a)) && Math.abs(Number(a) - Number(b)) <= (eps != null ? eps : 0.005);
}
function smokeOpts(t, extra) {
  const opts = Object.assign({ tier: 'better' }, extra || {});
  if (t && t.measurements == null && !opts.measurements) opts.measurements = SMOKE_MEASUREMENTS;
  return opts;
}

// (a) brand swap — picked code replaces the default, priced as the picked item.
const brandPick = (function () {
  for (const t of TPLS) {
    if (!t || !Array.isArray(t.items)) continue;
    for (let i = 0; i < t.items.length; i++) {
      const it = t.items[i];
      if (it && it.code && Array.isArray(it.brandOptions) && it.brandOptions.length > 1 &&
          t.items.filter(function (x) { return x && x.code === it.code; }).length === 1) {
        const alt = it.brandOptions.find(function (o) { return o && o.code && o.code !== it.code; });
        if (alt && XACT.find(alt.code)) return { t: t, i: i, it: it, alt: alt };
      }
    }
  }
  return null;
})();
ok('found a template item with a non-default brand option', !!brandPick);
if (brandPick) {
  const bt = brandPick.t, bit = brandPick.it, alt = brandPick.alt;
  const altItem = XACT.find(alt.code);
  const bChoices = {}; bChoices[brandPick.i] = { brandCode: alt.code };
  const bRes = JT.resolveSelection([{ templateId: bt.id, itemChoices: bChoices }], smokeOpts(bt));
  const bLines = bRes.lines || [];
  const picked = bLines.filter(function (l) { return l && l.code === alt.code; });
  const bLabel = 'brand swap (' + bt.id + ' ' + bit.code + ' → ' + alt.code + ')';
  ok(bLabel + ': resolved lines contain the PICKED code exactly once', picked.length === 1, 'got ' + picked.length);
  ok(bLabel + ': default code absent from resolved lines',
    !bLines.some(function (l) { return l && l.code === bit.code; }));
  const pl = picked[0];
  ok(bLabel + ": line carries the picked item's material cost/unit",
    pl && nearly(pl.materialCostPerUnit, altItem.materialCost),
    pl && ('got ' + pl.materialCostPerUnit + ' want ' + altItem.materialCost));
  const bMk = Number(bRes.totals && bRes.totals.materialMarkupPct != null ? bRes.totals.materialMarkupPct : 0.25);
  ok(bLabel + ': retailPerUnit = picked mat×(1+mk)+labor',
    pl && nearly(pl.retailPerUnit, Number(altItem.materialCost) * (1 + bMk) + Number(altItem.laborCost), 0.01),
    pl && ('got ' + pl.retailPerUnit));
  if (bit.qty != null) {
    ok(bLabel + ': fixed qty survives the swap', pl && nearly(pl.quantity, bit.qty, 1e-9),
      pl && ('got ' + pl.quantity + ' want ' + bit.qty));
  }
}

// (b) unitPriceOverride on a CODED item — retail lands exactly on the typed $.
const ovPick = (function () {
  for (const t of TPLS) {
    if (!t || !Array.isArray(t.items)) continue;
    for (let i = 0; i < t.items.length; i++) {
      const it = t.items[i];
      if (it && it.code && it.qty != null && Number(it.qty) > 0 &&
          !JT.SINGLETON_CODES[it.code] &&
          t.items.filter(function (x) { return x && x.code === it.code; }).length === 1) {
        return { t: t, i: i, it: it };
      }
    }
  }
  return null;
})();
ok('found a coded fixed-qty item for the $/unit override check', !!ovPick);
if (ovPick) {
  const ot = ovPick.t, oit = ovPick.it;
  const typed = 95;
  const oChoices = {}; oChoices[ovPick.i] = { unitPriceOverride: typed };
  const oRes = JT.resolveSelection([{ templateId: ot.id, itemChoices: oChoices }], smokeOpts(ot));
  const oLine = (oRes.lines || []).find(function (l) { return l && l.code === oit.code; });
  const oLabel = 'unitPriceOverride (' + ot.id + ' ' + oit.code + ' @ $' + typed + ')';
  ok(oLabel + ': overridden line present', !!oLine);
  ok(oLabel + ': retailPerUnit === typed value', oLine && nearly(oLine.retailPerUnit, typed),
    oLine && ('got ' + oLine.retailPerUnit));
  ok(oLabel + ': retailTotal === qty × typed', oLine && nearly(oLine.retailTotal, Number(oit.qty) * typed, 0.01),
    oLine && ('got ' + oLine.retailTotal + ' want ' + Number(oit.qty) * typed));
}

// (c) unitPriceOverride on a CUSTOM item — same plane, custom-item path.
const customPick = (function () {
  for (const t of TPLS) {
    if (!t || !Array.isArray(t.items)) continue;
    for (let i = 0; i < t.items.length; i++) {
      const it = t.items[i];
      if (it && it.custom && it.custom.name && Number(it.custom.qty) > 0) return { t: t, i: i, it: it };
    }
  }
  return null;
})();
ok('found a custom item for the $/unit override check', !!customPick);
if (customPick) {
  const ct = customPick.t, cc = customPick.it.custom;
  const typedC = 50;
  const cChoices = {}; cChoices[customPick.i] = { unitPriceOverride: typedC };
  const cRes = JT.resolveSelection([{ templateId: ct.id, itemChoices: cChoices }], smokeOpts(ct));
  const cLine = (cRes.lines || []).find(function (l) {
    return l && /^JT /.test(String(l.code)) && l.name === cc.name;
  });
  const cLabel = 'custom unitPriceOverride (' + ct.id + ' "' + cc.name + '" @ $' + typedC + ')';
  ok(cLabel + ': custom line present', !!cLine);
  ok(cLabel + ': retailPerUnit === typed value', cLine && nearly(cLine.retailPerUnit, typedC),
    cLine && ('got ' + cLine.retailPerUnit));
  ok(cLabel + ': retailTotal === qty × typed', cLine && nearly(cLine.retailTotal, Number(cc.qty) * typedC, 0.01),
    cLine && ('got ' + cLine.retailTotal + ' want ' + Number(cc.qty) * typedC));
}

// ════════════════════════════════════════════════════════════════════
// 6. UI KEY GUARD — static source scan. The 2026-07-19 review found the
//    UI emitting {code, priceOverride} while the engine read {brandCode,
//    unitPriceOverride}: every brand pick and $/unit override silently
//    dropped. Guard the canonical keys so the drift cannot recur.
// ════════════════════════════════════════════════════════════════════
section('UI KEY GUARD — job-templates-ui.js emits canonical choice keys (static)');
const UI_PATH = path.join(PRO_JS, 'job-templates-ui.js');
const uiExists = fs.existsSync(UI_PATH);
ok('job-templates-ui.js present', uiExists);
if (uiExists) {
  // Scan CODE only — the guard is against EMITTING the legacy key, and a
  // comment documenting "never priceOverride" must not trip it. Stripping
  // comments also strengthens the positive checks (canonical keys must
  // appear in actual code, not just prose).
  const uiCode = fs.readFileSync(UI_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');   // line comments ('//' not preceded by ':' — keeps URLs)
  ok("UI code contains 'brandCode' (canonical brand key)", /\bbrandCode\b/.test(uiCode));
  ok("UI code contains 'unitPriceOverride' (canonical price key)", /\bunitPriceOverride\b/.test(uiCode));
  ok("UI code never emits legacy 'priceOverride' key", !/\bpriceOverride\b/.test(uiCode),
    "found /\\bpriceOverride\\b/ outside comments — the engine only reads 'unitPriceOverride'");

  // ── "Cost not set" surfacing (2026-08-18) ──────────────────────────
  // The engine now marks an unpriced job-template line `costUnset` and still
  // resolves it at an explicit 0. If the UI stops reading that flag, every
  // one of those lines silently renders as $0.00 — a price, on a proposal.
  // These are static because the UI needs a real DOM; the behaviour they
  // stand in for is asserted end-to-end in tests/job-template-cost-seed.test.js.
  ok("UI code reads the 'costUnset' flag (else unpriced lines render as $0.00)",
    /\bcostUnset\b/.test(uiCode));
  ok('UI suppresses the card price band for an unpriced template',
    /unpricedCount\s*\(/.test(uiCode));
  ok('UI exports clearBandCache (catalog-costs → applyJtCostSeed repaints cold-device cards)',
    /clearBandCache:\s*clearBandCache/.test(uiCode));
  // ── the cost editor, and its gate (PR-C, 2026-08-19) ────────────────
  // This assertion used to read "the UI emits NO cost write field", holding the
  // line until an editor could be built properly. The editor now exists, so the
  // assertion inverts: it must exist AND it must be gated. An ungated cost
  // input is worse than none — costs are company-wide, so a sales_rep would be
  // handed a field whose Save cannot stick (firestore.rules allows the write to
  // owner/company_admin only) and would have to discover that by not being
  // believed at quote time.
  ok('UI emits the cost write fields (the in-product editor exists)',
    /data-jt-edi="materialCost"/.test(uiCode) && /data-jt-edi="laborCost"/.test(uiCode));
  ok('UI defines a role gate for cost editing', /function canEditCosts\s*\(/.test(uiCode));
  // Both inputs must sit inside the nearest preceding canEditCosts() branch.
  // Measured by OFFSET rather than a character-window regex: a window is a
  // magic number that silently stops proving anything the moment the markup
  // grows past it, and the property here ("nothing else opens between the gate
  // and the field") is exactly what an offset comparison states.
  (function () {
    const gates = [...uiCode.matchAll(/canEditCosts\s*\(\s*\)/g)].map((m) => m.index);
    ['materialCost', 'laborCost'].forEach((f) => {
      const at = uiCode.indexOf('data-jt-edi="' + f + '"');
      const gate = gates.filter((g) => g < at).pop();
      const between = gate == null ? '' : uiCode.slice(gate, at);
      ok('the ' + f + ' field sits inside a canEditCosts() branch',
        gate != null && !/\n\s*(?:function|return\s+['"])/.test(between),
        gate == null ? 'no preceding gate at all' : 'a function/return boundary sits between the gate and the field');
    });
  })();
  // The gate mirrors firestore.rules for catalogCosts/{companyId}; if it stops
  // consulting claims it has stopped being a gate.
  ok('the gate reads auth claims (not a hardcoded true)',
    /canEditCosts[\s\S]{0,900}?_userClaims/.test(uiCode));
  // Costs must never be written back onto the template document — that is
  // uid-scoped, and re-embedding them there is the leak this migration removed.
  ok('the editor never writes cost onto item.custom',
    !/item\.custom\.(?:materialCost|laborCost)\s*=/.test(uiCode));
}

// ════════════════════════════════════════════════════════════════════
// 7. SINGLETON MAX-QTY — on a singleton-code collision keep ONE line at
//    the MAX of the colliding fixed qtys (mirrors the minJobCharge
//    'never lower the floor' rule) — NOT first-wins, in either order.
// ════════════════════════════════════════════════════════════════════
section('SINGLETON MAX-QTY — DSP HAUL 1 vs 2 merges to qty 2 (both orders)');
function haulQty(t) {
  const it = (t.items || []).find(function (x) { return x && x.code === 'DSP HAUL'; });
  return it && it.qty != null ? Number(it.qty) : null;
}
const haul1 = TPLS.find(function (t) { return t && haulQty(t) === 1; });
const haul2 = TPLS.find(function (t) { return t && haulQty(t) === 2; });
ok('found templates with DSP HAUL fixed qty 1 and qty 2',
  !!(haul1 && haul2), 'qty1=' + (haul1 && haul1.id) + ' qty2=' + (haul2 && haul2.id));
if (haul1 && haul2) {
  [[haul1, haul2], [haul2, haul1]].forEach(function (order) {
    const hLabel = 'order [' + order[0].id + ' → ' + order[1].id + ']';
    const hRes = JT.resolveSelection(
      [{ templateId: order[0].id }, { templateId: order[1].id }], { tier: 'better' });
    const hauls = (hRes.lines || []).filter(function (l) { return l && l.code === 'DSP HAUL'; });
    ok(hLabel + ': exactly one DSP HAUL line', hauls.length === 1, 'got ' + hauls.length);
    ok(hLabel + ': merged DSP HAUL qty = max(1, 2) = 2',
      hauls[0] && nearly(hauls[0].quantity, 2, 1e-9), 'got ' + (hauls[0] && hauls[0].quantity));
  });
}

// ════════════════════════════════════════════════════════════════════
// 8. MEASUREMENTS OVERLAY — resolution context = engine defaults
//    ← template partial measurements (selection order) ← opts.measurements
//    LAST (user always wins). A template's partial object must NEVER be
//    used as the whole context (the $2,500 zero-scope reroof class).
// ════════════════════════════════════════════════════════════════════
section('MEASUREMENTS OVERLAY — defaults ← template partials ← user');

const redeck = TPLS.find(function (t) { return t && t.id === 'jt_fr_full_redeck'; });
ok('jt_fr_full_redeck present', !!redeck);
if (redeck) {
  // Deliberately NO opts.measurements — the overlay must supply scale.
  const rdRes = JT.resolveSelection([{ templateId: redeck.id }], { tier: 'better' });
  const posLines = (rdRes.lines || []).filter(function (l) { return l && Number(l.quantity) > 0; });
  ok('redeck w/o opts.measurements: >= 5 lines with quantity > 0',
    posLines.length >= 5, 'got ' + posLines.length);
  ok('redeck w/o opts.measurements: total > $6,000',
    rdRes.totals && Number(rdRes.totals.total) > 6000, 'got ' + (rdRes.totals && rdRes.totals.total));
  // User measurements merge LAST but the template's partial keys survive.
  const rdRes2 = JT.resolveSelection([{ templateId: redeck.id }],
    { tier: 'better', measurements: { rawSqft: 1000 } });
  const rdCtx = (rdRes2.totals && rdRes2.totals.context) || {};
  ok('redeck + user {rawSqft:1000}: context.rawSqft === 1000 (user wins)',
    Number(rdCtx.rawSqft) === 1000, 'got ' + rdCtx.rawSqft);
  const osb = (rdRes2.lines || []).find(function (l) { return l && l.code === 'RFG OSB716'; });
  ok('redeck + user {rawSqft:1000}: template deckReplacePct:1 survives merge (OSB qty > 0)',
    osb && Number(osb.quantity) > 0, 'OSB qty=' + (osb && osb.quantity));
}

// Scale floor over the whole formula/partial population: measurements
// null (measurement-driven) OR partial (no rawSqft key). At the default
// context each must resolve real scope — CI-guards the zero-scope class.
const formulaPop = TPLS.filter(function (t) {
  return t && (t.measurements == null ||
    (typeof t.measurements === 'object' && !Array.isArray(t.measurements) &&
     !Object.prototype.hasOwnProperty.call(t.measurements, 'rawSqft')));
});
ok('formula/partial population non-empty (got ' + formulaPop.length + ')', formulaPop.length > 0);

// The two halves of this check are NOT the same kind of assertion, and after
// the 2026-08-18 cost migration they can no longer share a pass.
//
//   qsum > 0  is cost-INDEPENDENT — it catches the zero-scope class (a
//             template whose formulas resolve to nothing at the default
//             context). It must hold for EVERY tenant, priced or not, so it
//             runs on the bare stack.
//   sTotal > floor  is cost-DEPENDENT by construction: it is a money floor.
//             With no cost book, measured, jt_ex_siding_replace_elevation
//             resolves 2525 against a 3750 floor — correctly, because an
//             unpriced tenant's total legitimately excludes the unpriced
//             lines. Asserting it on the bare stack would be asserting that
//             "Cost not set" is a bug. It runs on the priced stack.
const scaleErrs = [];
const floorErrs = [];
formulaPop.forEach(function (t) {
  let sRes;
  try { sRes = JT.resolveSelection([{ templateId: t.id }], { tier: 'better' }); } // NO measurements
  catch (e) { scaleErrs.push(t.id + ': resolveSelection THREW — ' + e.message); return; }
  const qsum = (sRes.lines || []).reduce(function (s, l) { return s + (Number(l && l.quantity) || 0); }, 0);
  if (!(qsum > 0)) scaleErrs.push(t.id + ': sum of line quantities is 0 at default context');

  let pRes;
  try { pRes = JT_P.resolveSelection([{ templateId: t.id }], { tier: 'better' }); }
  catch (e) { floorErrs.push(t.id + ': priced resolveSelection THREW — ' + e.message); return; }
  const scaleFloor = 1.5 * (Number(t.minJobCharge) || 2500);
  const pTotal = pRes.totals && Number(pRes.totals.total);
  if (!(pTotal > scaleFloor)) floorErrs.push(t.id + ': total ' + pTotal + ' <= scale floor ' + scaleFloor);
});
ok('every formula/partial template resolves real scope at default context (qty sum > 0) — NO cost book',
  scaleErrs.length === 0, scaleErrs.length + ' failure(s)');
listOffenders(scaleErrs, 20);
ok('every formula/partial template clears its scale floor (total > 1.5 × (minJobCharge || 2500)) — WITH a cost book',
  floorErrs.length === 0, floorErrs.length + ' failure(s)');
listOffenders(floorErrs, 20);

// ════════════════════════════════════════════════════════════════════
// 9. CUSTOM-ITEM REGISTRATION — 'JT ' + slug(templateId) + '-' + index
//    codes registered into NBD_XACT_CATALOG at MODULE LOAD, so 'JT *'
//    codes in saved estimates resolve on reopen in ANY session.
//    ⚠ MUST run BEFORE section 10 — no insertIntoV2 call may precede it,
//    or this would prove insert-time (session-local) registration only.
// ════════════════════════════════════════════════════════════════════
section('CUSTOM-ITEM REGISTRATION — JT codes resolve at load (no insertIntoV2)');
function jtSlug(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/\-+/g, '-');
}
if (customPick) {
  const rt = customPick.t, ri = customPick.i, rc = customPick.it.custom;
  const slugVariants = [];
  [jtSlug(rt.id), rt.id.toLowerCase().replace(/_/g, '-')].forEach(function (s) {
    if (s && slugVariants.indexOf(s) === -1) slugVariants.push(s);
  });
  const keyCandidates = [];
  slugVariants.forEach(function (s) {
    keyCandidates.push('JT ' + s.toUpperCase() + '-' + ri);
    keyCandidates.push('JT ' + s + '-' + ri);
  });
  const rRes = JT.resolveSelection([{ templateId: rt.id }], smokeOpts(rt));
  const rLine = (rRes.lines || []).find(function (l) {
    return l && /^JT /.test(String(l.code)) && l.name === rc.name;
  });
  const rLabel = 'load-time registration (' + rt.id + ' items[' + ri + '] "' + rc.name + '")';
  ok(rLabel + ': resolved custom line present', !!rLine);
  ok(rLabel + ": code follows the deterministic 'JT <template-slug>-<index>' scheme",
    !!rLine && keyCandidates.indexOf(rLine.code) !== -1,
    'code=' + (rLine && rLine.code) + ' expected one of [' + keyCandidates.join(', ') + ']');
  const rFound = rLine && XACT && typeof XACT.find === 'function' ? XACT.find(rLine.code) : null;
  ok(rLabel + ': NBD_XACT_CATALOG.find(code) resolves WITHOUT insertIntoV2 ever running', !!rFound);

  // ── the cost bridge, both directions (2026-08-18) ────────────────────
  // This used to compare the registered entry against the data file's
  // custom.materialCost. After the strip that is a comparison with no
  // operands: the data file carries no costs, so it asserted 0 === 0.

  // (a) NO BOOK. The harness has no window.db and no _resolveCompanyKey, so
  //     it IS a tenant with no cost book. The entry must price at an EXPLICIT
  //     zero and say so.
  ok(rLabel + ': no book ⇒ registered entry prices at explicit ZERO and is flagged unset',
    !!rFound && rFound.materialCost === 0 && rFound.laborCost === 0 && rFound.costUnset === true,
    rFound && ('got m=' + rFound.materialCost + '/l=' + rFound.laborCost + ' unset=' + rFound.costUnset));

  // (b) THE INFERENCE TRAP — the single assertion standing between this design
  //     and a $500 line labelled "Cost not set".
  //
  //     estimate-logic-engine.js:803 computes
  //         const laborId = item.laborId || inferLaborId(item);
  //     BEFORE it tests `item.laborCost != null` at :806, and inferLaborId
  //     falls through to LABOR_BY_SUB[item.category] against
  //     estimate-labor-catalog.js — still a public file. So OMITTING the cost
  //     key does not produce "no price", it produces a price re-derived from
  //     data this migration did not close: measured, 14 of the 84 custom items
  //     (gutters/ventilation/downspout/trim/soffit) land on a live NBD_LABOR
  //     rate, and "Attic insulation baffles" prices at 500.00 instead of
  //     142.50. An explicit 0 is what keeps labSource 'explicit'.
  //
  //     If anyone ever changes `materialCost: 0` back to an omitted key, this
  //     fails. That is its whole job.
  const rResolved = (JT.resolveSelection([{ templateId: rt.id }], smokeOpts(rt)).lines || [])
    .find(function (l) { return l && l.code === rLine.code; });
  ok(rLabel + ': no book ⇒ engine does NOT infer a labor rate (labSource stays explicit)',
    !!rResolved && rResolved.laborCostPerUnit === 0 && rResolved.materialCostPerUnit === 0 &&
    rResolved.labSource === 'explicit' && !/^NBD_LABOR:/.test(String(rResolved.labSource || '')),
    rResolved && ('labSource=' + rResolved.labSource + ' lab/unit=' + rResolved.laborCostPerUnit));

  // (b2) The trap, swept across the WHOLE population rather than one item —
  //      the 14 at-risk categories are the ones that matter and a single
  //      sample would very likely miss them.
  const inferErrs = [];
  let nJtLines = 0;
  TPLS.forEach(function (t) {
    if (!t || !Array.isArray(t.items) || !t.items.some(function (x) { return x && x.custom; })) return;
    let res;
    try { res = JT.resolveSelection([{ templateId: t.id }], smokeOpts(t)); } catch (e) { return; }
    (res.lines || []).forEach(function (l) {
      if (!l || !/^JT /.test(String(l.code))) return;
      nJtLines++;
      if (l.labSource !== 'explicit') inferErrs.push(t.id + ' ' + l.code + ': labSource=' + l.labSource);
      if (l.matSource !== 'explicit') inferErrs.push(t.id + ' ' + l.code + ': matSource=' + l.matSource);
      if (Number(l.retailTotal) !== 0) inferErrs.push(t.id + ' ' + l.code + ': retailTotal=' + l.retailTotal + ' (expected 0)');
      if (l.costUnset !== true) inferErrs.push(t.id + ' ' + l.code + ': costUnset=' + l.costUnset);
    });
  });
  ok('no book ⇒ ALL ' + nJtLines + ' JT custom lines resolve explicit/0/unset — no labor inference anywhere',
    inferErrs.length === 0 && nJtLines >= 80, inferErrs.length + ' offender(s), ' + nJtLines + ' lines swept');
  listOffenders(inferErrs, 12);

  // (c) WITH A BOOK. The tenant's own numbers reach the bridge end to end:
  //     jtCosts key → NBDCatalogCosts.jobItem → customLineItem →
  //     NBD_XACT_CATALOG.byCode. The fixture book is keyed with the SHARED
  //     jtKey() from functions/job-template-cost-logic.js, so this failing is
  //     also how key drift between the client and the module gets caught.
  const rFoundPriced = XACT_P && typeof XACT_P.find === 'function' ? XACT_P.find(rLine.code) : null;
  ok(rLabel + ': book ⇒ registered entry carries the TENANT cost, unset cleared',
    !!rFoundPriced && nearly(rFoundPriced.materialCost, JT_FIXTURE_MATERIAL) &&
    nearly(rFoundPriced.laborCost, JT_FIXTURE_LABOR) && rFoundPriced.costUnset === false,
    rFoundPriced && ('got m=' + rFoundPriced.materialCost + '/l=' + rFoundPriced.laborCost +
      ' unset=' + rFoundPriced.costUnset));
  ok(rLabel + ': book ⇒ costSource is "book" (not the legacy fork branch)',
    !!rFoundPriced && rFoundPriced.costSource === 'book',
    rFoundPriced && ('got ' + rFoundPriced.costSource));

  // (d) The escape hatch a tenant with no book actually uses. §5(c) already
  //     asserts unitPriceOverride prices the line exactly on the typed value;
  //     this records WHY that test is now load-bearing rather than incidental.
  const escChoices = {}; escChoices[ri] = { unitPriceOverride: 75 };
  const escLine = (JT.resolveSelection([{ templateId: rt.id, itemChoices: escChoices }], smokeOpts(rt)).lines || [])
    .find(function (l) { return l && l.code === rLine.code; });
  ok(rLabel + ': no book ⇒ a typed $/unit still prices the line exactly (the primary escape hatch)',
    !!escLine && nearly(escLine.retailPerUnit, 75) && escLine.costUnset === false,
    escLine && ('retailPerUnit=' + escLine.retailPerUnit + ' unset=' + escLine.costUnset));
} else {
  ok('custom-item registration exercised', false, 'no default template with a custom item found');
}

// Same-named custom items in DIFFERENT templates must get DISTINCT codes
// (per-template keys kill the name-slug collision → wrong-price class).
const customByName = {};
TPLS.forEach(function (t) {
  ((t && t.items) || []).forEach(function (it, i) {
    if (it && it.custom && it.custom.name) {
      const k = it.custom.name.toLowerCase().trim();
      (customByName[k] = customByName[k] || []).push({ t: t, i: i, name: it.custom.name });
    }
  });
});
const dupPair = Object.keys(customByName).map(function (k) {
  const seenT = {}; const out = [];
  customByName[k].forEach(function (e) { if (!seenT[e.t.id]) { seenT[e.t.id] = 1; out.push(e); } });
  return out;
}).find(function (v) { return v.length >= 2; });
if (dupPair) {
  const dupCodes = dupPair.slice(0, 2).map(function (e) {
    const dRes = JT.resolveSelection([{ templateId: e.t.id }], smokeOpts(e.t));
    const dLine = (dRes.lines || []).find(function (x) {
      return x && /^JT /.test(String(x.code)) && x.name === e.name;
    });
    return dLine && dLine.code;
  });
  ok("same-named custom items ('" + dupPair[0].name + "' in " + dupPair[0].t.id + ' vs ' +
     dupPair[1].t.id + ') get DISTINCT codes',
    !!dupCodes[0] && !!dupCodes[1] && dupCodes[0] !== dupCodes[1], 'codes: ' + dupCodes.join(' vs '));
} else {
  ok('same-named custom collision check (vacuous — no same-named pair in data)', true);
}

// ════════════════════════════════════════════════════════════════════
// 10. INSERT-INTO-V2 MERGE — group scope candidates by final code:
//     non-singletons with ALL-fixed qtys → one entry, qty = SUM;
//     any formula-driven occurrence → one entry, NO qty override + a
//     'measurement-driven' warning; price overrides don't carry (warned).
//     EstimateV2UI is absent in this sandbox, so insertIntoV2 returns
//     its raw { entries, measurements, minJobCharge, warnings } result.
// ════════════════════════════════════════════════════════════════════
section('INSERT-INTO-V2 MERGE — qty summing + warnings');
const HDZ = 'RFG 240-GAF-HDZ';
function fixedQtyOf(t, code) {
  const it = t && (t.items || []).find(function (x) { return x && x.code === code; });
  return it && it.qty != null ? Number(it.qty) : null;
}
const t5a = TPLS.find(function (t) { return t && t.id === 'jt_rr_shingle_5'; });
const t5b = TPLS.find(function (t) { return t && t.id === 'jt_rr_pipe_boot_1'; });
const qa = fixedQtyOf(t5a, HDZ), qb = fixedQtyOf(t5b, HDZ);
ok('jt_rr_shingle_5 + jt_rr_pipe_boot_1 both carry fixed-qty ' + HDZ,
  qa != null && qb != null, 'qa=' + qa + ' qb=' + qb);
if (qa != null && qb != null) {
  const iRes = JT.insertIntoV2([{ templateId: t5a.id }, { templateId: t5b.id }], {});
  ok('insert result has entries[]', iRes && Array.isArray(iRes.entries));
  ok('insert result has warnings[] (merge contract)', iRes && Array.isArray(iRes.warnings));
  const iEntries = (iRes && iRes.entries) || [];
  const iHdz = iEntries.filter(function (e) { return e && e.code === HDZ; });
  ok('single merged ' + HDZ + ' entry', iHdz.length === 1, 'got ' + iHdz.length);
  ok('merged qty = SUM of fixed qtys (' + qa + ' + ' + qb + ')',
    iHdz[0] && iHdz[0].overrides && nearly(iHdz[0].overrides.qty, qa + qb, 1e-6),
    'got ' + (iHdz[0] && iHdz[0].overrides && iHdz[0].overrides.qty));
  const iCodes = iEntries.map(function (e) { return e && e.code; });
  ok('no duplicate codes in inserted entries', new Set(iCodes).size === iCodes.length);
}
// Fixed + formula-driven occurrences of the same code → no qty override.
const t5c = TPLS.find(function (t) { return t && t.id === 'jt_fr_two_layer_tearoff'; });
const hasFormulaHdz = !!(t5c && (t5c.items || []).some(function (x) { return x && x.code === HDZ && x.qty == null; }));
ok('jt_fr_two_layer_tearoff carries formula-driven ' + HDZ, hasFormulaHdz);
if (hasFormulaHdz && t5a) {
  const mRes = JT.insertIntoV2([{ templateId: t5c.id }, { templateId: t5a.id }], {});
  const mEntries = (mRes && mRes.entries) || [];
  const mHdz = mEntries.filter(function (e) { return e && e.code === HDZ; });
  ok('fixed+formula collision: single ' + HDZ + ' entry', mHdz.length === 1, 'got ' + mHdz.length);
  ok('fixed+formula collision: NO qty override (measurement-driven wins)',
    mHdz[0] && (!mHdz[0].overrides || mHdz[0].overrides.qty == null),
    'got qty=' + (mHdz[0] && mHdz[0].overrides && mHdz[0].overrides.qty));
  ok("fixed+formula collision: 'measurement-driven' warning pushed",
    mRes && Array.isArray(mRes.warnings) &&
    mRes.warnings.some(function (w) { return /measurement-driven/i.test(String(w)); }),
    'warnings: ' + JSON.stringify(mRes && mRes.warnings));
}
// unitPriceOverride in the selection cannot carry into the builder — warn.
if (ovPick) {
  const wChoices = {}; wChoices[ovPick.i] = { unitPriceOverride: 95 };
  const wRes = JT.insertIntoV2([{ templateId: ovPick.t.id, itemChoices: wChoices }], {});
  ok("price override in selection: 'do not carry into the builder' warning pushed",
    wRes && Array.isArray(wRes.warnings) &&
    wRes.warnings.some(function (w) { return /price overrides? do(es)? not carry/i.test(String(w)); }),
    'warnings: ' + JSON.stringify(wRes && wRes.warnings));
}

// ════════════════════════════════════════════════════════════════════
// 11. PAYLOAD COUNTY/META — resolveSelection defaults county NEUTRAL
//     ('' — V2 builder "Other / My county" parity, first-run audit
//     2026-07-28): taxes at the 7% fallback, never any county's rate,
//     and the payload stamps county null; an EXPLICIT county still
//     persists; meta.owner/addr pass through; minJobApplied surfaced
//     in totals + payload when the floor binds.
// ════════════════════════════════════════════════════════════════════
section('PAYLOAD — neutral county default + owner/addr passthrough + min-floor flag');
const ctyMap = (V2 && typeof V2.loadSettings === 'function' && V2.loadSettings().countyTax) || {};
const hamRate = Number(ctyMap['hamilton-oh']);
ok("county tax map carries 'hamilton-oh'", Number.isFinite(hamRate) && hamRate > 0, 'got ' + hamRate);
const t7 = repairA || TPLS[0];
const r7 = JT.resolveSelection([{ templateId: t7.id }], smokeOpts(t7));
ok('resolve without opts.county taxes at the fallback rate (0.07), not any county rate',
  r7.totals && nearly(r7.totals.taxRate, 0.07, 1e-9), 'got ' + (r7.totals && r7.totals.taxRate));
const p7 = JT.buildEstimatePayload(r7, { name: 'County default' });
ok('payload stamps county null by default (neutral — no OH/KY county for off-list tenants)',
  p7 && p7.county === null, 'got ' + (p7 && p7.county));
ok('payload owner/addr default to blank strings', p7 && p7.owner === '' && p7.addr === '');
const altCounty = Object.keys(ctyMap).find(function (k) {
  return k !== 'hamilton-oh' && Number(ctyMap[k]) > 0 && Number(ctyMap[k]) !== hamRate;
});
ok('county tax map offers a second county at a different rate', !!altCounty);
if (altCounty) {
  const rAlt = JT.resolveSelection([{ templateId: t7.id }], smokeOpts(t7, { county: altCounty }));
  ok('explicit opts.county (' + altCounty + ') taxes at ' + ctyMap[altCounty],
    rAlt.totals && nearly(rAlt.totals.taxRate, Number(ctyMap[altCounty]), 1e-9),
    'got ' + (rAlt.totals && rAlt.totals.taxRate));
  const pAlt = JT.buildEstimatePayload(rAlt, { name: 'County explicit' });
  ok('payload persists the explicit county', pAlt && pAlt.county === altCounty, 'got ' + (pAlt && pAlt.county));
}
const pMeta = JT.buildEstimatePayload(r7, { name: 'Lead meta', owner: 'Jane Smith', addr: '12 Oak St' });
ok('payload stamps meta.owner', pMeta && pMeta.owner === 'Jane Smith', 'got ' + (pMeta && pMeta.owner));
ok('payload stamps meta.addr', pMeta && pMeta.addr === '12 Oak St', 'got ' + (pMeta && pMeta.addr));
// Min-floor binding: shrink a floored template to one near-zero line so
// minJobCharge binds, then check the flag surfaces end-to-end.
const floorTpl = TPLS.find(function (t) {
  return t && Number(t.minJobCharge) > 0 && t.measurements != null &&
    Array.isArray(t.items) && t.items.some(function (it) { return it && it.code; });
});
ok('found a floored template for the min-charge binding check', !!floorTpl);
if (floorTpl) {
  const keepIdx = floorTpl.items.findIndex(function (it) { return it && it.code; });
  const fChoices = {};
  floorTpl.items.forEach(function (it, i) {
    fChoices[i] = (i === keepIdx) ? { qty: 0.01 } : { include: false };
  });
  const rF = JT.resolveSelection([{ templateId: floorTpl.id, itemChoices: fChoices }], { tier: 'better' });
  const fFloor = Number(floorTpl.minJobCharge);
  ok('floor binds (' + floorTpl.id + '): totals.minJobApplied === true',
    rF.totals && rF.totals.minJobApplied === true,
    'minJobApplied=' + (rF.totals && rF.totals.minJobApplied) + ' total=' + (rF.totals && rF.totals.total));
  ok('floor binds: totals.total === minJobCharge (' + fFloor + ')',
    rF.totals && nearly(rF.totals.total, fFloor, 0.01), 'got ' + (rF.totals && rF.totals.total));
  const pF = JT.buildEstimatePayload(rF, { name: 'Floor' });
  ok('payload surfaces minJobApplied === true', pF && pF.minJobApplied === true);
  ok('payload grandTotal === floor', pF && nearly(pF.grandTotal, fFloor, 0.01),
    'got ' + (pF && pF.grandTotal));
}

// ════════════════════════════════════════════════════════════════════
// Sections 12-13 are async (createEstimate awaits _saveEstimate;
// hydrateFromCloud awaits getDocs) — the tail runs in one async IIFE
// that also owns the summary + exit code.
// ════════════════════════════════════════════════════════════════════
(async function () {

  // ══════════════════════════════════════════════════════════════════
  // 12. USAGE TRACKING — stickiness stamps {n, last} per template on
  //     successful createEstimate / insertIntoV2; list() overlays
  //     useCount / lastUsedAt; failed saves don't stamp; persisted
  //     customs never carry the overlay fields.
  // ══════════════════════════════════════════════════════════════════
  section('USAGE TRACKING — createEstimate/insertIntoV2 stamp; list() overlays');

  const USAGE_KEY = 'nbd_jt_usage_v1';
  ok("engine exports USAGE_KEY 'nbd_jt_usage_v1'", JT.USAGE_KEY === USAGE_KEY, 'got ' + JT.USAGE_KEY);
  // Earlier sections exercised insertIntoV2 (which now stamps usage) —
  // reset the map so the default-exposure check below is well-posed.
  win.localStorage.removeItem(USAGE_KEY);

  const preList = JT.list();
  ok('list() overlays useCount=0 / lastUsedAt=null on every template by default',
    preList.length > 0 && preList.every(function (t) { return t.useCount === 0 && t.lastUsedAt === null; }));

  const useTpl = repairA || TPLS[0];
  const savedPayloads = [];
  win._saveEstimate = async function (p) { savedPayloads.push(p); return 'est-fake-1'; };

  await JT.createEstimate([{ templateId: useTpl.id }], smokeOpts(useTpl, { name: 'Usage probe 1' }));
  let uEntry = JT.list().find(function (t) { return t.id === useTpl.id; });
  ok('createEstimate stamps useCount=1 on the used template (' + useTpl.id + ')',
    uEntry && uEntry.useCount === 1, 'got ' + (uEntry && uEntry.useCount));
  ok('createEstimate stamps a finite recent lastUsedAt',
    uEntry && Number.isFinite(Number(uEntry.lastUsedAt)) &&
    Math.abs(Date.now() - Number(uEntry.lastUsedAt)) < 60000,
    'got ' + (uEntry && uEntry.lastUsedAt));
  ok('the estimate actually saved through _saveEstimate', savedPayloads.length === 1 &&
    savedPayloads[0] && savedPayloads[0].builder === 'template');

  await JT.createEstimate([{ templateId: useTpl.id }], smokeOpts(useTpl, { name: 'Usage probe 2' }));
  uEntry = JT.list().find(function (t) { return t.id === useTpl.id; });
  ok('second createEstimate increments useCount to 2', uEntry && uEntry.useCount === 2,
    'got ' + (uEntry && uEntry.useCount));

  // Raw persistence contract: localStorage map {templateId: {n, last}}.
  let rawUsage = null;
  try { rawUsage = JSON.parse(win.localStorage.getItem(USAGE_KEY)); } catch (e) { rawUsage = null; }
  ok("usage persists under 'nbd_jt_usage_v1' as {templateId:{n,last}}",
    rawUsage && rawUsage[useTpl.id] && rawUsage[useTpl.id].n === 2 &&
    Number.isFinite(Number(rawUsage[useTpl.id].last)),
    'got ' + JSON.stringify(rawUsage && rawUsage[useTpl.id]));

  // insertIntoV2 stamps too (raw-result path — no EstimateV2UI here).
  JT.insertIntoV2([{ templateId: useTpl.id }], {});
  uEntry = JT.list().find(function (t) { return t.id === useTpl.id; });
  ok('insertIntoV2 stamps usage as well (2 → 3)', uEntry && uEntry.useCount === 3,
    'got ' + (uEntry && uEntry.useCount));

  // A FAILED save must NOT stamp (stickiness only counts real estimates).
  win._saveEstimate = async function () { throw new Error('save exploded'); };
  let threw = false;
  try { await JT.createEstimate([{ templateId: useTpl.id }], smokeOpts(useTpl)); }
  catch (e) { threw = true; }
  uEntry = JT.list().find(function (t) { return t.id === useTpl.id; });
  ok('failed _saveEstimate propagates AND does not stamp usage',
    threw && uEntry && uEntry.useCount === 3, 'threw=' + threw + ' n=' + (uEntry && uEntry.useCount));
  win._saveEstimate = async function (p) { savedPayloads.push(p); return 'est-fake-2'; };

  // Overlay fields never leak into persisted customs: duplicate() passes a
  // list() copy (carrying useCount/lastUsedAt) into saveCustom, which must
  // strip them before persisting.
  const dupSaved = JT.duplicate(useTpl.id);
  let storedCustoms = [];
  try { storedCustoms = JSON.parse(win.localStorage.getItem(JT.STORAGE_KEY)).items || []; }
  catch (e) { storedCustoms = []; }
  const dupStored = dupSaved && storedCustoms.find(function (t) { return t && t.id === dupSaved.id; });
  ok('duplicate() persists a custom WITHOUT the useCount/lastUsedAt overlay fields',
    dupStored && !('useCount' in dupStored) && !('lastUsedAt' in dupStored),
    dupStored ? 'keys: ' + Object.keys(dupStored).join(',') : 'duplicate not stored');
  if (dupSaved) JT.remove(dupSaved.id); // leave storage clean for section 13

  // ══════════════════════════════════════════════════════════════════
  // 13. CLOUD HYDRATION — pull-once LWW merge from users/{uid}/jobTemplates
  // ══════════════════════════════════════════════════════════════════
  section('CLOUD HYDRATION — hydrateFromCloud() LWW merge + _usage routing');

  ok('engine exports hydrateFromCloud()', typeof JT.hydrateFromCloud === 'function');
  ok('hydrateFromCloud resolves false when the SDK is not ready',
    (await JT.hydrateFromCloud()) === false);

  const NOW = Date.now();
  const oldIso = new Date(NOW - 100000).toISOString();
  const newIso = new Date(NOW - 1000).toISOString();

  // Local fixture: A stale (cloud must win), B fresh (local must win + upload).
  const localA = { id: 'jt_custom_hydra_a', name: 'Local A (stale)', custom: true, updatedAt: oldIso,
    items: [] };
  const localB = { id: 'jt_custom_hydra_b', name: 'Local B (fresh)', custom: true, updatedAt: newIso,
    items: [] };
  win.localStorage.setItem(JT.STORAGE_KEY, JSON.stringify({ _v: 1, items: [localA, localB] }));
  win.localStorage.setItem(USAGE_KEY, JSON.stringify({
    jt_custom_hydra_a: { n: 3, last: NOW - 50000 },   // cloud entry is NEWER → cloud wins
    jt_local_only:     { n: 7, last: NOW - 10 }       // cloud lacks it → local wins + mirrors up
  }));

  // Cloud fixture: A fresh (wins), B stale (loses), C cloud-only (lands),
  // plus the '_usage' rollup doc (routed, never a template).
  const cloudA = { id: 'jt_custom_hydra_a', name: 'Cloud A (fresh)', custom: true, updatedAt: newIso,
    items: [{ custom: { name: 'Hydra widget', unit: 'EA', qty: 2, materialCost: 10, laborCost: 5 } }] };
  const cloudB = { id: 'jt_custom_hydra_b', name: 'Cloud B (stale)', custom: true, updatedAt: oldIso, items: [] };
  const cloudC = { name: 'Cloud C (new device)', custom: true, updatedAt: newIso, items: [] }; // no id field → doc id fills it
  const cloudUsageDoc = { kind: 'usage', usage: {
    jt_custom_hydra_a: { n: 5, last: NOW - 20000 },
    jt_cloud_only:     { n: 2, last: NOW - 500 }
  }, updatedAt: newIso };

  const batchSets = [];
  const usageSets = [];
  win._db = { fake: true };
  win._user = { uid: 'test-uid' };
  win.doc = function () { return { fakeRef: Array.prototype.slice.call(arguments, 1) }; };
  win.collection = function () { return { fakeCol: Array.prototype.slice.call(arguments, 1) }; };
  win.getDocs = function () {
    const docs = [
      { id: 'jt_custom_hydra_a', data: function () { return JSON.parse(JSON.stringify(cloudA)); } },
      { id: 'jt_custom_hydra_b', data: function () { return JSON.parse(JSON.stringify(cloudB)); } },
      { id: 'jt_custom_hydra_c', data: function () { return JSON.parse(JSON.stringify(cloudC)); } },
      { id: '_usage',            data: function () { return JSON.parse(JSON.stringify(cloudUsageDoc)); } }
    ];
    return Promise.resolve({ forEach: function (cb) { docs.forEach(cb); } });
  };
  win.writeBatch = function () {
    return { set: function (ref, tpl) { batchSets.push(tpl); }, commit: function () { return Promise.resolve(); } };
  };
  win.setDoc = function (ref, payload) { usageSets.push(payload); return Promise.resolve(); };

  const hydrated = await JT.hydrateFromCloud();
  ok('hydrateFromCloud resolves true when the pull succeeds', hydrated === true);

  const afterA = JT.get('jt_custom_hydra_a');
  const afterB = JT.get('jt_custom_hydra_b');
  const afterC = JT.get('jt_custom_hydra_c');
  ok('LWW: strictly-newer CLOUD doc replaces the stale local (A)',
    afterA && afterA.name === 'Cloud A (fresh)', 'got ' + (afterA && afterA.name));
  ok('LWW: newer LOCAL custom survives a stale cloud echo (B)',
    afterB && afterB.name === 'Local B (fresh)', 'got ' + (afterB && afterB.name));
  ok('cloud-only template lands locally (new-device first run, doc id fills missing .id)',
    afterC && afterC.name === 'Cloud C (new device)', 'got ' + (afterC && afterC.name));
  ok("'_usage' doc id NEVER hydrates as a template (skip guard)",
    !JT.get('_usage') && !JT.list().some(function (t) { return t.id === '_usage'; }));

  // Local winners mirror back up — B only (A lost, C is cloud's own).
  const uploadedIds = batchSets.map(function (t) { return t && t.id; });
  ok('local-winner B mirrors back up; cloud winners are NOT re-uploaded',
    uploadedIds.length === 1 && uploadedIds[0] === 'jt_custom_hydra_b',
    'uploaded: [' + uploadedIds.join(', ') + ']');

  // Usage map: per-entry LWW by .last.
  let mergedUsage = null;
  try { mergedUsage = JSON.parse(win.localStorage.getItem(USAGE_KEY)); } catch (e) { mergedUsage = null; }
  ok('usage LWW: newer CLOUD entry wins per-key (hydra_a n 3→5)',
    mergedUsage && mergedUsage.jt_custom_hydra_a && mergedUsage.jt_custom_hydra_a.n === 5,
    'got ' + JSON.stringify(mergedUsage && mergedUsage.jt_custom_hydra_a));
  ok('usage LWW: local-only entry survives (jt_local_only n=7)',
    mergedUsage && mergedUsage.jt_local_only && mergedUsage.jt_local_only.n === 7);
  ok('usage LWW: cloud-only entry lands (jt_cloud_only n=2)',
    mergedUsage && mergedUsage.jt_cloud_only && mergedUsage.jt_cloud_only.n === 2);
  ok('list() overlays the hydrated usage (hydra_a useCount=5)',
    (JT.list().find(function (t) { return t.id === 'jt_custom_hydra_a'; }) || {}).useCount === 5);
  ok('local-newer usage mirrors back up as ONE _usage doc payload',
    usageSets.length >= 1 && usageSets[0] && usageSets[0].usage &&
    usageSets[0].usage.jt_local_only && usageSets[0].usage.jt_local_only.n === 7,
    'setDoc payloads: ' + usageSets.length);

  // Custom-item JT codes of cloud-pulled templates re-register (saved
  // estimates from the OTHER device resolve their 'JT *' rows here).
  const hydraCode = 'JT ' + jtSlug('jt_custom_hydra_a').toUpperCase() + '-0';
  const hydraEntry = XACT && typeof XACT.find === 'function' ? XACT.find(hydraCode) : null;
  ok('cloud-pulled custom item registered into NBD_XACT_CATALOG (' + hydraCode + ')',
    !!hydraEntry && Number(hydraEntry.materialCost) === 10 && Number(hydraEntry.laborCost) === 5,
    hydraEntry ? 'm=' + hydraEntry.materialCost + '/l=' + hydraEntry.laborCost : 'not found');

  // Teardown: drop the fake SDK so nothing else mirrors.
  delete win._db; delete win._user; delete win.doc; delete win.collection;
  delete win.getDocs; delete win.writeBatch; delete win.setDoc;

  // ══════════════════════════════════════════════════════════════════
  // Summary — per-section counts + grand total; non-zero exit on failure.
  // ══════════════════════════════════════════════════════════════════
  flushSection();
  console.log('\n──────────────────────────────────────────────────');
  sectionResults.forEach(function (s) {
    console.log((s.failed ? 'FAIL' : 'PASS') + '  ' + s.name + '  (' + s.passed + ' passed, ' + s.failed + ' failed)');
  });
  console.log('──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch(function (e) {
  console.error('FATAL: async test tail threw —', e);
  process.exit(1);
});
