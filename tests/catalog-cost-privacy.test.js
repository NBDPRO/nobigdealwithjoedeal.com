/**
 * tests/catalog-cost-privacy.test.js
 *
 * THE GUARD. docs/ is firebase.json hosting.public, so every file under it is
 * served unauthenticated at the site root — and this is a PUBLIC repo, so the
 * same bytes are readable from raw.githubusercontent.com whether hosting
 * serves them or not. docs/pro/js/product-data.js shipped wholesale COST beside
 * retail SELL for 187 SKUs (readable margin on every product; the real
 * figures are deliberately NOT repeated here — this file is public too), plus overheadMultiplier x176 and profitMarginPct x173, and
 * roofivent-catalog.js shipped a supplier's confidential contractor price list.
 * Worse, those were ONE company's supplier terms, handed to every other tenant
 * as their seed defaults. Cost data is now tenant-owned — it lives in
 * catalogCosts/{companyId} and is never distributed. This file is what stops
 * it coming back into the published tree.
 *
 * Three layers, because "don't publish costs" fails in more than one shape:
 *
 *   1. STRUCTURAL — load the real catalogs and assert no product object carries
 *      a private field. Catches any reintroduction that actually parses.
 *   2. SIGNATURE (every published file) — the retail-beside-wholesale pattern,
 *      `sell: N` and `cost: N` in the same object literal. Deliberately narrow
 *      so it can run over the whole hosting tree without false positives.
 *
 *   …plus layer 4 below, the COST-BASIS SWEEP, which now knows FOUR spellings
 *   of the same shape: cost/labor → mat/lab → materialCost/laborCost →
 *   rate/hoursPerUnit. Each was found only after it had already shipped. Every
 *   one of them is a number PAIRED with its partner, which is what lets these
 *   patterns run over 600 files without noise — and the reason to reach for a
 *   pairing rather than a keyword the next time this list grows.
 *   3. STRICT (EVERY published file, exemptions explicit) — any numeric cost /
 *      contractor / materialCost / laborCost / overheadMultiplier /
 *      profitMarginPct literal at all. Catches a cost table that never reaches
 *      a product object, and the two margin-policy constants that used to sit
 *      in product-library.js as `|| 1.35` / `|| 25`.
 *      This layer ran over a four-entry ALLOWLIST until 2026-08-18, which is
 *      exactly how job-templates-data.js published 84 contractor cost pairs for
 *      a month while this suite reported 48/48 green: it was on neither the
 *      allowlist nor the exception list, and a hole in an inclusion list is
 *      indistinguishable from a pass. It now scans by default; see
 *      STRICT_EXEMPT, where every non-scan is named, reasoned, narrowed to a
 *      line shape where possible, and asserted non-vacuous.
 *
 * Every layer is MUTATION-TESTED below: the scanner is fed a source that
 * reintroduces the leak and must flag it, and fed legitimate non-catalog code
 * and must not. A guard nobody has watched fail is not a guard.
 *
 * Pure-Node, no emulator. Run: node tests/catalog-cost-privacy.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { hasPrivateFields } = require(path.join(ROOT, 'functions', 'catalog-cost-logic.js'));
const REG = require(path.join(ROOT, 'functions', 'cost-basis-registry.js'));
const LED = require(path.join(__dirname, 'cost-basis-ledger.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; fails.push(label); }
}

/* ── scanners (pure: (rel, src) → string[] findings) ───────────────────── */

