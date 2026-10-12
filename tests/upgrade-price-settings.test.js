/**
 * tests/upgrade-price-settings.test.js
 *
 * Settings → Estimates → "Upgrade prices" (Upgrades & Add-ons stage 2, lane
 * "prices", 2026-09-25): docs/pro/js/upgrade-price-settings.js
 * (window.NBDUpgradePriceSettings) and the stored-shape half of
 * docs/pro/js/upgrade-pricing.js (sanitizeOverrides + the omitted-argument
 * default). Design: documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md.
 *
 * The chain under test is the one a real owner drives:
 *   typed dollars → parseDollars → whole cents → buildSaveMap (the object
 *   _saveCompanyProfile writes to companyProfile.pricing.upgradePrices)
 *   → NBDUpgrades.sanitizeOverrides → offeredFor / price → a saved row the
 *   three REAL readers print.
 * Everything runs against the real files in one vm context booted in the
 * browser's load order; every money claim is an executed number, never a
 * string-shape match.
 *
 * Sections:
 *   1. PARSE      dollars → cents: exact on the digits, no float drift over
 *                 every cent up to the ceiling, and each refusal named
 *   2. STATUS     the row sentence per state (default / your price / Set a
 *                 price / Off keeps the price / invalid)
 *   3. SAVE MAP   one entry per library item, installer name only where it
 *                 prints, nothing saved when any price is bad
 *   3b. CHANGES   a save writes only the rows edited on this device, so a
 *                 device painted hours ago can't revert another's save
 *   4. ROUND-TRIP saved map → sanitizeOverrides → offeredFor / price → the
 *                 readers: the typed price is the printed price, to the cent
 *   5. DEFAULT    an omitted tenantOverrides reads the saved Settings;
 *                 null / {} prices from the library alone
 *   6. RE-READ    savedEntries shows only what the builder would use
 *   7. WHO EDITS  canEdit mirrors the firestore.rules companyProfile gate
 *
 * Run: node tests/upgrade-price-settings.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs', 'pro', 'js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || 'value') + ' = ' + JSON.stringify(actual) + ' (expected ' + JSON.stringify(expected) + ')');
  }
}
function truthy(cond, label) { if (!cond) throw new Error(label || 'expected truthy'); }

// ── Boot the real browser stack ─────────────────────────────────────────
function boot() {
  const win = {};
  win.window = win;
  const store = {};
  const ls = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => { delete store[k]; }); },
  };
  win.localStorage = ls;
  // Event listeners the modules register on window, so a test can announce a
  // company-profile landing ('nbd:company-profile-loaded').
  win.__listeners = {};
  win.addEventListener = (t, f) => { (win.__listeners[t] = win.__listeners[t] || []).push(f); };
  const sb = {
    window: win, localStorage: ls,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: {
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} }),
      addEventListener() {}, removeEventListener() {},
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    },
    navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  };
  // The same document object the modules see, so a test can stand in a
  // painted panel for collect().
  win.document = sb.document;
  vm.createContext(sb);
  [
    'estimate-config.js', 'product-data.js', 'roofivent-catalog.js', 'estimate-labor-catalog.js',
    'estimate-builder-v2.js', 'estimate-catalog-xactimate.js', 'estimate-logic-engine.js',
    'job-templates-data.js', 'job-templates.js',
    'customer-estimate-rows.js', 'invoice-pipeline.js',
    'upgrade-library.js', 'upgrade-pricing.js', 'upgrade-price-settings.js',
  ].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(PRO_JS, f), 'utf8'), sb, { filename: f });
  });
  return win;
}

const win = boot();
const S = win.NBDUpgradePriceSettings;
const U = win.NBDUpgrades;
const LIB = win.NBD_UPGRADE_LIBRARY;
const JT = win.JobTemplates;
const CR = win.NBDCustomerEstimateRows;
const IP = win.InvoicePipeline;
const byId = {};
LIB.items.forEach((it) => { byId[it.id] = it; });

const K5 = 'jt_gi_k5_seamless_full';
const k5 = JT.resolveSelection([{ templateId: K5, itemChoices: { 1: { qty: 137 } } }], { tier: 'better', jobMode: 'cash', county: '' });
function ctxFor(extra) {
  return Object.assign({ templateIds: [K5], lines: k5.lines, measurements: k5.measurements, taxRate: 0.07 }, extra || {});
}
function offerMap(list) { const m = {}; list.forEach((o) => { m[o.id] = o; }); return m; }
function codes(errors) { return errors.map((e) => e.code); }
// A Settings form with every row left exactly as it loads (blank, On).
function blankForms() { const f = {}; LIB.items.forEach((it) => { f[it.id] = { priceText: '', enabled: true, installerName: '' }; }); return f; }

console.log('\nupgrade-price-settings — boot');
console.log('──────────────────────────────────────────────────');
test('real stack booted: the settings module, the pricing core and the library', () => {
  truthy(S && typeof S.parseDollars === 'function' && typeof S.buildSaveMap === 'function', 'NBDUpgradePriceSettings missing');
  truthy(U && typeof U.sanitizeOverrides === 'function', 'NBDUpgrades missing');
  truthy(Object.isFrozen(S), 'module API is frozen');
  eq(U.MAX_UNIT_CENTS, 100000, 'the per-unit ceiling the parser shares with the core');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. parse — typed dollars to whole cents');
console.log('──────────────────────────────────────────────────');

test('blank is "no price saved" (the library price stands), never zero', () => {
  ['', '   ', null, undefined].forEach((v) => {
    const r = S.parseDollars(v, 'LF');
    eq(r.cents, null, JSON.stringify(v) + ' cents'); eq(r.error, null, JSON.stringify(v) + ' error');
  });
});

test('the ways a rep types a price all land on the same exact cents', () => {
  const cases = {
    '12': 1200, '12.': 1200, '12.5': 1250, '12.50': 1250, '$12.50': 1250, '$ 12.50': 1250, ' 12.50 ': 1250,
    '.5': 50, '0.5': 50, '0.29': 29, '19.99': 1999, '0012.30': 1230, '1,000': 100000, '1,000.00': 100000,
    '999.99': 99999, '1000': 100000, '0.01': 1, '6': 600, '9.75': 975,
  };
  Object.keys(cases).forEach((t) => {
    const r = S.parseDollars(t, 'LF');
    eq(r.error, null, JSON.stringify(t) + ' error'); eq(r.cents, cases[t], JSON.stringify(t) + ' cents');
  });
});

test('parsing is on the digits: every cent from $0.01 to $1,000.00 round-trips exactly', () => {
  // The float trap this avoids: Math.floor(parseFloat("0.29") * 100) is 28.
  eq(Math.floor(parseFloat('0.29') * 100), 28, 'the trap is real');
  for (let c = 1; c <= U.MAX_UNIT_CENTS; c++) {
    const t = S.centsToInput(c);
    const r = S.parseDollars(t, 'LF');
    if (r.cents !== c) throw new Error(t + ' parsed to ' + r.cents + ' (expected ' + c + ')');
  }
});

test('each refusal is named, and none of them saves a number', () => {
  const cases = {
    '12.345': /two decimals/, '6,50': /dot for cents/, '1,00': /dot for cents/, '12,5': /dot for cents/,
    '-5': /negative/, '0': /above \$0\.00/, '0.00': /above \$0\.00/, '$0': /above \$0\.00/,
    'abc': /dollars and cents/, '.': /dollars and cents/, '$': /dollars and cents/, '1e3': /dollars and cents/,
    '12.5.5': /dollars and cents/, 'Infinity': /dollars and cents/, 'NaN': /dollars and cents/, '12 $': /dollars and cents/,
    // A space inside the number is refused, never dropped: dropping it saved
    // "6 50" as $650.00 a foot (2026-09-25 review of PR #1762).
    '6 50': /Take out the space/, '1 5': /Take out the space/, '1 000': /Take out the space/,
    '12 .50': /Take out the space/, '12. 50': /Take out the space/, '$6 50': /Take out the space/,
    '1, 000': /Take out the space/, '6 50': /Take out the space/, '6\t50': /Take out the space/,
    '1000.01': /Over \$1,000\.00 per foot/, '1,000.01': /Over \$1,000\.00 per foot/,
    '99999999999999999999': /Over \$1,000\.00 per foot/,
  };
  Object.keys(cases).forEach((t) => {
    const r = S.parseDollars(t, 'LF');
    eq(r.cents, null, JSON.stringify(t) + ' cents');
    truthy(r.error && cases[t].test(r.error), JSON.stringify(t) + ' error "' + r.error + '" should match ' + cases[t]);
  });
  truthy(/Over \$1,000\.00 each/.test(S.parseDollars('1500', 'EA').error), 'counted items say "each"');
});

test('a space inside a price never inflates it: "6 50" is refused, not $650.00', () => {
  const r = S.parseDollars('6 50', 'LF');
  eq(r.cents, null, 'cents'); truthy(/dot for cents, like 12\.50/.test(r.error), r.error);
  // The ends, and the gap after a leading "$", are still forgiven.
  eq(S.parseDollars(' $ 6.50 ', 'LF').cents, 650, 'outer and after-$ spaces');
});

test('no refusal says "free", and no accepted price can be $0', () => {
  ['0', '0.00', '$0', '0.001'].forEach((t) => {
    const r = S.parseDollars(t, 'LF');
    eq(r.cents, null, t);
    truthy(!/free/i.test(r.error || ''), t + ' error says free');
  });
});

test('money() and centsToInput() format whole cents exactly', () => {
  eq(S.money(246600), '$2,466.00', 'money'); eq(S.money(1), '$0.01', 'one cent'); eq(S.money(100000), '$1,000.00', 'ceiling');
  eq(S.centsToInput(1250), '12.50', 'input'); eq(S.centsToInput(5), '0.05', 'five cents');
  eq(S.centsToInput(null), '', 'none'); eq(S.centsToInput(0), '', 'zero shows blank'); eq(S.centsToInput(12.5), '', 'fraction shows blank');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n2. status — what each row tells the owner');
console.log('──────────────────────────────────────────────────');

test('an approved item left blank is offered at the default price', () => {
  const d = S.describe(byId.alurex, { priceText: '', enabled: true });
  eq(d.state, 'offered', 'state'); eq(d.unitCents, 1800, 'unitCents'); eq(d.source, 'default', 'source');
  eq(d.text, 'Offered at $18.00 per foot (the default price).', 'text');
});

test('a needs_price item left blank is "needs_price" and says it is not offered', () => {
  // The row's visible "Set a price" badge keys off this state (render()).
  const d = S.describe(byId.underground_drain, { priceText: '', enabled: true });
  eq(d.state, 'needs_price', 'state'); eq(d.unitCents, null, 'unitCents');
  eq(d.text, 'Not offered: reps can\'t add it until it has a price.', 'text');
});

test('a typed price wins over the default and names itself', () => {
  const d = S.describe(byId.amerimax_lockin_mesh, { priceText: '7.25', enabled: true });
  eq(d.state, 'offered', 'state'); eq(d.unitCents, 725, 'unitCents'); eq(d.source, 'company', 'source');
  eq(d.text, 'Offered at $7.25 per foot (your price).', 'text');
  eq(S.describe(byId.popup_emitter, { priceText: '45', enabled: true }).text, 'Offered at $45.00 each (your price).', 'EA wording');
});

test('Off keeps the price and says so; Off with no price says only Off', () => {
  const d = S.describe(byId.fascia_wrap, { priceText: '9.75', enabled: false });
  eq(d.state, 'off', 'state'); eq(d.unitCents, 975, 'kept');
  eq(d.text, 'Off. Reps never see it (the price is kept: $9.75 per foot).', 'text');
  eq(S.describe(byId.fascia_wrap, { priceText: '', enabled: false }).text, 'Off. Reps never see it.', 'unpriced off');
});

test('a bad price is "invalid" with the parser\'s own message', () => {
  const d = S.describe(byId.alurex, { priceText: '6,50', enabled: true });
  eq(d.state, 'invalid', 'state'); eq(d.unitCents, null, 'no price'); truthy(/dot for cents/.test(d.text), d.text);
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n3. save map — what Save writes to companyProfile.pricing.upgradePrices');
console.log('──────────────────────────────────────────────────');

test('an untouched form saves every library item as "no price, On"', () => {
  const r = S.buildSaveMap(blankForms());
  eq(r.errors.length, 0, 'errors');
  eq(Object.keys(r.map).sort().join(), LIB.items.map((it) => it.id).sort().join(), 'one entry per item');
  LIB.items.forEach((it) => { eq(r.map[it.id].cents, null, it.id + ' cents'); eq(r.map[it.id].enabled, true, it.id + ' enabled'); });
});

test('prices save as whole cents, Off saves enabled:false and keeps the cents', () => {
  const f = blankForms();
  f.fascia_wrap.priceText = '9.75';
  f.flip_up_extension = { priceText: '$38', enabled: false, installerName: '' };
  const r = S.buildSaveMap(f);
  eq(JSON.stringify(r.map.fascia_wrap), '{"cents":975,"enabled":true}', 'fascia');
  eq(JSON.stringify(r.map.flip_up_extension), '{"cents":3800,"enabled":false}', 'flip-up off, price kept');
  truthy(Object.values(r.map).every((e) => e.cents === null || Number.isInteger(e.cents)), 'integer cents only');
});

test('installer name is saved only on the certified-sub item, cleaned and capped', () => {
  const f = blankForms();
  f.alurex.installerName = '  Acme \n\t Gutter   Co ';
  f.amerimax_lockin_mesh.installerName = 'Should Not Save';
  const r = S.buildSaveMap(f);
  eq(r.map.alurex.installerName, 'Acme Gutter Co', 'cleaned');
  eq('installerName' in r.map.amerimax_lockin_mesh, false, 'company-installed item carries no installer');
  const items = LIB.items.filter((it) => 'installerName' in r.map[it.id]).map((it) => it.id);
  eq(items.join(), LIB.items.filter((it) => it.installer === 'certified_sub').map((it) => it.id).join(), 'certified_sub only');
  f.alurex.installerName = 'x'.repeat(300);
  eq(S.buildSaveMap(f).map.alurex.installerName.length, 80, 'capped at 80');
  f.alurex.installerName = '';
  eq(S.buildSaveMap(f).map.alurex.installerName, '', 'blank stays blank (prints the neutral sentence)');
});

test('one bad price anywhere → nothing to save, and the error names the row', () => {
  const f = blankForms();
  f.fascia_wrap.priceText = '9.75';
  f.gutter_apron.priceText = '4.555';
  const r = S.buildSaveMap(f);
  eq(r.map, null, 'map'); eq(r.errors.length, 1, 'errors'); eq(r.errors[0].id, 'gutter_apron', 'row');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n3b. changes only — a save never reverts another device');
console.log('──────────────────────────────────────────────────');

// The form a device shows after painting `entries` (render() fills each row
// from savedEntries exactly like this).
function formsFrom(entries) {
  const f = {};
  LIB.items.forEach((it) => {
    const e = entries[it.id];
    f[it.id] = { priceText: S.centsToInput(e.cents), enabled: e.enabled, installerName: e.installerName };
  });
  return f;
}
// Firestore's setDoc({ merge: true }) on nested maps: object values merge
// key by key, anything else replaces.
function mergeWrite(doc, patch) {
  const out = Object.assign({}, doc);
  Object.keys(patch).forEach((k) => {
    const v = patch[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object')
      ? mergeWrite(out[k], v) : v;
  });
  return out;
}

test('an untouched panel has no changes, whatever the server holds', () => {
  const saved = savedFrom({ fascia_wrap: { priceText: '9.75' }, flip_up_extension: { priceText: '38', enabled: false }, alurex: { installerName: 'Acme Gutter Co' } });
  const painted = S.savedEntries({ pricing: { upgradePrices: saved } });
  const r = S.buildSaveMap(formsFrom(painted));
  eq(r.errors.length, 0, 'errors');
  eq(JSON.stringify(S.changedEntries(r.map, painted)), '{}', 'painted from saved, nothing typed');
  const blank = S.savedEntries(null);
  eq(JSON.stringify(S.changedEntries(S.buildSaveMap(formsFrom(blank)).map, blank)), '{}', 'a company that never saved');
});

test('the 9:00 desktop can\'t revert the 10:00 phone save (the review scenario)', () => {
  // 9:00 — the desktop paints from a company that has priced nothing yet.
  let server = { pricing: { addonPrices: { guttersLf: 8.5 } } };
  const desktopPainted = S.savedEntries(server);
  const desktopForm = formsFrom(desktopPainted);
  // 10:00 — the phone prices the fascia wrap and raises Alu-Rex.
  const phonePainted = S.savedEntries(server);
  const phoneForm = formsFrom(phonePainted);
  phoneForm.fascia_wrap.priceText = '9.75';
  phoneForm.alurex.priceText = '19.00';
  const phoneChanges = S.changedEntries(S.buildSaveMap(phoneForm).map, phonePainted);
  eq(Object.keys(phoneChanges).sort().join(), 'alurex,fascia_wrap', 'the phone sends only its two edits');
  server = mergeWrite(server, { pricing: { upgradePrices: phoneChanges } });
  // 11:00 — the desktop presses Save All to change a county rate: the
  // upgrade panel is untouched, so NOTHING of it rides that write.
  const untouched = S.changedEntries(S.buildSaveMap(desktopForm).map, desktopPainted);
  eq(JSON.stringify(untouched), '{}', 'Save All from the stale desktop carries no upgrade prices');
  // …and when the desktop DOES edit one row, only that row is sent.
  desktopForm.gutter_apron.priceText = '4.50';
  const desktopChanges = S.changedEntries(S.buildSaveMap(desktopForm).map, desktopPainted);
  eq(JSON.stringify(desktopChanges), '{"gutter_apron":{"cents":450,"enabled":true}}', 'one edit, one entry');
  server = mergeWrite(server, { pricing: { upgradePrices: desktopChanges } });
  // The phone's prices survive both desktop saves, and the builder quotes them.
  const ov = U.sanitizeOverrides(server.pricing.upgradePrices);
  eq(ov.prices.fascia_wrap, 975, 'fascia kept'); eq(ov.prices.alurex, 1900, 'Alu-Rex kept (not back to the $18 default)');
  eq(ov.prices.gutter_apron, 450, 'the desktop edit landed');
  eq(server.pricing.addonPrices.guttersLf, 8.5, 'the rest of pricing untouched');
  eq(U.price(['alurex'], ctxFor(), server.pricing.upgradePrices).upgradeCents, 137 * 1900, 'the builder quotes the phone\'s Alu-Rex price');
});

test('what counts as a change: price, Off, and the certified installer name — nothing else', () => {
  const painted = S.savedEntries({ pricing: { upgradePrices: savedFrom({ fascia_wrap: { priceText: '9.75' }, alurex: { installerName: 'Acme Gutter Co' } }) } });
  const edit = (fn) => { const f = formsFrom(painted); fn(f); return S.changedEntries(S.buildSaveMap(f).map, painted); };
  eq(Object.keys(edit((f) => { f.fascia_wrap.priceText = '9.76'; })).join(), 'fascia_wrap', 'a price');
  eq(Object.keys(edit((f) => { f.fascia_wrap.priceText = ''; })).join(), 'fascia_wrap', 'clearing a price');
  eq(JSON.stringify(edit((f) => { f.fascia_wrap.priceText = '$ 9.75'; })), '{}', 'the same price typed another way');
  eq(JSON.stringify(edit((f) => { f.popup_emitter.enabled = false; })), '{"popup_emitter":{"cents":null,"enabled":false}}', 'Off');
  eq(JSON.stringify(edit((f) => { f.alurex.installerName = 'Acme Gutters LLC'; })), '{"alurex":{"cents":null,"enabled":true,"installerName":"Acme Gutters LLC"}}', 'the installer, sent as the whole entry');
  eq(JSON.stringify(edit((f) => { f.alurex.installerName = '  Acme   Gutter Co '; })), '{}', 'the same name with stray spaces');
  eq(JSON.stringify(edit((f) => { f.amerimax_lockin_mesh.installerName = 'Nope'; })), '{}', 'a name on a company-installed item prints nowhere, so it is no change');
  // No paint to compare against (never happens after render) → everything
  // counts as changed rather than being silently skipped.
  eq(Object.keys(S.changedEntries(S.buildSaveMap(formsFrom(painted)).map, null)).length, LIB.items.length, 'no baseline → every entry');
  eq(JSON.stringify(S.changedEntries(null, painted)), '{}', 'a refused form has nothing to send');
});

// Just enough of the painted panel for collect(): rows whose inputs hold a
// form, read by the module's own formOfRow / refreshRow.
function fakeRow(id, form) {
  const nodes = {
    '[data-upg-price]': { value: form.priceText, setAttribute() {}, removeAttribute() {} },
    '[data-upg-enabled]': { checked: form.enabled },
    '[data-upg-installer]': byId[id].installer === 'certified_sub' ? { value: form.installerName } : null,
  };
  return { nodes, getAttribute: (a) => (a === 'data-upg-id' ? id : null), setAttribute() {}, querySelector: (sel) => (sel in nodes ? nodes[sel] : null) };
}

test('collect() hands both saves only this device\'s edits, and markSaved stops a resend', () => {
  const rows = LIB.items.map((it) => fakeRow(it.id, { priceText: '', enabled: true, installerName: '' }));
  const row = (id) => rows.find((r) => r.getAttribute('data-upg-id') === id);
  const doc = win.document;
  const realGet = doc.getElementById;
  const host = { getAttribute: (a) => ({ 'data-state': 'ready', 'data-editable': '1' })[a], querySelectorAll: () => rows };
  doc.getElementById = (id) => (id === 'upgPriceRows' ? host : null);
  try {
    // render() sets this baseline from the profile it paints; a company
    // that never saved paints every row blank and On.
    S.markSaved(S.savedEntries(null));
    eq(JSON.stringify(S.collect().changes), '{}', 'untouched panel → Save All adds nothing');
    row('fascia_wrap').nodes['[data-upg-price]'].value = '9.75';
    const c1 = S.collect();
    eq(JSON.stringify(c1.changes), '{"fascia_wrap":{"cents":975,"enabled":true}}', 'one edit → one entry');
    eq(Object.keys(c1.map).length, LIB.items.length, 'the full map is still built (every row is validated)');
    S.markSaved(c1.changes);
    eq(JSON.stringify(S.collect().changes), '{}', 'once that write lands, pressing Save again sends nothing');
    row('flip_up_extension').nodes['[data-upg-enabled]'].checked = false;
    eq(JSON.stringify(S.collect().changes), '{"flip_up_extension":{"cents":null,"enabled":false}}', 'only the new edit');
    row('gutter_apron').nodes['[data-upg-price]'].value = '6,50';
    const bad = S.collect();
    eq(bad.map, null, 'a bad price → no map'); eq(bad.changes, null, 'and no changes to write'); eq(bad.errors[0].id, 'gutter_apron', 'named');
  } finally {
    doc.getElementById = realGet;
    S.markSaved(S.savedEntries(null));
  }
});

test('a panel painted for another account\'s company is never saved — by Save All or by its own Save', () => {
  // PR #1774 review: after an account switch in the same tab the panel still
  // reads "ready" with the previous account's rows and edits, while the
  // company profile was reset under it; its own Save (or Save All) wrote those
  // edits to the new account's company.
  const rows = LIB.items.map((it) => fakeRow(it.id, { priceText: '', enabled: true, installerName: '' }));
  const attrs = { 'data-state': 'ready', 'data-editable': '1' };
  const host = {
    getAttribute: (a) => (a in attrs ? attrs[a] : null), setAttribute: (a, v) => { attrs[a] = String(v); },
    querySelectorAll: () => rows, appendChild() {}, addEventListener() {}, set textContent(v) { /* the loading line */ },
  };
  const msg = { textContent: '', hidden: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
  const doc = win.document;
  const realGet = doc.getElementById;
  const realCreate = doc.createElement;
  // Just enough DOM for render() to build its rows: attributes, children, and
  // querySelector('[data-attr]') over the subtree.
  const mkEl = () => {
    const at = {};
    const kids = [];
    const n = {
      style: {}, classList: { add() {}, remove() {}, toggle() {} },
      getAttribute: (a) => (a in at ? at[a] : null), setAttribute: (a, v) => { at[a] = String(v); },
      removeAttribute: (a) => { delete at[a]; }, hasAttribute: (a) => a in at,
      appendChild: (c) => { kids.push(c); return c; }, addEventListener() {},
      querySelector: (sel) => {
        const want = /^\[([\w-]+)\]$/.exec(sel);
        const walk = (list) => {
          for (const k of list) {
            if (want && k.hasAttribute && k.hasAttribute(want[1])) return k;
            const hit = k.__kids ? walk(k.__kids) : null;
            if (hit) return hit;
          }
          return null;
        };
        return walk(kids);
      },
      __kids: kids,
    };
    return n;
  };
  doc.getElementById = (id) => (id === 'upgPriceRows' ? host : id === 'upgPriceMsg' ? msg : null);
  doc.createElement = mkEl;
  const writes = [];
  win._saveCompanyProfile = async (o) => { writes.push(o); };
  try {
    // Control: painted from account A's company (key cA), still loaded for cA.
    win._companyProfileLoaded = true;
    win._companyProfileLoadedKey = () => 'cA';
    win._companyProfile = { pricing: {} };
    win._user = { uid: 'uA' };
    win._userClaims = {};
    S.render();
    eq(attrs['data-state'], 'ready', 'painted');
    rows.find((r) => r.getAttribute('data-upg-id') === 'fascia_wrap').nodes['[data-upg-price]'].value = '9.75';
    eq(JSON.stringify((S.collect() || {}).changes), '{"fascia_wrap":{"cents":975,"enabled":true}}', 'control: the same tenant publishes the edit');
    // The account switches: company-profile.js now names B's company (its
    // read landed), or nothing (reset, B's read still out).
    win._companyProfileLoadedKey = () => 'cB';
    eq(S.collect(), null, 'collect() for Save All: nothing to publish');
    win._companyProfileLoaded = false;
    win._companyProfileLoadedKey = () => null; // reset, the new account's read still out
    eq(S.collect(), null, 'collect() while the new account\'s profile is loading');
    // Its own Save refuses before its first await, so all of it shows now.
    S.save();
    eq(writes.length, 0, 'company writes');
    eq(attrs['data-state'], 'loading', 'the panel goes back to its loading line');
    truthy(/still loading/.test(msg.textContent) && /Nothing was saved/.test(msg.textContent), 'the rep is told: ' + msg.textContent);
  } finally {
    doc.getElementById = realGet;
    doc.createElement = realCreate;
    delete win._companyProfileLoadedKey;
    delete win._companyProfileLoaded;
    delete win._saveCompanyProfile;
    delete win._companyProfile;
    delete win._user;
    delete win._userClaims;
    S.markSaved(S.savedEntries(null));
  }
});

