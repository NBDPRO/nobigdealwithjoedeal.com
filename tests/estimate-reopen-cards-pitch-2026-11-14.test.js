#!/usr/bin/env node
/*
 * estimate-reopen-cards-pitch-2026-11-14.test.js — a reopened per-SQ quote
 * shows the tier prices it was SAVED with, and a blank pitch is saved as the
 * pitch the price used.
 * ═════════════════════════════════════════════════
 *
 * THE BUGS THIS PINS (code review 2026-11-14, findings 11 and 12).
 *
 * 11. On a clean reopen effectiveEstimate() replays the saved doc, which has
 *     prices{} but no perSqTiers, so finalize('retail-quote') rebuilt the tier
 *     cards LIVE (calculateAllTiers(buildPerSqInput())) — without the
 *     pass-through fees the saved total includes, and on today's settings. The
 *     "Your Investment" headline said one number, the selected card another.
 *     Fix: a replayed per-SQ doc's cards come from its saved prices{}.
 * 12. A blank pitch (state.measurements.pitch 0 — updateMeasurement stores
 *     Number('') || 0) is PRICED at 6/12 by buildPerSqInput but was SAVED as
 *     "8/12" (`pitch || 8`). The reopen parses it back to 8, and the first
 *     edit adds the 8/12+ steep adder to a roof that was never priced steep.
 *     Fix: save `pitch || 6`, the default the price used.
 *
 * Drives the REAL estimate-v2-ui.js on the real engines (the stack of
 * tests/estimate-pricing-paths-2026-10-05.test.js section H). Expected dollars
 * come from that suite's worked example, not from the code under test:
 *   per-SQ cash, 100 sf at 6/12 (waste 1.15 → 1.15 SQ), blank county, Better:
 *   1.15 × $660 = $759 + $850 add-ons = $1,609 → +7% → $1,721.63 → $1,725.
 *   A $500 preset floor keeps it at $1,725 (above the floor).
 *
 * Run: node tests/estimate-reopen-cards-pitch-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '  — ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }
const j = (v) => JSON.stringify(v);

// Same fake window/document/localStorage as estimate-pricing-paths-2026-10-05.
function makeSandbox() {
  const byId = {};
  function el(tag) {
    const classes = new Set();
    return {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null, checked: false,
      classList: {
        add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); },
        toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, setSelectionRange() {}, remove() {},
    };
  }
  const document = {
    head: el('head'), body: el('body'), createElement: el,
    getElementById(id) { return byId[id] || null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  };
  const win = { localStorage, document };
  win.window = win;
  const sandbox = {
    window: win, document, localStorage, navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' },
  };
  vm.createContext(sandbox);
  return { win, sandbox };
}

const FILES = [
  'docs/pro/js/estimate-config.js',
  'docs/pro/js/ky-insurance-law.js',
  'docs/pro/js/deposit-rule.js',
  'docs/pro/js/product-data.js',
  'docs/pro/js/roofivent-catalog.js',
  'docs/pro/js/estimate-labor-catalog.js',
  'docs/pro/js/estimate-builder-v2.js',
  'docs/pro/js/estimate-catalog-xactimate.js',
  'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/customer-estimate-rows.js',
  'docs/pro/js/estimate-finalization.js',
  'docs/pro/js/estimate-v2-ui.js',
];

function boot() {
  const env = makeSandbox();
  FILES.forEach((f) => vm.runInContext(read(f), env.sandbox, { filename: path.basename(f) }));
  const W = env.win;
  // updateMeasurement / applyImportedMeasurements name EstimateBuilderV2 as a
  // bare global (a browser's window IS the global; this vm's is not).
  env.sandbox.EstimateBuilderV2 = W.EstimateBuilderV2;
  // finalize() tries the server PDF first; make that fail fast (as it does
  // offline) so it falls through to the client formatter, whose meta we keep.
  W._functions = {};
  W._httpsCallable = () => async () => ({ data: { ok: false } });
  W.EstimateFinalization.openInNewWindow = () => ({});
  return { W, T: W.EstimateV2UI && W.EstimateV2UI._test, UI: W.EstimateV2UI };
}

// A fresh per-SQ cash estimate (section H's fixture), priced and saved.
function buildAndSave(T, id, edit) {
  const st = T.getState();
  st._reopenedClean = false; st._reopenedDoc = null;
  st.mode = 'per-sq'; st.jobMode = 'cash'; st.tier = 'better'; st.county = '';
  st.measurements = Object.assign({}, st.measurements, { rawSqft: 100, pitch: 6, waste: 1.15, cutUpRoof: false });
  st.scope = [{ code: 'LAB MOB', overrides: {} }]; st.passThru = []; st.upgrades = []; st.photos = [];
  st.minJobCharge = 500;
  if (edit) edit(st);
  const est = T.effectiveEstimate();
  return { est, doc: JSON.parse(JSON.stringify(Object.assign({ id }, T.buildSavePayload(est, st)))) };
}

function reopen(T, W, doc) {
  W._estimates = [doc];
  T.rehydrateFromSaved(doc.id);
  // This branch predates the minJobCharge persistence fix (PR A): carry the
  // doc's $500 floor by hand so only THIS file's findings are under test.
  T.getState().minJobCharge = 500;
  return T.getState();
}

(async () => {
  console.log('\nREOPEN — saved tier cards, and a blank pitch saved as priced\n');

  // ══════════════════════════════════════════════════════════════════
  section('A. Finding 11 — a reopened per-SQ quote\'s tier cards are its saved prices');
  // ══════════════════════════════════════════════════════════════════
  {
    const { W, T, UI } = boot();
    ok('estimate-v2-ui.js loaded on the engine stack', !!(T && UI && typeof UI.finalize === 'function'));
    // $1,725 job + a $75 aerial-report fee = $1,800 on the Better card.
    const { est, doc } = buildAndSave(T, 'est_cards', (st) => {
      st.passThru = [{ code: 'SVC AERIAL', desc: 'Aerial measurement report', amount: 75, source: 'passthru' }];
    });
    ok('control: saved per-SQ Better total $1,800 ($1,725 + $75 fee), prices{} saved for every tier',
      est.priceMode === 'per-sq' && est.total === 1800 && doc.grandTotal === 1800 && doc.prices && doc.prices.better === 1800,
      j([est.priceMode, est.total, doc.prices]));

    reopen(T, W, doc);
    let meta = null;
    W.EstimateFinalization.formatEstimate = (e, fmt, m) => { meta = m; return { html: '<p>quote</p>' }; };
    await UI.finalize('retail-quote');
    const tiers = meta && meta.tiers;
    ok('finalize handed the formatter tier cards', !!tiers, j(meta && Object.keys(meta)));
    const saved = doc.prices || {};
    const keys = Object.keys(saved).filter((k) => saved[k] != null);
    const cardTotals = {};
    keys.forEach((k) => { cardTotals[k] = tiers && tiers[k] ? tiers[k].total : null; });
    ok('every tier card shows the SAVED price (was: rebuilt live without the $75 fee, Better $1,725 under a $1,800 headline)',
      !!tiers && keys.length >= 3 && keys.every((k) => cardTotals[k] === saved[k]), j({ cards: cardTotals, saved }));
    ok('the selected card is still the rep\'s tier', !!tiers && tiers.recommended === 'better', j(tiers && tiers.recommended));
  }

  // ══════════════════════════════════════════════════════════════════
  section('B. Finding 12 — a blank pitch is saved as the 6/12 it was priced at');
  // ══════════════════════════════════════════════════════════════════
  {
    const { W, T } = boot();
    // updateMeasurement('pitch', '') stores Number('') || 0 = 0.
    const { est, doc } = buildAndSave(T, 'est_pitch', (st) => { st.measurements.pitch = 0; });
    ok('control: a blank pitch prices exactly like 6/12 — $1,725, no steep adder',
      est.priceMode === 'per-sq' && est.total === 1725 && est.perSqTiers.better.addOns.steep === 0,
      j([est.total, est.perSqTiers && est.perSqTiers.better && est.perSqTiers.better.addOns]));
    ok('the saved pitch label is "6/12", the pitch the price used (was "8/12")', doc.pl === '6/12', j(doc.pl));

    reopen(T, W, doc);
    const st = T.getState();
    st._reopenedClean = false;   // any real edit — e.g. the rep taps a tier
    const after = T.effectiveEstimate();
    ok('after reopen + one edit the quote is still $1,725 with no steep adder (was $1,775: reopened at 8/12, the steep adder added $29.25)',
      after && after.total === 1725 && after.perSqTiers.better.addOns.steep === 0,
      j(after && [after.total, after.perSqTiers && after.perSqTiers.better && after.perSqTiers.better.addOns.steep]));
  }
  {
    // A typed pitch still round-trips as typed.
    const { T } = boot();
    const { doc } = buildAndSave(T, 'est_pitch9', (st) => { st.measurements.pitch = 9; });
    ok('a typed 9/12 still saves as "9/12"', doc.pl === '9/12', j(doc.pl));
  }

  // ══════════════════════════════════════════════════════════════════
  section('C. Review follow-up 3 — one blank-pitch default for the waste factor too');
  // ══════════════════════════════════════════════════════════════════
  {
    const { W, T, UI } = boot();
    const EB = W.EstimateBuilderV2;
    const w6 = EB.wasteFactorForPitch(6 / 12), w8 = EB.wasteFactorForPitch(8 / 12);
    ok('control: the waste factor differs between 6/12 and 8/12 (' + w6 + ' vs ' + w8 + ')', w6 !== w8, j([w6, w8]));
    buildAndSave(T, 'est_w');
    UI.updateMeasurement('pitch', '');   // the rep clears the pitch box
    const st = T.getState();
    ok('a cleared pitch box stores 0', st.measurements.pitch === 0, j(st.measurements.pitch));
    ok('…and derives waste at 6/12, the pitch it is priced and saved at (was 8/12)', st.measurements.waste === w6, j([st.measurements.waste, w6, w8]));
    st.measurements.waste = 1.0;
    UI.applyImportedMeasurements({ rawSqft: 1200, pitch: 0 });
    ok('a drawing import with no pitch also derives waste at 6/12 (was 8/12)', st.measurements.waste === w6, j([st.measurements.waste, w6, w8]));
  }

  // ══════════════════════════════════════════════════════════════════
  section('D. Review follow-up 4 — saved prices of null or $0 never become cards');
  // ══════════════════════════════════════════════════════════════════
  {
    const { W, T, UI } = boot();
    const { doc } = buildAndSave(T, 'est_nullprices');
    doc.prices = { economy: null, good: null, better: null, best: null, beyond: null };
    reopen(T, W, doc);
    let meta = null;
    W.EstimateFinalization.formatEstimate = (e, fmt, m) => { meta = m; return { html: '<p>quote</p>' }; };
    await UI.finalize('retail-quote');
    const tiers = (meta && meta.tiers) || {};
    const priced = ['economy', 'good', 'better', 'best', 'beyond'].filter((k) => tiers[k] && Number(tiers[k].total) > 0);
    ok('a saved prices{} of all nulls does not blank the comparison — the cards fall back to the per-SQ engine (was: no cards at all)',
      priced.length === 5, j(Object.keys(tiers)));
  }
  {
    const { W, T, UI } = boot();
    const { doc } = buildAndSave(T, 'est_zeroprice');
    doc.prices = Object.assign({}, doc.prices, { economy: 0 });
    reopen(T, W, doc);
    let meta = null;
    W.EstimateFinalization.formatEstimate = (e, fmt, m) => { meta = m; return { html: '<p>quote</p>' }; };
    await UI.finalize('retail-quote');
    const tiers = (meta && meta.tiers) || {};
    ok('a saved $0 tier price prints no $0 card (was: an Economy card for $0)', !tiers.economy, j(tiers.economy));
    ok('…while the other saved prices still show', !!tiers.better && tiers.better.total === doc.prices.better, j(tiers.better));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.log('FATAL: ' + (e && e.stack || e)); process.exit(1); });