// Layer 2. `"sell":240,"cost":82` and `sell: 240, cost: 82`, either order,
// within a short window so it only matches the same object literal.
const SIGNATURE_RES = [
  /["']?sell["']?\s*:\s*-?\d[\d._]*\s*,\s*["']?cost["']?\s*:\s*-?\d/,
  /["']?cost["']?\s*:\s*-?\d[\d._]*\s*,\s*["']?sell["']?\s*:\s*-?\d/,
];

function scanSignature(rel, src) {
  const out = [];
  src.split(/\r?\n/).forEach((line, i) => {
    SIGNATURE_RES.forEach((re) => {
      const m = line.match(re);
      if (m) out.push(rel + ':' + (i + 1) + ': retail-beside-wholesale — ' + m[0].slice(0, 60));
    });
  });
  return out;
}

// Layer 3. Numeric-literal assignments to the private keys, in data files.
// The key must be in OBJECT-KEY position: the `(?<![.\w])` lookbehind rejects
// a property read, so `const cost = compute(x)`, `p.pricing[t].cost` and the
// ternary `costKnown ? p.pricing[t].cost : 0` don't trip it, while `cost: 82`
// and `"cost":82` do. An object key is never preceded by a dot, so this
// costs the guard nothing.
const STRICT_RES = [
  [/(?<![.\w])["']?cost["']?\s*:\s*-?\d/, 'numeric cost literal'],
  [/(?<![.\w])["']?contractor["']?\s*:\s*-?\d/, 'numeric contractor (supplier buy) literal'],
  [/(?<![.\w])["']?overheadMultiplier["']?\s*:\s*-?\d/, 'overheadMultiplier literal'],
  [/(?<![.\w])["']?profitMarginPct["']?\s*:\s*-?\d/, 'profitMarginPct literal'],
  [/overheadMultiplier\s*(?:\|\||\?\?)\s*-?\d/, 'overheadMultiplier fallback literal'],
  [/profitMarginPct\s*(?:\|\||\?\?)\s*-?\d/, 'profitMarginPct fallback literal'],
  // 2026-08-18. job-templates-data.js spelled the same thing a THIRD way:
  // "materialCost":N,"laborCost":N inside a `custom` line item, 84 times.
  // Adding that file to a scan list alone would have caught NOTHING —
  // measured: STRICT_RES[0] is /(?<![.\w])["']?cost["']?…/, and the lookbehind
  // that makes `p.pricing[t].cost` safe also rejects the `l` of "materialCost",
  // so the leaked file scored ZERO hits against the guard's own strict layer.
  // This pattern is what actually bites.
  [/(?<![.\w])["']?(?:material|labor)Cost["']?\s*:\s*-?\d/, 'named cost literal (materialCost/laborCost)'],
];

function stripComments(src) {
  // Prose in a header comment ("the 1.35 multiplier") is documentation, not a
  // published figure — and this file's own explanatory comments must not trip
  // the scanner it defines. Only executable text is scanned.
  //
  // Block comments are replaced by their OWN newlines, not by '', so the line
  // numbers in findings stay true to the source file. Collapsing them shifted
  // every reported line by the number of comment lines above it, which sends
  // whoever has to fix a leak to the wrong place.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

// Layer 5. PROSE. The structural layers only look at typed fields, so they all
// missed 4 SKUs whose `notes` string carried confirmed supplier-portal buy
// prices ("cost $41.33/bundle CONFIRMED via portal") plus the branch account
// number, sitting on the very same line the codemod had just stripped
// `"cost":N` out of. A free-text field on a public page is exactly as readable
// as a typed one.
const PROSE_FIELDS = ['notes', 'description', 'warranty'];
const PROSE_RES = [
  [/\$\s?\d/, 'a dollar figure in prose'],
  [/\b(?:ABC|SRS|Beacon|Allied|ProBuild)\s*#\s?\d{2,}/i, 'a supplier branch-account number'],
  [/\bcost\s*\$?\s?\d/i, 'a stated cost in prose'],
];

function scanProse(products) {
  const out = [];
  (products || []).forEach((p) => {
    PROSE_FIELDS.forEach((k) => {
      const v = p && p[k];
      if (typeof v !== 'string') return;
      PROSE_RES.forEach(([re, what]) => {
        const m = v.match(re);
        if (m) out.push(p.id + '.' + k + ': ' + what + ' — "' + v.slice(Math.max(0, v.indexOf(m[0]) - 20), v.indexOf(m[0]) + 40) + '"');
      });
    });
  });
  return out;
}

// `allow` (optional) is matched against the SOURCE LINE, so an exemption can
// name the benign shape instead of blanket-clearing the file.
function scanStrict(rel, src, allow) {
  const out = [];
  stripComments(src).split(/\r?\n/).forEach((line, i) => {
    STRICT_RES.forEach(([re, what]) => {
      const m = line.match(re);
      if (!m) return;
      if (allow && allow.test(line)) return;
      out.push(rel + ':' + (i + 1) + ': ' + what + ' — ' + m[0].slice(0, 60));
    });
  });
  return out;
}

// ── layer 3 scope: SCAN BY DEFAULT, EXEMPT EXPLICITLY (2026-08-18) ─────────
//
// This layer used to run over a four-entry STRICT_FILES allowlist. That is how
// docs/pro/js/job-templates-data.js — 84 custom line items carrying
// materialCost + laborCost, 146 non-zero contractor values, served 200 at
// ~188 KB — sat unscanned for a month while this suite reported 48/48 green.
// It was on neither the allowlist nor the exception list, and a hole in an
// inclusion list is indistinguishable from a pass.
//
// That was the SECOND guard defeated by its own list in a single day (the
// morning's svg.ico bug got through because ensure-icon-css.js skipped
// sites/pro/a stale free-guide entry). The durable answer is not "add one more
// file": it is to scan every published file and make every non-scan an
// explicit, reasoned, self-expiring entry below.
//
// Each exemption carries `why` and, where the benign shape is nameable, an
// `allow` regex — a finding on a line that does NOT match `allow` still fails.
// Every exemption is also asserted NON-VACUOUS: if a file stops matching
// entirely, the guard fails and tells you to delete the entry, so this list
// can never rot into a permanent carve-out the way the allowlist did.
const STRICT_EXEMPT = {
  'pro/js/estimate-config.js': {
    why: 'PERMIT_COSTS_BY_COUNTY — municipal permit fees (Hamilton OH 185, ' +
         'Boone KY 135). Public record, printed on the homeowner estimate as a ' +
         'line item, and deliberately published: they are not a supplier buy ' +
         'price and carry no margin. Layer 4 already exempts the same shape ' +
         '("a cost with no paired labor is not swept").',
    allow: /County,?\s*(?:OH|KY)/,
  },
  'pro/js/pages/pro-analytics.js': {
    why: 'AI-usage accumulator initialisers ({ requests: 0, tokens: 0, cost: 0 }). ' +
         'Zero-valued seeds for a per-model token-spend rollup.',
    allow: /tokens|requests|input|output/,
  },
  'pro/js/claude-proxy.js': {
    why: 'AI-usage accumulator initialiser ({ calls: 0, tokens: 0, cost: 0 }) in ' +
         'the localStorage month bucket.',
    allow: /calls|tokens/,
  },
  'pro/js/dashboard-bootstrap.module.js': {
    why: 'The read side of the same AI-usage month bucket ({ calls: 0, tokens: 0, ' +
         'cost: 0 } fallback). The file\'s REAL cost-basis risk — the v2cost* ' +
         'estimate-settings fallbacks — is pinned separately at layer 4f.',
    allow: /calls|tokens/,
  },
  'pro/js/storm-integration.js': {
    why: 'suggestedBudget for a storm-response CANVASSING campaign (door hangers ' +
         '500 @ 85, postcards, Facebook ads). Our own marketing spend suggestion, ' +
         'not a job cost basis and not tied to any quoted line item.',
    allow: /doorHangers|postcards|facebookAds|suggestedBudget/,
  },
  'pro/js/estimate-builder-v2.js': {
    why: 'Replaces the WHOLESALE layer-3 skip this file used to get for being on ' +
         'KNOWN_UNMIGRATED. Three declared line shapes, measured: 37 raw hits = ' +
         'the 28 CATALOG `cost: N, labor: N` pairs that ARE this file\'s published ' +
         'starter baseline (owned by the ledger in section 2c and by the layer-4 ' +
         'sweep, which see the PAIR rather than the word); the 7 county permit ' +
         'fees, the identical shape already exempted in estimate-config.js; and ' +
         'two explicit `materialCost: 0` / `laborCost: 0` zeros, which are a ' +
         'default and not a cost basis. Naming the shapes is strictly narrower ' +
         'than skipping the file, so a bare `cost: 340` with no paired labor — ' +
         'the real 2026-08-10 DEFAULT_COST_BASIS leak class — now FAILS here ' +
         'where it used to be invisible.',
    allow: /\bcost:\s*-?[\d.]+\s*,\s*labor:\s*-?[\d.]+|County,\s*(?:OH|KY)|(?:material|labor)Cost:\s*0\b/,
  },
  // estimate-catalog-xactimate.js deliberately gets NO entry. It was skipped
  // wholesale until 2026-08-19 and, measured, scores ZERO raw strict hits — the
  // skip bought nothing. An exemption here would be vacuous and would fail the
  // non-vacuity assertion below, which is the correct outcome.
  'blog/owens-corning-duration-vs-tamko-hailguard.html': {
    why: 'Prose false positive: "…through a TAMKO Pro Gold certified contractor: ' +
         '20-year Full Start…". A sentence colon before a numeral, not a ' +
         '`contractor:` buy-price key. Marketing copy, no figure.',
    allow: /certified contractor/i,
  },
};

// Layer 4. THE COST-BASIS SWEEP — the whole published tree, not a fixed list.
//
// Added after the product-data.js migration, because that migration was not
// the whole leak. docs/pro/js/estimate-builder-v2.js holds a SECOND, parallel
// cost catalog (a `cost:`/`labor:` pair per SKU) that layers 1-3 all
// missed: it has no `sell` key for the signature scan to pair against, and it
// was not on the STRICT_FILES list. It is also the catalog that actually
// prices homeowner estimates — `materialCost: Number(spec.cost)` marked up by
// DEFAULT_MATERIAL_MARKUP_PCT, with an "Internal margin view" computing
// `margin = total - totalCost`.
//
// So this layer keys on the SHAPE (an internal cost basis paired with a labor
// cost in one object literal) and sweeps every published file, so the next
// pricing catalog somebody adds cannot hide the same way.
const COST_BASIS_RE = /(?<![.\w])cost\s*:\s*-?\d[\d.]*\s*,\s*(?<![.\w])labor\s*:\s*-?\d/;
// Abbreviated spelling of the same shape (2026-08-10): the xactimate catalog
// ships 276 unit-cost pairs as `mat: N, lab: N` — semantically identical to
// cost/labor but invisible to COST_BASIS_RE, which is exactly how a 1,300-line
// cost book sat unswept next to the guard for a month.
const COST_BASIS_ABBREV_RE = /(?<![.\w])mat\s*:\s*-?\d[\d.]*\s*,\s*(?<![.\w])lab\s*:\s*-?\d/;
// THIRD spelling of the same shape (2026-08-18): job-templates-data.js shipped
// 84 `"materialCost":N,"laborCost":N` pairs inside custom line items.
// cost/labor → mat/lab → materialCost/laborCost. Each recurrence is the
// argument for sweeping on SHAPE rather than maintaining a list of spellings —
// and the fourth spelling (`rate:` + crewSize/hoursPerUnit, in the still-public
// estimate-labor-catalog.js) is on no list at all. See the audit note.
const COST_BASIS_NAMED_RE = /(?<![.\w])["']?materialCost["']?\s*:\s*-?\d[\d.]*\s*,\s*["']?laborCost["']?\s*:\s*-?\d/;
// FOURTH spelling (2026-08-18, same day as the third). estimate-labor-catalog.js
// ships 66 entries as `rate: 65, hoursPerUnit: 0.4` — a per-unit LABOR DOLLAR
// paired with the crew productivity that produces it, which is a labor cost
// basis by any other name. It matched none of the three patterns above, so it
// sat unswept and un-listed while the job-template migration that depends on it
// shipped.
//
// PAIRED, not bare. Measured across all 608 published files: this shape hits
// exactly one file (66 lines, zero false positives), while a bare `rate:\s*\d`
// hits five — sales-tax rates in estimate-config.js, close rates in
// close-board.js. A percentage is not a cost basis; a dollar-per-unit beside
// hours-per-unit is. Pairing is what has made every pattern in this file
// precise enough to run tree-wide.
const COST_BASIS_LABOR_RE = /(?<![.\w])["']?rate["']?\s*:\s*-?\d[\d.]*\s*,[\s\S]{0,120}?["']?hoursPerUnit["']?\s*:\s*-?\d/;

function scanCostBasis(rel, src) {
  const out = [];
  stripComments(src).split(/\r?\n/).forEach((line, i) => {
    const m = line.match(COST_BASIS_RE) || line.match(COST_BASIS_ABBREV_RE)
           || line.match(COST_BASIS_NAMED_RE) || line.match(COST_BASIS_LABOR_RE);
    if (m) out.push(rel + ':' + (i + 1) + ': internal cost basis — ' + m[0].slice(0, 60));
  });
  return out;
}

// PUBLISHED STARTER BASELINES — what replaced KNOWN_UNMIGRATED (2026-08-19).
//
// KNOWN_UNMIGRATED asked ONE question of TWO different things, and only one of
// them is answerable from this repo:
//
//   (a) does this file publish a contractor cost basis? OBSERVABLE, and for
//       these files PERMANENT — the baseline IS the product. Strip it and the
//       estimator does not degrade, it turns OFF (measured: a full reroof drops
//       from $12,425 to the $2,500 minimum-job floor with every line at 0,
//       because these values are the pricing and there is no public retail half).
//
//   (b) is that published basis still the shop's ACTUAL cost? NOT OBSERVABLE.
//       It stops being true at ROTATION, which writes catalogCosts/{companyId}
//       in Firestore and does not move one byte of this repo.
//
// The non-vacuity assertion below only ever checked (a) — "the sweep still
// finds pairs here" — while its LABEL claimed (b): "still leaking, keep
// tracking it". The day rotation lands the file is byte-identical, the sweep
// still finds 276 pairs, the assertion still passes, and the guard goes on
// printing a sentence that has become false with nothing anywhere prompting a
// revisit. That is a tracked debt rotting into a permanent carve-out by a route
// non-vacuity structurally cannot see: the file still matches, and the REASON
// changed.
//
// So (a) is asserted here and (b) is SIGNED, per catalog, in
// tests/cost-basis-ledger.js — a dated, named, per-tenant record a human pastes
// from what scripts/import-cost-rotation.js prints after a successful write.
// `rotation: null` is the honest default and is what a green run PRINTS. See
// section 2c below, and the ledger's header for why the pin is a commit rather
// than a digest.
const LEDGER = LED.LEDGER;
const LEDGER_FILES = new Set(Object.keys(LEDGER).map((id) => LEDGER[id].publishedIn));

/* ── the published tree (firebase.json hosting.ignore aware) ───────────── */

const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const ignore = fb.hosting.ignore || [];

function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; } else { re += '.*'; i += 1; }
      } else { re += '[^/]*'; }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      re += (c === '/' ? '/' : '\\' + c);
    } else { re += c; }
  }
  return new RegExp('^' + re + '$');
}
const ignoreRes = ignore.map(globToRe);
const isIgnored = (rel) => ignoreRes.some((r) => r.test(rel));

const HOSTING_ROOT = path.join(ROOT, fb.hosting.public);
function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out); else out.push(r);
  }
  return out;
}
const published = walk(HOSTING_ROOT, '', []).filter((f) => !isIgnored(f));
const scannable = published.filter((f) => /\.(js|mjs|json|html)$/i.test(f));

/* ── 1. structural: the live catalog carries no private fields ─────────── */

console.log('\ncatalog cost privacy — structural');
console.log('──────────────────────────────────────────────────');

const win = {};
win.window = win;
const sandbox = { window: win, Date, Math, JSON, Set, Object, console: { log() {} } };
['product-data.js', 'roofivent-catalog.js'].forEach((f) => {
  vm.runInNewContext(fs.readFileSync(path.join(HOSTING_ROOT, 'pro', 'js', f), 'utf8'), sandbox, { filename: f });
});
const PRODUCTS = win.NBD_PRODUCTS || [];

ok('catalog loaded (' + PRODUCTS.length + ' SKUs) — guard is not vacuous', PRODUCTS.length >= 260);
const structuralLeaks = PRODUCTS.filter(hasPrivateFields);
ok('no published product object carries cost/labor (leaking: ' +
   (structuralLeaks.map((p) => p.id).slice(0, 5).join(',') || 'none') + ')',
   structuralLeaks.length === 0);
ok('every product still carries retail sell on all three tiers',
   PRODUCTS.every((p) => ['good', 'better', 'best'].every((t) =>
     p.pricing && p.pricing[t] && typeof p.pricing[t].sell === 'number')));

const proseLeaks = scanProse(PRODUCTS);
ok('no product\'s prose fields carry a price or supplier account (' +
   (proseLeaks.slice(0, 2).join(' | ') || 'clean') + ')', proseLeaks.length === 0);

// 2026-09-25: layer 5 only ever read NBD_PRODUCTS, so the Xactimate catalog
// shipped "Contractor cost $75/box" in RFG NAIL-LUMA's desc — found by a design
// agent reading the file, not by this suite. Its prose, and the job templates'
// (description / scopeNotes / custom line names), are swept here too. Only the
// stated-cost and supplier-account shapes: a bare "$" figure is not flagged in
// these two, because the templates legitimately say "delete the $0 lines" (7
// scopeNotes, measured) and a retail figure in prose is allowed anyway.
const PROSE_RES_CATALOG = PROSE_RES.filter(([, what]) => what !== 'a dollar figure in prose');
function scanProseStrings(items) {
  const out = [];
  items.forEach(([where, v]) => {
    if (typeof v !== 'string') return;
    PROSE_RES_CATALOG.forEach(([re, what]) => {
      const m = v.match(re);
      if (m) out.push(where + ': ' + what + ' — "' + v.slice(Math.max(0, m.index - 20), m.index + 40) + '"');
    });
  });
  return out;
}
const catalogProse = (() => {
  const w = {};
  w.window = w;
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  w.localStorage = ls;
  const sb = { window: w, localStorage: ls, Date, Math, JSON, Set, Map, Object,
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    navigator: {}, setTimeout, clearTimeout };
  vm.createContext(sb);
  ['estimate-config.js', 'product-data.js', 'roofivent-catalog.js', 'estimate-labor-catalog.js',
   'estimate-builder-v2.js', 'estimate-catalog-xactimate.js', 'estimate-logic-engine.js',
   'job-templates-data.js', 'job-templates.js'].forEach((f) => {
    const p = path.join(HOSTING_ROOT, 'pro', 'js', f);
    if (!fs.existsSync(p)) return;
    try { vm.runInContext(fs.readFileSync(p, 'utf8'), sb, { filename: f }); } catch (e) { /* counted by the non-vacuity checks below */ }
  });
  const xc = w.NBD_XACT_CATALOG;
  const entries = xc && xc.byCode ? Object.values(xc.byCode).filter(Boolean) : [];
  const templates = Array.isArray(w.NBD_JOB_TEMPLATES) ? w.NBD_JOB_TEMPLATES : [];
  const strings = [];
  entries.forEach((e) => ['name', 'desc', 'reason', 'notes'].forEach((k) => strings.push(['xact ' + e.code + '.' + k, e[k]])));
  templates.forEach((t) => {
    ['name', 'description', 'scopeNotes'].forEach((k) => strings.push(['template ' + t.id + '.' + k, t[k]]));
    (t.items || []).forEach((it) => { if (it && it.custom) ['name', 'desc'].forEach((k) => strings.push(['template ' + t.id + ' custom.' + k, it.custom[k]])); });
  });
  return { entries: entries.length, templates: templates.length, leaks: scanProseStrings(strings) };
})();
ok('Xactimate catalog loaded for the prose sweep (' + catalogProse.entries + ' codes) — not vacuous',
   catalogProse.entries >= 300);
ok('job templates loaded for the prose sweep (' + catalogProse.templates + ') — not vacuous',
   catalogProse.templates >= 100);
ok('no catalog/template prose states a cost or supplier account (' +
   (catalogProse.leaks.slice(0, 2).join(' | ') || 'clean') + ')', catalogProse.leaks.length === 0);

/* ── 2. signature scan across the whole published tree ─────────────────── */

console.log('\ncatalog cost privacy — published tree');
console.log('──────────────────────────────────────────────────');

const sigFindings = [];
scannable.forEach((rel) => {
  sigFindings.push(...scanSignature(rel, fs.readFileSync(path.join(HOSTING_ROOT, rel), 'utf8')));
});
ok('scanned a real tree (' + scannable.length + ' published js/json/html files)', scannable.length > 50);
ok('no published file pairs sell with cost (' + (sigFindings.slice(0, 3).join(' | ') || 'clean') + ')',
   sigFindings.length === 0);

// ── layer 3: strict scan over EVERY published file, exemptions explicit ──
const strictFindings = [];
const exemptHits = new Map();
let strictScanned = 0;
scannable.forEach((rel) => {
  const src = fs.readFileSync(path.join(HOSTING_ROOT, rel), 'utf8');
  // 2026-08-19: the wholesale skip for KNOWN_UNMIGRATED files is GONE. It was
  // a two-name blanket exemption — the shape this suite has twice been beaten
  // by — and it was mostly unnecessary: measured, estimate-catalog-xactimate.js
  // scores ZERO raw strict hits, so its skip bought nothing at all, and
  // estimate-builder-v2.js scores 37, every one of which is a nameable line
  // shape (see STRICT_EXEMPT). Naming the shapes is strictly narrower than
  // skipping the file, so layer 3 gains coverage it never had: a bare
  // `cost: 340` with no paired labor inside EBv2 now FAILS where it was
  // invisible. strictScanned 606 → 608, no skips left.
  strictScanned++;
  const exempt = STRICT_EXEMPT[rel];
  const hits = scanStrict(rel, src, exempt && exempt.allow);
  if (exempt) {
    // Non-vacuity: an exemption that no longer matches anything is dead and
    // must be deleted, or the list rots into a permanent carve-out.
    exemptHits.set(rel, scanStrict(rel, src).length);
  }
  strictFindings.push(...hits);
});
ok('strict layer scans BY DEFAULT (' + strictScanned + ' published files, not a 4-entry allowlist)',
   strictScanned > 500);
ok('no published file carries a cost/contractor/margin/named-cost literal (' +
   (strictFindings.slice(0, 3).join(' | ') || 'clean') + ')',
   strictFindings.length === 0);
ok('every strict exemption names a file that is actually published',
   Object.keys(STRICT_EXEMPT).every((f) => published.includes(f)));
Object.keys(STRICT_EXEMPT).forEach((f) => {
  ok('strict exemption is non-vacuous, keep it: ' + f + ' (' + (exemptHits.get(f) || 0) + ' raw hits)',
     (exemptHits.get(f) || 0) > 0);
});
// The four files the old allowlist named are pricing data by definition. They
// are in scope now by default rather than by enumeration — assert that, so a
// future refactor that moves one out of docs/ is noticed rather than silently
// dropping it from the sweep.
['pro/js/product-data.js', 'pro/js/roofivent-catalog.js', 'pro/js/catalog-costs.js',
 'pro/js/product-library.js', 'pro/js/job-templates-data.js'].forEach((f) => {
  ok('pricing-data file is published and in strict scope: ' + f,
     scannable.includes(f) && !(f in STRICT_EXEMPT));
});

// ── layer 4: cost-basis sweep over the whole published tree ──────────────
const basisByFile = new Map();
scannable.forEach((rel) => {
  const hits = scanCostBasis(rel, fs.readFileSync(path.join(HOSTING_ROOT, rel), 'utf8'));
  if (hits.length) basisByFile.set(rel, hits);
});

const unexpected = Array.from(basisByFile.keys()).filter((f) => !LEDGER_FILES.has(f));
ok('no UNDECLARED published file carries an internal cost basis (' +
   (unexpected.join(', ') || 'none') + ')', unexpected.length === 0);

// The migrated catalogs, asserted as POSITIVES (zero entries in the sweep),
// never as an absence from a list — an absence is what let job-templates-data.js
// leak for a month. These three are DONE: nothing published, nothing to rotate,
// and they are not ledger rows because there is nothing left to declare.
['pro/js/product-data.js', 'pro/js/roofivent-catalog.js', 'pro/js/job-templates-data.js'].forEach((f) => {
  ok('MIGRATED catalog reports ZERO cost-basis entries in the tree sweep: ' + f +
     ' (' + ((basisByFile.get(f) || []).length) + ')',
     (basisByFile.get(f) || []).length === 0 && !LEDGER_FILES.has(f));
});

/* ── 2c. THE ROTATION LEDGER — what is published, and who signed for it ─── */
//
// This section replaces the KNOWN_UNMIGRATED non-vacuity loop, the hardcoded
// three-row override-path table that used to be 2a0, and two thirds of the
// hand-written labor-catalog block. One table, derived from
// functions/cost-basis-registry.js (files, fields and entry loaders) and
// tests/cost-basis-ledger.js (the human half). A fourth catalog is a registry
// entry plus a ledger row, not another filename pasted into this file.
//
// TWO PROPOSITIONS, AND ONLY ONE OF THEM IS ASSERTABLE.
//
//   OBSERVABLE — the baseline is still published, whatever the registry says
//   must LEAVE has left, the tenant override path is still wired, and layer 4's
//   shape sweep still sees exactly the files it is declared to see. All
//   asserted below, per row, off a STRUCTURAL entry count (REG.pricedEntries)
//   rather than a regex hit count — which is the direct fix for the bug that
//   knocked the labor catalog off the old list: removing hoursPerUnit blinded
//   COST_BASIS_LABOR_RE on 66 still-published rates, and a shape-based list
//   cannot express "this half is closed and that half is deliberately open".
//
//   NOT OBSERVABLE — whether the shop's figures have been ROTATED. That happens
//   in catalogCosts/{companyId}, in Firestore. There is nothing in this repo to
//   read, and any mechanism claiming to detect it automatically is lying about
//   what it can do. So it is a signed human record, and while it is null the
//   guard says the true thing on every green run: these published figures ARE
//   the shop's cost basis today.
//
// WHY THERE IS NO REVIEW CLOCK HERE, since it is the obvious instrument and was
// deliberately rejected. A deadline that only Jo can legitimately clear turns
// this suite — the one thing standing between the cost book and the public tree
// — into a scheduled red on every unrelated PR. tests/ci-manifest.json already
// ships a `quarantined` bucket ("known-red with a dated reason, not run"), so
// the cheapest response to that red is one line that disables all ~100
// assertions here, including the tree-wide sweep. A countdown on the guard is
// not a forcing function; it is a countdown on the guard. The deadline belongs
// where Jo plans from — documentation/projects/WEEKLY_CADENCE.md and the
// handoff brief — and this file's job is to make sure that when the work IS
// done, saying so is one paste, and that nothing here claims it was done until
// somebody does.
//
// WHAT DOES FIRE, and it is the only repo-observable event that matters here:
// a line item being REPRICED while a rotation claim stands. That is the innocuous
// PR — "update the catalog to current pricing" — that silently re-publishes the
// actuals and un-stales a rotated baseline. Measured across the entire history
// of all three catalogs (24 commits: two refactors, a security strip, the TAMKO
// preset, two warranty-accuracy corrections, the county-permit unification, the
// globals tranche, the crew-productivity migration): items were ADDED 9 times
// and REMOVED 3 times, and an existing key's published cost value was repriced
// exactly ZERO times. So composition change is reported, never failed, and the
// repricing check has a measured false-positive rate of zero over the whole
// history — which is what stops it being loosened by the next person the way a
// syntax-pinned guard was on 2026-08-19.

console.log('\ncatalog cost privacy — the rotation ledger (published baselines, per catalog)');
console.log('──────────────────────────────────────────────────');

const rotationDebt = [];
// Proof this section actually RAN against the real tree. LED.rotationFindings
// is a pure function, so section 4g can drive every branch of it on synthetic
// rows — and a pure function that nothing calls is a mechanism that has been
// unwired while all its mutation tests stay green. Delete the loop below and
// this goes empty; delete the whole block and 4g throws. Either way it cannot
// go quietly green, which is the one thing a bolt-on must not be able to do.
const ledgerChecked = [];

Object.keys(LEDGER).forEach((id) => {
  const row = LEDGER[id];
  const rel = row.publishedIn;
  const abs = path.join(HOSTING_ROOT, rel);
  const src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const code = stripComments(src);
  const catalog = REG.CATALOGS[id];
  const figures = catalog ? LED.publishedFigures(catalog, 'worktree') : null;
  const nEntries = figures ? Object.keys(figures).length : 0;
  const swept = (basisByFile.get(rel) || []).length;

  // (0) NON-VACUITY FOR EVERYTHING BELOW IT. The row names a real catalog, the
  //     file is really published, and it really loads into priced entries. A
  //     catalog that stopped loading would make every assertion under it pass
  //     silently, which is the failure mode this whole section exists to end.
  ok('ledger row "' + id + '" names a registered catalog whose file is published and loads (' +
     rel + ', ' + nEntries + ' priced entries)',
     !!catalog && published.includes(rel) && nEntries > 0);

  // (a) THE CLOSED HALF — whatever the registry declares must LEAVE has left,
  //     structurally AND textually, because a shared constant that feeds no
  //     entry parses clean while still publishing the figure (the CRLF
  //     near-miss of 2026-08-19). `unpublished: []` is itself a declaration and
  //     PRINTS as one, so an empty loop never passes as a silent green.
  const gone = (catalog && catalog.unpublished) || [];
  const still = gone.reduce((acc, f) => {
    const n = (code.match(new RegExp('\\b' + f + '\\s*:', 'g')) || []).length;
    return n ? acc.concat([f + ' ×' + n]) : acc;
  }, []);
  ok('ledger row "' + id + '" publishes nothing the registry says must leave (' +
     (gone.length
       ? (still.join(', ') || 'clean: ' + gone.join(', '))
       : 'registry declares unpublished: [] — nothing here CAN leave, the figures ARE the pricing')
     + ')', still.length === 0);

  // (b) THE OPEN HALF — asserted PRESENT, on purpose. If a baseline ever
  //     vanishes, a tenant with no cost book can no longer price anything.
  //     Whoever removes one should have to come here and say so.
  ok('ledger row "' + id + '" still publishes its starter price book (' + nEntries +
     ' entries, floor ' + row.minEntries + ') — DELIBERATE: stripping it turns the ' +
     'estimator off rather than degrading it, and rotation is what makes it safe',
     nEntries >= row.minEntries);

  // (c) THE OVERRIDE PATH — a baseline you cannot override is not a baseline,
  //     it is simply the price. Two independent tokens, no proximity window.
  ok('ledger row "' + id + '" is actually overridable: ' + row.overrideWhat,
     /NBDCatalogCosts/.test(src) && row.overrideMarker.test(src));

  // (d) THE SHAPE SWEEP SEES WHAT IT IS DECLARED TO SEE — both directions.
  //     Declared visible and finding nothing means a layer-4 pattern broke;
  //     declared invisible and finding something means a migrated field came
  //     back. Neither can pass as the other, and neither can pass as "fine".
  ok('ledger row "' + id + '" matches its declared layer-4 visibility (' + swept +
     ' swept, expected ' + (row.sweptByShape ? '>0' : '0 — the paired regex is blind here since ' +
     'the productivity half migrated out, which is why this row is tracked structurally') + ')',
     row.sweptByShape ? swept > 0 : swept === 0);

  // (e) ROTATION — the one fact no test can observe, so it is a signed CLAIM,
  //     and a claim can only be checked for being well formed, for clearing the
  //     same coverage floor scripts/cost-rotation.js refuses below, and for
  //     still covering the figures it was made about.
  const r = row.rotation;
  let ctx = {};
  if (r && typeof r === 'object' && typeof r.basisAt === 'string' && /^[0-9a-f]{7,40}$/.test(r.basisAt)) {
    const basisDate = LED.commitDate(r.basisAt);
    const then = basisDate && catalog ? LED.publishedFigures(catalog, r.basisAt) : null;
    ctx = { basisDate, drift: (then && figures) ? LED.comparePublished(then, figures) : null };
  }
  const findings = LED.rotationFindings(id, row, ctx);
  findings.forEach((x) => console.log('  ! ' + x));
  ledgerChecked.push(id + ':' + nEntries);

  if (r === null || r === undefined) {
    rotationDebt.push(id + ' — ' + rel.split('/').pop() + ', open since ' + row.opened);
    ok('ledger row "' + id + '" — NOT ROTATED (open since ' + row.opened + '): the ' + nEntries +
       ' published figures in ' + rel + ' ARE the shop\'s cost basis today, and nothing in ' +
       'this repo can see when that stops being true',
       findings.length === 0);
  } else {
    const d = ctx.drift;
    ok('ledger row "' + id + '" — ROTATED ' + (r.at || '?') + ' by ' + (r.by || '?') +
       ' for company ' + (r.company || '?') + ' (' + Math.round((r.coverage || 0) * 100) +
       '% of the basis), signed against ' + (r.basisAt || '?') +
       (d ? '; since then +' + d.added.length + ' / -' + d.removed.length + ' line items, ' +
            d.repriced.length + ' repriced' : ''),
       findings.length === 0);
  }
});

// THE LEDGER CANNOT BECOME THE NEXT INCOMPLETE LIST — closed in both
// directions, because a hole in an inclusion list is indistinguishable from a
// pass and this suite has learned that twice.
//   forward   every file the SWEEP finds must be a ledger row (asserted above,
//             at layer 4: "no UNDECLARED published file carries a cost basis").
//   backward  every catalog the ROTATION TOOLING can rotate must have a row, so
//             a fifth cost catalog cannot get tooling without a declared state.
Object.keys(REG.CATALOGS).forEach((id) => {
  ok('rotation catalog "' + id + '" has a ledger row (functions/cost-basis-registry.js can ' +
     'rotate it, so something here must say what its published file is doing)',
     Object.prototype.hasOwnProperty.call(LEDGER, id));
});

// NOT an assertion, deliberately. An open obligation is not a failing build:
// CI would be red on main for as long as it takes Jo to do data entry, and a
// permanently red gate is a gate that gets quarantined. This is a line with a
// number in it, printed on every run, that only shrinks when the work is done.
if (rotationDebt.length) {
  console.log('\n  ROTATION OUTSTANDING — ' + rotationDebt.length + ' of ' +
              Object.keys(LEDGER).length + ' published baselines:');
  rotationDebt.forEach((d) => console.log('    · ' + d));
  console.log('  The published baseline is not the problem; its ACCURACY is. To close one:');
  console.log('    node scripts/cost-rotation.js --catalog <id> --worksheet');
  console.log('    node scripts/cost-rotation.js --catalog <id> --apply .local/rotation-<id>.json');
  console.log('    node scripts/import-cost-rotation.js --catalog <id> --company <id> --yes');
  console.log('  That last command prints the exact `rotation:` block to paste into');
  console.log('  tests/cost-basis-ledger.js, on success. NOTHING HERE CAN DETECT THAT YOU DID');
  console.log('  IT — rotation changes Firestore, not this repo. Recording it IS the job.');
}

/* ── 2a. LABOR CATALOG — the half that CLOSED (the open half is a ledger row) ── */
//
// estimate-labor-catalog.js was this codebase's first PARTIAL migration.
// Everything generic about it — the baseline still present, the override path,
// the layer-4 visibility, the rotation state — is now a ledger row above, in one
// table with the other two, and duplicating it here would only invite the two
// copies to disagree. What stays is the genuinely file-specific half: the
// productivity strip, asserted structurally AND textually, because a shared
// constant that feeds no entry parses clean while still publishing the figure.
// That is the CRLF near-miss (`const CREW = 4` / `const RATE_PER_MH = 35`
// survived a codemod whose `.*` tail never matched across `\r\n`), and it
// belongs nowhere else.

console.log('\ncatalog cost privacy — labor catalog (the closed half)');
console.log('──────────────────────────────────────────────────');

{
  const rel = 'pro/js/estimate-labor-catalog.js';
  const abs = path.join(HOSTING_ROOT, rel);
  ok('labor catalog is published (the assertions below are not vacuous)', fs.existsSync(abs));
  const code = stripComments(fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '');

  const PRODUCTIVITY = ['hoursPerUnit', 'crewSize', 'ratePerManHour'];
  const prodHits = PRODUCTIVITY.reduce((acc, f) => {
    const n = (code.match(new RegExp('\\b' + f + '\\s*:', 'g')) || []).length;
    return n ? acc.concat([f + ' ×' + n]) : acc;
  }, []);
  ok('labor catalog publishes NO crew productivity (' + (prodHits.join(', ') || 'clean') + ')',
     prodHits.length === 0);
  ok('no orphaned crew/man-hour constant survives the strip',
     !/\bconst\s+(?:CREW|RATE_PER_MH)\s*=/.test(code));
}

/* ── 2b. THE REPO IS PUBLIC TOO — no real cost pair outside docs/ ───────── */
//
// Every layer above scans docs/, the Hosting root. But this is a PUBLIC GitHub
// repo, so tests/ and documentation/ publish whatever they quote — and they
// publish it in a MORE legible form than a 188KB minified data file.
//
// This layer exists because that failed twice in one day (2026-08-18). First
// the two cost-leak vault notes quoted the very figures they were written to
// protect — an audit with three worked examples, a migration plan with a table
// pairing each item's cost with its retail — caught by hand while pushing.
// Then the follow-up PR did it again in test FIXTURES: a legacy-fork case and
// four mutation strings carrying real pairs lifted from the catalogs. A
// standing prose rule was not enough, twice.
//
// VALUE-based, not shape-based, and that distinction is the whole design. A
// shape scan over tests/ + documentation/ was measured first: 12 files, almost
// all legitimately synthetic round numbers, which is noise rather than a guard.
// The only question worth asking is "is this number REAL", and shape cannot
// answer it. So: load the still-published catalogs, collect every cost pair
// they actually contain, and refuse to find any of them quoted outside docs/.
// Zero false positives by construction — a synthetic fixture that collides
// with a real pair is a fixture worth changing anyway.
//
// LIMIT, stated so nobody over-trusts this: it can only see values that are
// STILL in the tree. It would not have caught the job-template pairs, which
// had already left. What it does cover is every value Phase 2 is about to
// move, and it goes to work the moment those files are stripped.

console.log('\ncatalog cost privacy — the repo is public too (nothing outside docs/)');
console.log('──────────────────────────────────────────────────');

const REAL_PAIRS = (() => {
  const win2 = {};
  win2.window = win2;
  const sb = { window: win2, Date, Math, JSON, Set, Map, Object, console: { log() {}, warn() {} } };
  vm.createContext(sb);
  ['product-data.js', 'roofivent-catalog.js', 'estimate-labor-catalog.js',
   'estimate-builder-v2.js', 'estimate-catalog-xactimate.js'].forEach((f) => {
    const p = path.join(HOSTING_ROOT, 'pro', 'js', f);
    if (!fs.existsSync(p)) return;
    try { vm.runInContext(fs.readFileSync(p, 'utf8'), sb, { filename: f }); } catch (e) { /* a catalog that won't load is layer 1's problem */ }
  });
  const out = new Set();
  const add = (a, b) => { if (Number(a) > 0 && Number(b) > 0) out.add(Number(a) + '/' + Number(b)); };
  Object.values((win2.EstimateBuilderV2 && win2.EstimateBuilderV2.CATALOG) || {}).forEach((e) => e && add(e.cost, e.labor));
  const xc = win2.NBD_XACT_CATALOG;
  if (xc && xc.byCode) Object.values(xc.byCode).forEach((e) => { if (e) { add(e.mat, e.lab); add(e.materialCost, e.laborCost); } });
  return out;
})();

// Non-vacuity: a loader that silently returns nothing would make the sweep
// below pass forever. Phase 2 will legitimately shrink this as catalogs are
// migrated — when it reaches zero this whole layer is obsolete, and that is a
// deliberate decision to make, not a threshold to quietly lower.
ok('collected real cost pairs from the still-published catalogs (' + REAL_PAIRS.size + ')',
   REAL_PAIRS.size >= 100);

const PAIR_RE = /(?:materialCost|mat|cost)["']?\s*[:=]\s*(-?[\d.]+)\s*,\s*["']?(?:laborCost|lab|labor)["']?\s*[:=]\s*(-?[\d.]+)/g;
function scanRealPairs(rel, src) {
  const out = [];
  src.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(PAIR_RE)) {
      // Report the LOCATION only. CI logs on a public repo are public, so a
      // guard against republishing figures must not print the figures to fail.
      if (REAL_PAIRS.has(Number(m[1]) + '/' + Number(m[2]))) out.push(rel + ':' + (i + 1));
    }
  });
  return out;
}

let trackedOutsideDocs = [];
try {
  trackedOutsideDocs = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean)
    .filter((f) => !f.startsWith('docs/') && /\.(js|mjs|json|md|html)$/i.test(f));
} catch (e) { trackedOutsideDocs = []; }

ok('enumerated the tracked non-docs tree (' + trackedOutsideDocs.length + ' files)', trackedOutsideDocs.length > 100);
const republished = [];
trackedOutsideDocs.forEach((rel) => {
  let src;
  try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return; }
  republished.push(...scanRealPairs(rel, src));
});
ok('no file outside docs/ quotes a real published cost pair (' +
   (republished.slice(0, 4).join(', ') || 'clean') + ')', republished.length === 0);

// The guard must be watched failing, like every other layer here.
{
  const anyReal = Array.from(REAL_PAIRS)[0] || '1/1';
  const [rm, rl] = anyReal.split('/');
  ok('MUTANT killed: a real catalog pair pasted into a note or fixture',
     scanRealPairs('documentation/x.md', 'e.g. materialCost: ' + rm + ', laborCost: ' + rl).length > 0);
  ok('control: an obviously synthetic pair is not flagged',
     scanRealPairs('tests/x.test.js', 'materialCost: 13, laborCost: 37').length === 0 ||
     REAL_PAIRS.has('13/37'));
}

/* ── 3. the extracted cost book must never be committed ────────────────── */

console.log('\ncatalog cost privacy — seed stays out of the repo');
console.log('──────────────────────────────────────────────────');

ok('.gitignore excludes .local/ (where the extracted seed lands)',
   /^\.local\/$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));

// Match the EXTRACTED ARTEFACT, not every file with "cost-seed" in its name —
// tests/catalog-cost-seed.test.js is supposed to be tracked.
let tracked = '';
try {
  tracked = execFileSync('git', ['ls-files', '--', '*catalog-cost*.json', '.local'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch (e) { tracked = ''; }
ok('no extracted cost book is tracked by git (' + (tracked || 'none') + ')', tracked === '');

/* ── 4. MUTATION TESTS — prove each layer actually fires ───────────────── */

console.log('\ncatalog cost privacy — mutation tests (the guard must FAIL on a leak)');
console.log('──────────────────────────────────────────────────');

// 4a. structural
{
  const clone = JSON.parse(JSON.stringify(PRODUCTS.find((p) => p.id === 'shingle_001')));
  ok('control: the real shingle_001 is clean', !hasPrivateFields(clone));
  clone.pricing.good.cost = 82;
  ok('MUTANT killed: pricing.good.cost reintroduced → flagged', hasPrivateFields(clone));

  const clone2 = JSON.parse(JSON.stringify(clone));
  delete clone2.pricing.good.cost;
  clone2.labor = { perUnit: 75, ratePerManHour: 35 };
  ok('MUTANT killed: a labor block reintroduced → flagged', hasPrivateFields(clone2));
}

// 4b. signature scan
{
  const jsonShape = '{"id":"shingle_001","pricing":{"good":{"sell":240,"cost":82}}}';
  ok('MUTANT killed: JSON sell-then-cost (product-data.js shape)',
     scanSignature('x.js', jsonShape).length > 0);

  const jsShape = 'return { good: { sell: msrp, cost: contractor }, better: { sell: 1, cost: 2 } };';
  ok('MUTANT killed: JS sell:/cost: pair (roofivent makePricing shape)',
     scanSignature('x.js', jsShape).length > 0);

  ok('MUTANT killed: reversed key order (cost before sell)',
     scanSignature('x.js', '{"cost":82,"sell":240}').length > 0);

  // Negative controls — the scan must be usable across 200+ unrelated files.
  ok('control: a cost READ is not flagged',
     scanSignature('x.js', 'const matCost = p.pricing?.[t]?.cost || 0;').length === 0);
  ok('control: sell-only (the shipped shape) is not flagged',
     scanSignature('x.js', '{"pricing":{"good":{"sell":240},"better":{"sell":275}}}').length === 0);
  ok('control: unrelated cost words are not flagged',
     scanSignature('x.js', 'leadCostMeter.set({ costUsd: 8.4 }); // cost tracking').length === 0);
}

// 4c. strict scan
{
  ok('MUTANT killed: a bare contractor price table in a catalog file',
     scanStrict('pro/js/roofivent-catalog.js', "sizes: { '4': { contractor: 76, msrp: 95 } }").length > 0);
  ok('MUTANT killed: overheadMultiplier literal restored',
     scanStrict('pro/js/product-data.js', '"labor":{"overheadMultiplier":1.35}').length > 0);
  ok('MUTANT killed: profitMarginPct restored as a `|| 25` form fallback',
     scanStrict('pro/js/product-library.js', "value: p?.labor?.profitMarginPct || 25").length > 0);
  ok('MUTANT killed: a cost lookup table that never reaches a product object',
     scanStrict('pro/js/product-data.js', 'const COSTS = { shingle_001: { cost: 82 } };').length > 0);

  ok('control: comments explaining the split are not flagged',
     scanStrict('pro/js/catalog-costs.js', '// the old defaults were overheadMultiplier: 1.35 and profitMarginPct: 25').length === 0);
  ok('control: reading the key off an object is not flagged',
     scanStrict('pro/js/product-library.js', 'const om = p.labor.overheadMultiplier;').length === 0);

  // The `(?<![.\w])` lookbehind exists for these two. They are property READS
  // in a ternary — the real code shape that "cost not set" introduced. Both
  // must stay unflagged, and the object-key forms just above must stay
  // flagged, or the narrowing has quietly disarmed the guard.
  ok('control: a ternary falling back to 0 on a cost READ is not flagged',
     scanStrict('pro/js/product-library.js', 'const matCost = costKnown ? p.pricing[tierForMargin].cost : 0;').length === 0);
  ok('control: a ternary on the margin policy is not flagged',
     scanStrict('pro/js/product-library.js', 'const om = has ? p.labor.overheadMultiplier : 1;').length === 0);
  ok('MUTANT still killed after the ternary carve-out: a real object key',
     scanStrict('pro/js/product-data.js', 'pricing: { good: { sell: 240, cost: 82 } }').length > 0);
  ok('MUTANT still killed after the ternary carve-out: a quoted JSON key',
     scanStrict('pro/js/product-data.js', '{"pricing":{"good":{"cost":82}}}').length > 0);

  // The named spelling (2026-08-18). The FIRST of these is the assertion that
  // matters: it is the exact byte sequence that sat published for a month and
  // scored zero against every pattern above it.
  ok('MUTANT killed: the job-template custom-item shape (the real 2026-08-18 leak)',
     scanStrict('pro/js/job-templates-data.js',
       '{"custom":{"name":"Synthetic probe item","unit":"EA","qty":1,"materialCost":13,"laborCost":37}}').length > 0);
  ok('MUTANT killed: laborCost alone, unquoted',
     scanStrict('pro/js/job-templates-data.js', 'custom: { laborCost: 37 }').length > 0);
  ok('MUTANT killed: sub-dollar decimal (24 of the 84 leaked items carried one)',
     scanStrict('pro/js/job-templates-data.js', '"materialCost":0.13').length > 0);
  ok('control: the engine READING an item\'s cost is not flagged',
     scanStrict('pro/js/estimate-logic-engine.js',
       'matCostPerUnit = Number(item.materialCost); labCostPerUnit = Number(item.laborCost);').length === 0);
  ok('control: the EXPLICIT ZERO the strip emits is a cost of 0, not a cost basis — but it is still an object key, so it IS flagged in a data file',
     scanStrict('pro/js/job-templates-data.js', '"materialCost":0,"laborCost":0').length > 0);

  // Exemptions must NARROW, never blanket. A real leak on an un-allowed line
  // of an exempt file has to survive the carve-out.
  {
    const cfgAllow = STRICT_EXEMPT['pro/js/estimate-config.js'].allow;
    ok('control: an exempt file\'s allowed line stays clean (permit fee)',
       scanStrict('pro/js/estimate-config.js',
         "'hamilton-oh': Object.freeze({ name: 'Hamilton County, OH', cost: 185 })", cfgAllow).length === 0);
    ok('MUTANT killed: a REAL cost basis smuggled into an exempt file',
       scanStrict('pro/js/estimate-config.js',
         'DEFAULT_TEAROFF: { cost: 111, labor: 222 }', cfgAllow).length > 0);
  }
}

// 4d. cost-basis sweep
{
  ok('MUTANT killed: the estimate-builder CATALOG shape in a NEW file',
     scanCostBasis('pro/js/some-new-pricing.js', "  'shingle-good': { code: 'RFG', cost: 11.00, labor: 22.00 }").length > 0);
  ok('MUTANT killed: same shape with integer literals',
     scanCostBasis('pro/js/x.js', 'a: { cost: 11, labor: 22 }').length > 0);
  ok('MUTANT killed: the abbreviated mat/lab spelling (xactimate-catalog class)',
     scanCostBasis('pro/js/x.js', "{ code: 'RFG 240', mat: 13, lab: 37 }").length > 0);
  ok('MUTANT killed: the named materialCost/laborCost spelling (job-template class)',
     scanCostBasis('pro/js/x.js', '{"name":"Synthetic sealer line","materialCost":13,"laborCost":37}').length > 0);
  ok('MUTANT killed: named spelling, unquoted keys with decimals',
     scanCostBasis('pro/js/x.js', 'custom: { materialCost: 0.13, laborCost: 0.37 }').length > 0);
  ok('control: a resolved LINE carrying per-unit costs is a read, not a literal',
     scanCostBasis('pro/js/x.js', 'materialCostPerUnit: matCostPerUnit, laborCostPerUnit: labCostPerUnit').length === 0);

  // The FOURTH spelling (labor catalog class). The pairing is the whole
  // design: a dollar-per-unit beside a productivity metric is a cost basis; a
  // bare `rate:` is usually a percentage and sweeping it tree-wide would have
  // flagged sales tax and close rates in four unrelated files.
  ok('MUTANT killed: the labor-catalog rate/hoursPerUnit shape',
     scanCostBasis('pro/js/x.js', "'LAB TO1': L({ id:'LAB TO1', unit:'SQ', rate:65, hoursPerUnit:0.4 })").length > 0);
  ok('MUTANT killed: same shape with the keys quoted and reordered fields between them',
     scanCostBasis('pro/js/x.js', '{ "rate": 185, "unit": "SQ", "category": "tear-off", "hoursPerUnit": 1.2 }').length > 0);
  ok('control: a sales-tax RATE is not a cost basis (estimate-config.js class)',
     scanCostBasis('pro/js/x.js', "'hamilton-oh': { name: 'Hamilton County, OH', rate: 0.0725 }").length === 0);
  ok('control: a close RATE is not a cost basis (close-board.js class)',
     scanCostBasis('pro/js/x.js', 'summary: { won: 12, lost: 30, rate: 0.28 }').length === 0);
  ok('control: hoursPerUnit alone (scheduling data, no dollar beside it) is not swept',
     scanCostBasis('pro/js/x.js', '{ crewSize: 4, hoursPerUnit: 0.4 }').length === 0);
  ok('control: matte/label prose is not swept by the abbreviated pattern',
     scanCostBasis('pro/js/x.js', 'format: 1, label: 2').length === 0);

  ok('control: a cost with no paired labor is not swept (county permit fees are public)',
     scanCostBasis('pro/js/x.js', "'hamilton-oh': { name: 'Hamilton County, OH', cost: 185 }").length === 0);
  ok('control: property READS are not swept',
     scanCostBasis('pro/js/x.js', 'materialCost: Number(spec.cost), laborCost: Number(spec.labor)').length === 0);
}

// 4e. prose scan — the layer that the 4 leaking `notes` strings needed
{
  const mut = (notes) => [{ id: 'x', notes }];
  ok('MUTANT killed: a confirmed supplier price in notes (the real 2026-07-30 leak)',
     scanProse(mut('ABC #332 SKU 02TKTXT* per color; cost $41.33/bundle CONFIRMED via portal 2026-06-24.')).length > 0);
  ok('MUTANT killed: a bare dollar figure in notes',
     scanProse(mut('We buy these at $83.25 a bundle.')).length > 0);
  ok('MUTANT killed: a supplier branch account with no price',
     scanProse(mut('Order per-color SKU at ABC #332 (Team pricing).')).length > 0);
  ok('MUTANT killed: a price hidden in description rather than notes',
     scanProse([{ id: 'x', description: 'Premium shingle, our cost $110/sq.' }]).length > 0);

  ok('control: the customer PORTAL is not a supplier portal',
     scanProse(mut('Includes a photo report to the customer portal.')).length === 0);
  ok('control: ordinary product prose is not flagged',
     scanProse(mut('Required for the 160 mph wind warranty. 33.3 LF per bundle.')).length === 0);

  // The catalog/template sweep (2026-09-25): the real RFG NAIL-LUMA string, and
  // the benign template shape it must keep passing.
  ok('MUTANT killed: the real catalog desc leak ("Contractor cost $75/box")',
     scanProseStrings([['xact RFG NAIL-LUMA.desc', 'LumaNails premium ring-shank roofing nails. Contractor cost $75/box covers 10 SQ of installation.']]).length > 0);
  ok('control: a template note about deleting $0 lines is not flagged',
     scanProseStrings([['template x.scopeNotes', 'Dumpster trio is sq-gated (delete the $0 lines).']]).length === 0);
}

// 4f. per-SQ cost basis stays out of the published tree (2026-08-10).
// estimate-builder-v2.js shipped DEFAULT_COST_BASIS = {340, 385, 430} — the
// shop's REAL per-SQ costs beside the public tier rates (545/595/660), i.e.
// the margin was readable by anyone who fetched the file. Same class as the
// 187-SKU catalog leak this suite was built for, but it slipped the strict
// layer because EBv2 isn't a catalog file. The defaults are zeros now
// ("not configured" — the engine nulls the margin fields); real cost basis
// is tenant data entered in Estimate Settings. These pins stop the real
// numbers being reintroduced as published defaults.
{
  const ebv2 = fs.readFileSync(path.join(ROOT, 'docs/pro/js/estimate-builder-v2.js'), 'utf8');
  const m = ebv2.match(/DEFAULT_COST_BASIS\s*=\s*\{([\s\S]{0,200}?)\}/);
  ok('EBv2 has a DEFAULT_COST_BASIS object (pin target present)', !!m);
  const nums = m ? (m[1].match(/-?\d+(\.\d+)?/g) || []).map(Number) : [1];
  ok('EBv2 DEFAULT_COST_BASIS ships all-zero values (real cost basis is tenant data)',
     nums.length > 0 && nums.every((n) => n === 0));

  const boot = fs.readFileSync(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');
  // Five tiers since 2026-10-02: the form fill and the save each loop over the
  // tiers ('v2cost' + id), so there are 2 loop sites instead of 6 literal ones.
  // The old literal shape is still matched, so a hard-coded id cannot slip by.
  const literal = [...boot.matchAll(/v2cost(?:Economy|Good|Better|Best|Beyond)'\)?,?\s*(?:\.value\s*=\s*s\.costBasis\?\.\w+\s*\?\?\s*|)(\d+)/g)].map((x) => Number(x[1]));
  const fill = [...boot.matchAll(/'v2cost'\s*\+\s*id\)\.value\s*=\s*s\.costBasis\?\.\[t\]\s*\?\?\s*(\d+)/g)].map((x) => Number(x[1]));
  const save = [...boot.matchAll(/num\('v2cost'\s*\+\s*id,\s*(\d+)\)/g)].map((x) => Number(x[1]));
  const fallbacks = literal.concat(fill, save);
  ok('dashboard-bootstrap v2cost* fallbacks are all zero (form fill + save)',
     fill.length >= 1 && save.length >= 1 && fallbacks.every((n) => n === 0));
}

// 4g. THE ROTATION LEDGER. This one needs mutation testing more than any layer
// above it, because in normal operation every row is `rotation: null` and the
// drift machinery does nothing at all — a mechanism whose real behaviour first
// runs months from now, on a day nobody is watching, is a mechanism nobody has
// ever seen work. Driven here on synthetic rows AND on the real git history.
{
  // A well-formed record, in the shape import-cost-rotation.js prints.
  const GOOD = () => ({ rotation: {
    at: '2026-09-02T14:11:03.918Z', by: 'jo', company: 'nbd', coverage: 0.83, basisAt: '0d188325',
  } });
  const CLEAN = { added: [], removed: [], repriced: [] };
  const CTX = (drift) => ({ basisDate: '2026-08-19T05:05:31-04:00', drift: drift || CLEAN });

  // THE MECHANISM IS WIRED. LED.rotationFindings is pure, so everything below
  // this line would pass just as happily with section 2c deleted. This is the
  // assertion that says it was actually applied to the real rows.
  ok('the ledger is WIRED: section 2c evaluated every row against the real tree (' +
     (ledgerChecked.join(', ') || 'NOTHING') + ')',
     ledgerChecked.length === Object.keys(LEDGER).length &&
     Object.keys(LEDGER).every((id) => ledgerChecked.some((c) => c.split(':')[0] === id)) &&
     ledgerChecked.every((c) => Number(c.split(':')[1]) > 0));

  ok('control: rotation: null is a legal, permanent, honest state and never fails',
     LED.rotationFindings('xact', { rotation: null }, {}).length === 0);
  ok('control: a well-formed rotation record over undrifted figures is clean',
     LED.rotationFindings('xact', GOOD(), CTX()).length === 0);

  // ── THE EVENT THE PIN EXISTS FOR ────────────────────────────────────────
  // "update the catalog to current pricing" — the innocuous PR that
  // re-publishes the actuals and silently un-stales a rotated baseline. Under
  // the old counting assertion this was invisible: 276 pairs before, 276
  // after, green throughout.
  ok('MUTANT killed: a line item REPRICED while a rotation claim stands',
     LED.rotationFindings('xact', GOOD(), CTX({ added: [], removed: [], repriced: ['RFG 240'] })).length === 1);
  // …and the negative control that decides whether this mechanism survives its
  // third catalog PR. Measured over the entire history of all three catalogs:
  // 9 additions, 3 removals, ZERO repricings. A whole-multiset digest reds on
  // all twelve; this reds on none of them.
  ok('control: line items ADDED and REMOVED do NOT fire — measured, that is 100% of ' +
     'what has ever moved these catalogs',
     LED.rotationFindings('xact', GOOD(),
       CTX({ added: ['RFG 998', 'RFG 999'], removed: ['RFG 001'], repriced: [] })).length === 0);

  // ── THE PASTE-OVER, which is how a pinned-HASH design gets defeated ──────
  // With a stored digest, the cheapest response to a drift failure is to paste
  // the hex the failure just printed. There is no equivalent here: re-pointing
  // basisAt at the commit that CONTAINS the reprice makes the recorded date
  // precede its own basis.
  {
    const evade = GOOD();
    evade.rotation.basisAt = 'fef0f560';
    ok('MUTANT killed: basisAt re-pointed at a later commit to clear a reprice, without ' +
       'moving rotation.at (the hash-paste evasion, refused by arithmetic)',
       LED.rotationFindings('xact', evade,
         { basisDate: '2027-03-14T09:00:00-04:00', drift: CLEAN }).length === 1);
  }
  {
    const ghost = GOOD();
    ghost.rotation.basisAt = 'deadbee';
    ok('MUTANT killed: basisAt names a commit that is not in this repo',
       LED.rotationFindings('xact', ghost, { basisDate: null, drift: null }).length === 1);
  }
  ok('MUTANT killed: the figures at basisAt cannot be read, so the claim is unverifiable ' +
     '(a shallow checkout — add fetch-depth: 0 to the job in .github/workflows/ci.yml)',
     LED.rotationFindings('xact', GOOD(), { basisDate: '2026-08-19T05:05:31-04:00', drift: null }).length === 1);

  // ── A CLAIM IS A PERSON, A TENANT, A DATE AND A NUMBER ──────────────────
  ok('MUTANT killed: rotation: true — a claim nobody signed',
     LED.rotationFindings('xact', { rotation: true }, {}).length === 1);
  { const m = GOOD(); delete m.rotation.by;
    ok('MUTANT killed: an unsigned rotation', LED.rotationFindings('xact', m, CTX()).length === 1); }
  { const m = GOOD(); delete m.rotation.company;
    ok('MUTANT killed: a rotation with no tenant — catalogCosts/{companyId} is PER COMPANY, ' +
       'and every other tenant keeps the published baseline as their live pricing',
       LED.rotationFindings('xact', m, CTX()).length === 1); }
  { const m = GOOD(); m.rotation.coverage = 0.11;
    ok('MUTANT killed: coverage below the 50% floor cost-rotation.js itself refuses at',
       LED.rotationFindings('xact', m, CTX()).length === 1); }
  { const m = GOOD(); m.rotation.coverage = 'lots';
    ok('MUTANT killed: coverage that is not a fraction', LED.rotationFindings('xact', m, CTX()).length === 1); }
  { const m = GOOD(); m.rotation.at = 'last Tuesday';
    ok('MUTANT killed: rotation.at is prose rather than seed.rotatedAt',
       LED.rotationFindings('xact', m, CTX()).length === 1); }
  { const m = GOOD(); m.rotation.basisAt = 'HEAD';
    ok('MUTANT killed: basisAt is a moving ref rather than a commit sha — a pin that moves ' +
       'with the branch pins nothing',
       LED.rotationFindings('xact', m, CTX()).length === 1); }

  // ── THE DRIFT DETECTOR, ON REAL HISTORY ─────────────────────────────────
  // Everything above runs on hand-built drift objects. These two run
  // LED.comparePublished over real commits of the real catalogs, because the
  // published-FIELD derivation is the piece that is easy to get wrong and
  // impossible to see wrong.
  {
    const laborCat = REG.CATALOGS.labor;
    const before = LED.publishedFigures(laborCat, '225c0d8c');   // pre-productivity-migration
    const now = LED.publishedFigures(laborCat, 'worktree');
    ok('the drift detector can read real history (labor catalog at 225c0d8c: ' +
       (before ? Object.keys(before).length : 0) + ' entries)',
       !!before && Object.keys(before).length > 0 && !!now);
    const d = before && now ? LED.comparePublished(before, now) : null;
    // 4ab95fa6 removed hoursPerUnit/crewSize/ratePerManHour — 198 values. If
    // the pin used the registry's raw `fields` it would call that 66
    // repricings and red on a MIGRATION. It pins `fields` minus `unpublished`,
    // so a field leaving the tree is correctly a no-op.
    ok('control: the crew-productivity MIGRATION is not a repricing (published fields are ' +
       'derived as `fields` minus `unpublished`, so a field leaving cannot fire this)',
       !!d && d.repriced.length === 0 && d.added.length === 0 && d.removed.length === 0);

    // And a synthetic reprice of one real key, to prove the comparison bites.
    const mutated = JSON.parse(JSON.stringify(now));
    const k = Object.keys(mutated)[0];
    const f = Object.keys(mutated[k])[0];
    mutated[k][f] = mutated[k][f] + 1;
    ok('MUTANT killed: one real labor rate moved by $1 → reported as repriced (' + k + ')',
       LED.comparePublished(now, mutated).repriced.length === 1);
  }
  {
    // The three real xact composition changes, replayed. Each is a legitimate
    // catalog edit — a TAMKO preset, two warranty-accuracy corrections — and
    // each is exactly the false positive that would get this loosened.
    const xactCat = REG.CATALOGS.xact;
    const then = LED.publishedFigures(xactCat, '99288405');
    const now = LED.publishedFigures(xactCat, 'worktree');
    const d = (then && now) ? LED.comparePublished(then, now) : null;
    ok('control: the real TAMKO-preset + warranty-accuracy history (+' +
       (d ? d.added.length : '?') + ' / -' + (d ? d.removed.length : '?') +
       ' line items) is composition, not repricing, and does NOT fire',
       !!d && (d.added.length + d.removed.length) > 0 && d.repriced.length === 0);
  }

  // The ledger publishes no figure, ever. Layer 2b enforces this tree-wide, but
  // this file is the one most likely to be tempted, so it is said here too.
  ok('the ledger file itself quotes no real cost pair',
     scanRealPairs('tests/cost-basis-ledger.js',
       fs.readFileSync(path.join(__dirname, 'cost-basis-ledger.js'), 'utf8')).length === 0 &&
     scanCostBasis('tests/cost-basis-ledger.js',
       fs.readFileSync(path.join(__dirname, 'cost-basis-ledger.js'), 'utf8')).length === 0);
}

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