// Second review of #1774: the panel's key check compared the paint with the
// profile in memory only. The same account's company can change under the
// tab (claims) before anything re-reads it — its own Save then wrote edits
// made over one company's prices to the other — and a re-read that loaded
// the new company left the old one's rows up, saying nothing.
const pendingAsync = [];
function atest(name, fn) { pendingAsync.push([name, fn]); }
// A painted panel over stub DOM (the same shape as the test above), with the
// window hooks company-profile.js provides. Call restore() when done.
function paintedPanel(opts) {
  const rows = LIB.items.map((it) => fakeRow(it.id, { priceText: '', enabled: true, installerName: '' }));
  const attrs = {};
  const st = { key: opts.loadedKey, resolved: opts.resolvedKey, clears: 0, resets: 0, writes: [] };
  const host = {
    getAttribute: (a) => (a in attrs ? attrs[a] : null), setAttribute: (a, v) => { attrs[a] = String(v); },
    querySelectorAll: () => rows, appendChild() {}, addEventListener() {},
    set textContent(v) { st.clears++; },
  };
  const msg = { textContent: '', hidden: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
  const doc = win.document;
  const realGet = doc.getElementById;
  const realCreate = doc.createElement;
  const mkEl = () => {
    const at = {};
    const kids = [];
    return {
      style: {}, classList: { add() {}, remove() {}, toggle() {} },
      getAttribute: (a) => (a in at ? at[a] : null), setAttribute: (a, v) => { at[a] = String(v); },
      removeAttribute: (a) => { delete at[a]; }, hasAttribute: (a) => a in at,
      appendChild: (c) => { kids.push(c); return c; }, addEventListener() {},
      querySelector: () => null, __kids: kids,
    };
  };
  doc.getElementById = (id) => (id === 'upgPriceRows' ? host : id === 'upgPriceMsg' ? msg : null);
  doc.createElement = mkEl;
  win._companyProfileLoaded = true;
  win._companyProfileLoadedKey = () => (win._companyProfileLoaded === true ? st.key : null);
  win._resolveCompanyKey = async () => st.resolved;
  win._resetCompanyProfile = () => { st.resets++; win._companyProfileLoaded = false; };
  win._saveCompanyProfile = async (o) => { st.writes.push(o); };
  win._companyProfile = { pricing: {} };
  win._user = { uid: 'uA' };
  win._userClaims = {};
  S.render();
  return {
    st, attrs, msg,
    row: (id) => rows.find((r) => r.getAttribute('data-upg-id') === id),
    land: () => (win.__listeners['nbd:company-profile-loaded'] || []).forEach((f) => f()),
    restore: () => {
      doc.getElementById = realGet;
      doc.createElement = realCreate;
      ['_companyProfileLoadedKey', '_companyProfileLoaded', '_resolveCompanyKey', '_resetCompanyProfile', '_saveCompanyProfile', '_companyProfile', '_user', '_userClaims']
        .forEach((k) => { delete win[k]; });
      S.markSaved(S.savedEntries(null));
    },
  };
}

atest('its own Save refuses when the company it would write to is not the one the rows were painted for', async () => {
  const p = paintedPanel({ loadedKey: 'cV', resolvedKey: 'cX' }); // claims changed; nothing re-read yet
  try {
    eq(p.attrs['data-state'], 'ready', 'painted');
    p.row('fascia_wrap').nodes['[data-upg-price]'].value = '9.75';
    const r = await S.save();
    eq(r.ok, false, 'saved');
    eq(r.reason, 'loading', 'reason');
    eq(p.st.writes.length, 0, 'company writes');
    eq(p.st.resets, 1, 'the other company\'s profile in memory is forgotten');
    eq(p.attrs['data-state'], 'loading', 'the panel goes back to its loading line');
    truthy(/Nothing was saved/.test(p.msg.textContent), 'the rep is told: ' + p.msg.textContent);
  } finally { p.restore(); }
  // Control: the company it writes to IS the one painted.
  const c = paintedPanel({ loadedKey: 'cX', resolvedKey: 'cX' });
  try {
    c.row('fascia_wrap').nodes['[data-upg-price]'].value = '9.75';
    const r = await S.save();
    eq(r.ok, true, 'control: saved');
    eq(JSON.stringify(c.st.writes[0].pricing.upgradePrices), '{"fascia_wrap":{"cents":975,"enabled":true}}', 'control: the edit is written');
    eq(c.st.resets, 0, 'control: nothing forgotten');
  } finally { c.restore(); }
});

atest('another company\'s profile landing repaints rows painted for the old one, and says so when it drops typing', async () => {
  const p = paintedPanel({ loadedKey: 'cV', resolvedKey: 'cX' });
  try {
    p.row('fascia_wrap').nodes['[data-upg-price]'].value = '9.75';
    const before = p.st.clears;
    p.land(); // a landing for the company already painted: never over typing
    eq(p.st.clears, before, 'repaints on a landing for the painted company');
    eq(p.msg.textContent, '', 'message');
    p.st.key = 'cX'; // a re-read loaded the new company…
    p.land(); // …and announced it
    eq(p.st.clears, before + 1, 'repaints on the new company\'s landing');
    eq(p.attrs['data-state'], 'ready', 'painted again');
    truthy(S.collect() !== null, 'the repainted panel is saveable for the new company');
    truthy(/just loaded and replaced the changes/.test(p.msg.textContent), 'the rep is told: ' + p.msg.textContent);
  } finally { p.restore(); }
  // The Estimates panel's own landing repaint usually runs first (its listener
  // registers at boot, this lazy module's later) and calls render() itself:
  // the notice must come from that repaint too.
  const d = paintedPanel({ loadedKey: 'cV', resolvedKey: 'cX' });
  try {
    d.row('fascia_wrap').nodes['[data-upg-price]'].value = '9.75';
    d.st.key = 'cX';
    S.render(); // _paintCompanyEstimateInputs → NBDUpgradePriceSettings.render()
    truthy(/just loaded and replaced the changes/.test(d.msg.textContent), 'the rep is told by the panel\'s repaint: ' + d.msg.textContent);
    const before = d.st.clears;
    d.land(); // this module's listener, second: nothing left to repaint
    eq(d.st.clears, before, 'repaints by the second listener');
    // Control: an ordinary repaint for the same company (the tab reopened)
    // is not reported as a replacement.
    d.msg.textContent = '';
    d.row('fascia_wrap').nodes['[data-upg-price]'].value = '8.00';
    S.render();
    eq(d.msg.textContent, '', 'no notice on a same-company repaint');
  } finally { d.restore(); }
  // No typing: repainted just the same, without the notice.
  const q = paintedPanel({ loadedKey: 'cV', resolvedKey: 'cX' });
  try {
    const before = q.st.clears;
    q.st.key = 'cX';
    q.land();
    eq(q.st.clears, before + 1, 'repaints');
    eq(q.msg.textContent, '', 'no notice when nothing was typed');
  } finally { q.restore(); }
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n4. round-trip — typed dollars reach the quote and the paper, to the cent');
console.log('──────────────────────────────────────────────────');

function savedFrom(edits) {
  const f = blankForms();
  Object.keys(edits).forEach((id) => Object.assign(f[id], edits[id]));
  const r = S.buildSaveMap(f);
  if (!r.map) throw new Error('form did not save: ' + JSON.stringify(r.errors));
  // What Firestore hands back is JSON: prove the map survives it unchanged.
  return JSON.parse(JSON.stringify(r.map));
}

test('the stored shape sanitizes to exactly the typed prices, Off items and installer', () => {
  const saved = savedFrom({
    underground_drain: { priceText: '12.34' }, fascia_wrap: { priceText: '9.75' },
    flip_up_extension: { priceText: '38', enabled: false }, alurex: { installerName: 'Acme Gutter Co' },
  });
  const s = U.sanitizeOverrides(saved);
  eq(JSON.stringify(s.prices), '{"underground_drain":1234,"flip_up_extension":3800,"fascia_wrap":975}', 'prices');
  eq(JSON.stringify(s.disabled), '{"flip_up_extension":true}', 'disabled');
  eq(JSON.stringify(s.installers), '{"alurex":"Acme Gutter Co"}', 'installers');
  // Every other entry is "no price, On, no name": it changes nothing and is
  // reported as such, never read as a $0 price.
  eq(s.ignored.slice().sort().join(), ['amerimax_lockin_mesh', 'leafblaster_pro_micromesh', 'leafblaster_pro_reinforced', 'gutter_apron', 'downspout_3x4_step_up', 'popup_emitter'].sort().join(), 'ignored');
});

test('a Settings-priced needs_price item is offered and quoted at the typed price', () => {
  const saved = savedFrom({ underground_drain: { priceText: '12.34' } });
  const before = offerMap(U.offeredFor(K5, ctxFor(), {}));
  eq(before.underground_drain.state, 'needs_price', 'library alone: needs a price');
  const m = offerMap(U.offeredFor(K5, ctxFor(), saved));
  eq(m.underground_drain.state, 'available', 'state'); eq(m.underground_drain.unitCents, 1234, 'unitCents');
  eq(m.underground_drain.priceSource, 'tenant', 'priceSource');
  const p = U.price([{ id: 'underground_drain', qty: 33 }], ctxFor(), saved);
  eq(p.errors.length, 0, 'errors'); eq(p.upgradeCents, 33 * 1234, 'upgradeCents'); eq(p.rows[0].total, 407.22, 'row total');
  eq(p.rows[0].rate, '$12.34', 'row rate');
});

test('the typed price is the printed price in all three readers, and moves the total by exactly that', () => {
  const saved = savedFrom({ underground_drain: { priceText: '12.34' }, amerimax_lockin_mesh: { priceText: '7.25' } });
  const base = JT.buildEstimatePayload(k5, { name: 'Settings round-trip' });
  const p = U.price(['amerimax_lockin_mesh', { id: 'underground_drain', qty: 33 }], ctxFor({ taxRate: base.taxRate }), saved);
  eq(p.errors.length, 0, 'errors');
  const est = U.applyToEstimate(base, p);
  const want = { 'UPG LG-AMX': 137 * 725, 'UPG UND-DR': 33 * 1234 };
  const c = (v) => Math.round(Number(v) * 100);
  Object.keys(want).forEach((code) => {
    const desc = est.rows.find((r) => r.code === code).desc;
    eq(c(CR.buildDisplayRows(est).find((r) => r.code === code).total), want[code], code + ' buildDisplayRows');
    eq(c(CR.buildDocLineItems(est).find((r) => r.code === code).total), want[code], code + ' buildDocLineItems');
    eq(c(IP.buildRowItems(est).find((r) => r.description === desc).total), want[code], code + ' InvoicePipeline.buildRowItems');
  });
  eq(c(est.subtotal) - c(base.subtotal), 137 * 725 + 33 * 1234, 'subtotal moves by exactly the typed prices');
});

test('Off in Settings hides the item from the builder and refuses a quote', () => {
  const saved = savedFrom({ alurex: { enabled: false } });
  const m = offerMap(U.offeredFor(K5, ctxFor(), saved));
  eq(m.alurex.state, 'hidden', 'state'); truthy(/Turned off in this company/.test(m.alurex.reason), m.alurex.reason);
  eq(codes(U.price(['alurex'], ctxFor(), saved).errors).join(), 'hidden', 'quote refused');
  eq(m.amerimax_lockin_mesh.state, 'available', 'the other guards stay offered');
});

test('the saved installer name prints on the offer and the row; blank prints the neutral sentence', () => {
  const saved = savedFrom({ alurex: { installerName: 'Acme Gutter Co' } });
  const o = offerMap(U.offeredFor(K5, ctxFor(), saved)).alurex;
  eq(o.installerLine, 'Installed by Acme Gutter Co, an independent Alu-Rex-certified installer.', 'offer');
  eq(U.price(['alurex'], ctxFor(), saved).rows[0].upgradeInstaller, o.installerLine, 'row');
  const neutral = offerMap(U.offeredFor(K5, ctxFor(), savedFrom({}))).alurex;
  eq(neutral.installerLine, 'Installed by an independent certified installer.', 'blank');
  // The Settings name is the owner's answer for THIS item: it wins over a
  // caller's generic ctx.tenant, which still works when nothing is saved.
  eq(offerMap(U.offeredFor(K5, ctxFor({ tenant: { certifiedInstallerName: 'Other Co' } }), saved)).alurex.installerLine, o.installerLine, 'Settings name wins');
  truthy(/Other Co/.test(offerMap(U.offeredFor(K5, ctxFor({ tenant: { certifiedInstallerName: 'Other Co' } }), savedFrom({}))).alurex.installerLine), 'ctx.tenant fallback');
});

test('a Settings price on an approved guard replaces the default, at exact cents', () => {
  const saved = savedFrom({ alurex: { priceText: '19.00' } });
  eq(U.price(['alurex'], ctxFor(), saved).upgradeCents, 137 * 1900, 'your price');
  eq(U.price(['alurex'], ctxFor(), savedFrom({})).upgradeCents, 137 * 1800, 'blank → the default');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n5. default — the builder sees the saved Settings without being handed them');
console.log('──────────────────────────────────────────────────');

test('omitting tenantOverrides reads companyProfile.pricing.upgradePrices at call time', () => {
  const saved = savedFrom({ underground_drain: { priceText: '12.34' }, alurex: { enabled: false } });
  try {
    win._companyProfile = { pricing: { upgradePrices: saved } };
    const m = offerMap(U.offeredFor(K5, ctxFor()));
    eq(m.underground_drain.unitCents, 1234, 'saved price, no third argument');
    eq(m.alurex.state, 'hidden', 'saved Off, no third argument');
    const p = U.price([{ id: 'underground_drain', qty: 10 }], ctxFor());
    eq(p.upgradeCents, 12340, 'price() reads it too');
    // Read at call time, not cached: an owner's later Save is seen at once.
    win._companyProfile = { pricing: { upgradePrices: savedFrom({ underground_drain: { priceText: '15' } }) } };
    eq(offerMap(U.offeredFor(K5, ctxFor())).underground_drain.unitCents, 1500, 'the newer save');
  } finally { delete win._companyProfile; }
});

test('null is "no overrides of my own" (the saved Settings); only {} prices from the library alone', () => {
  // A caller that defaults its map to null (the builder card did, reading a
  // profile field nothing writes) must still quote what the owner saved —
  // treating null as "library alone" would hide every Settings price.
  try {
    win._companyProfile = { pricing: { upgradePrices: savedFrom({ underground_drain: { priceText: '12.34' } }) } };
    eq(offerMap(U.offeredFor(K5, ctxFor(), null)).underground_drain.unitCents, 1234, 'null → saved');
    eq(U.price([{ id: 'underground_drain', qty: 10 }], ctxFor(), null).upgradeCents, 12340, 'price(null) → saved');
    eq(offerMap(U.offeredFor(K5, ctxFor(), {})).underground_drain.state, 'needs_price', '{} → library alone');
    eq(codes(U.price([{ id: 'underground_drain', qty: 10 }], ctxFor(), {}).errors).join(), 'needs_price', 'price({}) → library alone');
  } finally { delete win._companyProfile; }
});

test('no profile, a pre-hydration profile, or a garbage map → the library alone (refuses, never guesses)', () => {
  [undefined, {}, { pricing: {} }, { pricing: { upgradePrices: null } }, { pricing: { upgradePrices: 'x' } }, { pricing: { upgradePrices: [1, 2] } }]
    .forEach((cp, i) => {
      try {
        if (cp === undefined) delete win._companyProfile; else win._companyProfile = cp;
        const m = offerMap(U.offeredFor(K5, ctxFor()));
        eq(m.underground_drain.state, 'needs_price', 'case ' + i + ' drain');
        eq(m.alurex.unitCents, 1800, 'case ' + i + ' alurex default');
      } finally { delete win._companyProfile; }
    });
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n6. re-read — the panel shows only what the builder will use');
console.log('──────────────────────────────────────────────────');

test('save → reload: savedEntries gives back the typed prices, Off and the installer', () => {
  const saved = savedFrom({
    fascia_wrap: { priceText: '9.75' }, flip_up_extension: { priceText: '38', enabled: false },
    alurex: { installerName: 'Acme Gutter Co' },
  });
  const e = S.savedEntries({ pricing: { upgradePrices: saved } });
  eq(Object.keys(e).length, LIB.items.length, 'every item');
  eq(S.centsToInput(e.fascia_wrap.cents), '9.75', 'fascia text'); eq(e.fascia_wrap.enabled, true, 'fascia on');
  eq(e.flip_up_extension.cents, 3800, 'flip-up price kept'); eq(e.flip_up_extension.enabled, false, 'flip-up off');
  eq(e.alurex.installerName, 'Acme Gutter Co', 'installer'); eq(e.alurex.cents, null, 'alurex blank (the default stands)');
});

test('a stored value the builder would drop reads back blank, never as a price', () => {
  const e = S.savedEntries({ pricing: { upgradePrices: {
    fascia_wrap: { cents: 0, enabled: true }, gutter_apron: { cents: 12.5 }, underground_drain: { cents: 180000000 },
    popup_emitter: { cents: '4500' }, downspout_3x4_step_up: 700, flip_up_extension: { enabled: false },
    amerimax_lockin_mesh: { installerName: 'Nope' }, nope: { cents: 100 },
  } } });
  eq(e.fascia_wrap.cents, null, '$0 dropped'); eq(e.gutter_apron.cents, null, 'fraction dropped');
  eq(e.underground_drain.cents, null, 'typo dropped'); eq(e.popup_emitter.cents, 4500, 'numeric string kept');
  eq(e.downspout_3x4_step_up.cents, 700, 'legacy bare cents kept'); eq(e.flip_up_extension.enabled, false, 'legacy Off kept');
  eq(e.amerimax_lockin_mesh.installerName, '', 'installer only on certified items');
  eq('nope' in e, false, 'unknown ids never shown');
  eq(Object.keys(S.savedEntries(null)).length, LIB.items.length, 'no profile → every item blank');
});

test('sanitizeOverrides keeps its older contract for the bare and {enabled} forms', () => {
  const s = U.sanitizeOverrides({ alurex: 1900, gutter_apron: { enabled: false }, fascia_wrap: { enabled: true } });
  eq(JSON.stringify(s.prices), '{"alurex":1900}', 'bare cents');
  eq(JSON.stringify(s.disabled), '{"gutter_apron":true}', 'enabled:false');
  truthy(s.ignored.includes('fascia_wrap'), '{enabled:true} alone changes nothing');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n7. who edits — the firestore.rules companyProfile write gate, mirrored');
console.log('──────────────────────────────────────────────────');

test('owner, company admin and platform admin edit; team roles read', () => {
  eq(S.canEdit({ role: 'company_admin', companyId: 'co1' }, 'u1'), true, 'company_admin');
  eq(S.canEdit({ role: 'admin' }, 'u1'), true, 'platform admin');
  eq(S.canEdit({}, 'u1'), true, 'solo owner, no claims');
  eq(S.canEdit({ companyId: 'u1' }, 'u1'), true, 'owner whose uid is the companyId');
  eq(S.canEdit({ role: 'manager', companyId: 'co1' }, 'u2'), false, 'manager');
  eq(S.canEdit({ role: 'sales_rep', companyId: 'co1' }, 'u3'), false, 'sales rep');
  eq(S.canEdit({ role: 'viewer', companyId: 'co1' }, 'u4'), false, 'viewer');
  eq(S.canEdit({ role: 'company_admin', companyId: 'co1' }, null), false, 'signed out');
  // Owner hand-off (2026-10-12): both parties are company_admin under the same companyId.
  eq(S.canEdit({ role: 'company_admin', companyId: 'u1' }, 'u1'), true, 'former owner (login is the company id, now company_admin)');
  eq(S.canEdit({ role: 'company_admin', companyId: 'u1' }, 'adm9'), true, 'new owner (admin under the former owner company id)');
});

test('the gate matches firestore.rules cpCanWrite, not a guess', () => {
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const m = /function cpCanWrite\(\) \{\s*return ([\s\S]*?);\s*\}/.exec(rules);
  truthy(m, 'cpCanWrite not found in firestore.rules');
  const body = m[1].replace(/\s+/g, ' ').trim();
  // 2026-09-25: the solo branch gained notViewer() (Jo's decision B); canEdit
  // mirrors it with an explicit viewer refusal (the 'viewer' case above).
  // 2026-10-12 (owner hand-off): the solo branch is ownsTenantByUid(companyId),
  // i.e. uid == companyId AND the company doc's ownerId (when the doc exists)
  // is that uid. A former owner (login is still the company id, ownerId moved)
  // therefore edits through the isCompanyAdmin() branch their demotion claim
  // grants, exactly as the new owner (an admin under the same companyId) does.
  eq(body, 'isAdmin() || (ownsTenantByUid(companyId) && notViewer()) || (isCompanyAdmin() && companyId == myCompanyId())', 'rule body (update canEdit if this changes)');
  const h = /function ownsTenantByUid\(cid\) \{\s*return ([\s\S]*?);\s*\}/.exec(rules);
  truthy(h, 'ownsTenantByUid not found in firestore.rules');
  const hb = h[1].replace(/\s+/g, ' ').trim();
  truthy(/request\.auth\.uid == cid/.test(hb) && /\.data\.get\('ownerId', request\.auth\.uid\) == request\.auth\.uid/.test(hb),
    'ownsTenantByUid must keep both halves: uid == company id AND ownerId == uid (canEdit mirrors only the uid half; the ownerId half can only deny)');
});

// The async tests (section 3's tenant checks) run last, one at a time: each
// swaps the shared window hooks in and back out.
let asyncDone = false;
process.on('beforeExit', () => {
  if (asyncDone) return;
  console.log('  ✗ an async test never settled (a promise hung) — failing the suite');
  process.exit(1);
});
(async () => {
  console.log('\n3b. panel tenant checks (async)');
  console.log('──────────────────────────────────────────────────');
  for (const [name, fn] of pendingAsync) {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
  }
  asyncDone = true;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
