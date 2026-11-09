/**
 * tests/call-to-close-estimate-prefill-2026-11-09.test.js — Call to Close P1,
 * lane "estimate": a reviewed call brief opens the estimate builder with its
 * CHOICES filled in, and a repair call opens a repair quick quote.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §5.1, §9 P1, Q8.
 *
 *   A. the pure mapper docs/pro/js/estimate-call-prefill.js: enum fields only
 *      (jobMode, workKind, tier, stories, layers, chimney / skylight flashing);
 *      a spoken square count is a hint (the words, never a number); a hostile
 *      brief carrying rawSqft, a price, a rate, a total, a deductible, an ACV,
 *      warranty years or a signed tier sets none of them; the customer's own
 *      job type wins; repair calls get repair templates only
 *   B. the real V2 builder (estimate-v2-ui.js on the real engines, vm sandbox):
 *      openEstimateV2Builder({ leadId, callPrefill }) sets the choices, never
 *      rawSqft or a price field, never writes estimate_drafts (nor the local
 *      draft) until the rep acts; × on a chip puts the old value back; closing
 *      untouched puts every old value back; a template goes in only on a tap,
 *      through JobTemplates.insertIntoV2, and the engine prices it
 *   C. the deep link from the customer page: ?lead=<id>&callBrief=<callId>
 *      plus a sessionStorage hand-off carrying the brief the callBrief
 *      callable returned (the dashboard cleans its URL before the lazy
 *      builder loads). The builder never reads the stored brief itself, so
 *      the callable's kill switch covers this path; a URL alone, a stale,
 *      other-customer or other-call hand-off prefills nothing
 *   D. the sheet (call-brief-ui.js): "Start estimate" / "Start repair quote";
 *      on the dashboard it opens the builder with the brief, on the customer
 *      page it goes to the dashboard deep link; never on an unreliable brief
 *   E. boot + CSP: no <script> tag for the new file, it loads lazily, no
 *      inline style or handler, no held file touched
 *
 * Run: node tests/call-to-close-estimate-prefill-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : '')); failed++; fails.push(label); }
}
function section(t) { console.log('\n' + t); }
const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

const PREFILL_FILE = 'docs/pro/js/estimate-call-prefill.js';
const SRC_PREFILL = exists(PREFILL_FILE) ? read(PREFILL_FILE) : '';

// A repair call: cash, "the best one", two stories, two layers, a chimney and gutters.
const BRIEF = {
  v: 1, transcriptOk: { reliable: true, cutOff: false, why: '' },
  summary: { text: 'Leak by the chimney; wants it fixed.', quotes: ['leaking by the chimney'], inferred: false },
  fields: {
    insCarrier: null, claimNumber: null, dateOfLoss: null, adjusterName: null, adjusterMeetingYmd: null,
    damageType: { value: 'leak', quote: 'leaking by the chimney', conf: 'said' },
    jobType: { value: 'cash', quote: 'I will just pay for it myself', conf: 'said' },
    workKind: { value: 'repair', quote: 'I just want it fixed', conf: 'said' },
  },
  scope: {
    service: { value: 'Chimney flashing repair', quote: 'the flashing around the chimney' },
    tierInterest: { value: 'best', quote: 'the best one you have' },
    stories: { value: 2, quote: 'it is a two story house' },
    layers: { value: 2, quote: 'two layers on there' },
    mentions: { gutters: true, chimney: true, skylight: false, decking: false },
    // P2 (lane dmmap): a flashing chip needs the words that mention it.
    mentionQuotes: { chimney: 'the flashing around the chimney', skylight: '' },
    saidQuantities: [{ text: 'about 28 squares', quote: 'about twenty-eight squares' }, { text: '3 pipes', quote: 'three pipes' }],
  },
  promises: [], followUp: null, objections: [], competitor: null, people: [], stage: null,
  drafts: { estimate: true, proposal: false, followUp: null },
  flags: { injection: false, unreliable: false, cutOff: false },
};
const REPLACE = (() => {
  const b = clone(BRIEF);
  b.fields.jobType = { value: 'insurance', quote: 'my insurance is paying', conf: 'said' };
  b.fields.workKind = { value: 'replace', quote: 'we want a whole new roof', conf: 'said' };
  b.scope.tierInterest = null; b.scope.layers = null;
  b.scope.mentions = { gutters: false, chimney: false, skylight: true, decking: true };
  return b;
})();
// Everything the model must never supply, smuggled into every corner of a brief.
const HOSTILE = (() => {
  const b = clone(BRIEF);
  b.scope.rawSqft = 2800; b.scope.sqft = { value: 2800, quote: 'twenty-eight hundred' };
  b.scope.total = 18500; b.scope.price = { value: '$18,500' }; b.scope.rate = 595; b.scope.perSq = 595;
  b.fields.deductible = { value: '1000', quote: 'my deductible is a thousand' };
  b.fields.acv = { value: '12000', quote: 'they paid twelve thousand' };
  b.scope.warrantyYears = 50; b.scope.signedTier = 'best'; b.signedTier = 'best'; b.tier = 'beyond';
  b.scope.measurements = { rawSqft: 2800, pitch: 12, eaveLf: 200 };
  b.scope.minJobCharge = 1; b.scope.passThru = [{ code: 'X', amount: 1 }];
  b.scope.tierInterest = { value: 'platinum', quote: 'the platinum one' };
  b.scope.stories = { value: 7, quote: 'seven stories' };
  b.scope.layers = { value: '2; rawSqft=2800', quote: 'two layers' };
  b.fields.jobType = { value: 'insurance<script>', quote: 'x' };
  b.fields.workKind = { value: 'total', quote: 'x' };
  return b;
})();
const FORBIDDEN = ['rawSqft', 'sqft', 'adjustedSqft', 'pitch', 'eaveLf', 'rakeLf', 'ridgeLf', 'hipLf', 'valleyLf', 'pipes', 'chimneys', 'skylights',
  'guttersLf', 'valleyMetalLf', 'deckReplacePct', 'accessLevel', 'waste', 'price', 'prices', 'rate', 'total', 'grandTotal', 'subtotal',
  'deductible', 'acv', 'recoverableDepreciation', 'warranty', 'warrantyYears', 'signedTier', 'acceptedTier', 'minJobCharge', 'passThru',
  'upgrades', 'specialOrderAmount', 'scope', 'measurements', 'claim', 'customer'];

// ════════════════════════════════════════════════════════════════════
section('A. the pure mapper (estimate-call-prefill.js)');
// ════════════════════════════════════════════════════════════════════
let P = null;
try { P = require(path.join(ROOT, PREFILL_FILE)); } catch (e) { P = null; }
ok('the mapper exists and exports fromBrief / plan / templateMatches / KEYS', !!(P && typeof P.fromBrief === 'function' && typeof P.plan === 'function' && typeof P.templateMatches === 'function' && Array.isArray(P.KEYS)));
if (P) {
  ok('KEYS are exactly the choice fields (no number, no money)', JSON.stringify(P.KEYS) === JSON.stringify(['jobMode', 'workKind', 'tier', 'stories', 'tearOffLayers', 'hasChimneyFlash', 'hasSkylightFlash']), P.KEYS);
  const pre = P.fromBrief(clone(BRIEF));
  const by = {}; (pre.items || []).forEach((i) => { by[i.key] = i; });
  ok('jobMode cash, workKind repair, tier best, 2 stories, 2 layers, chimney flashing', by.jobMode && by.jobMode.value === 'cash' && by.workKind.value === 'repair' && by.tier.value === 'best'
    && by.stories.value === 2 && by.tearOffLayers.value === 2 && by.hasChimneyFlash.value === true && !by.hasSkylightFlash, pre.items);
  ok('each item carries the words that were said (a quote) and a label', by.jobMode.quote === 'I will just pay for it myself' && by.tier.quote === 'the best one you have' && (pre.items || []).every((i) => typeof i.label === 'string' && i.label));
  ok('"replace" becomes the builder\'s "replacement"', P.fromBrief(clone(REPLACE)).items.some((i) => i.key === 'workKind' && i.value === 'replacement'));
  ok('a spoken square count is a hint with the words only, never a number', (pre.hints.sqft || []).length === 1 && pre.hints.sqft[0] === 'about twenty-eight squares' && !(pre.items || []).some((i) => i.key === 'rawSqft'), pre.hints);
  ok('other said quantities are hints too (never items)', (pre.hints.said || []).indexOf('three pipes') !== -1 && !(pre.items || []).some((i) => /pipe/i.test(i.key)));
  ok('gutters (no control to set) is a mention hint, not an item', (pre.hints.mentions || []).indexOf('Gutters') !== -1);
  ok('decking is a mention hint only (deck % comes from the roof, never the call)', (P.fromBrief(clone(REPLACE)).hints.mentions || []).indexOf('Decking') !== -1 && !P.fromBrief(clone(REPLACE)).items.some((i) => /deck/i.test(i.key)));
  ok('the template search words come from the said service / damage', /chimney/.test(pre.words) && /flashing/.test(pre.words));

  const hp = P.fromBrief(clone(HOSTILE));
  const hkeys = (hp.items || []).map((i) => i.key);
  ok('hostile brief: no forbidden key ever becomes an item', !hkeys.some((k) => FORBIDDEN.indexOf(k) !== -1), hkeys);
  ok('hostile brief: an off-list tier, 7 stories, a junk layer count, a junk job type and work kind are all dropped', !hkeys.includes('tier') && !hkeys.includes('stories') && !hkeys.includes('tearOffLayers') && !hkeys.includes('jobMode') && !hkeys.includes('workKind'), hkeys);
  ok('hostile brief: every item key is on the KEYS list', hkeys.every((k) => P.KEYS.indexOf(k) !== -1));
  ok('hostile brief: no number from the model in any item value except stories / layers 1-3', (hp.items || []).every((i) => typeof i.value !== 'number' || ((i.key === 'stories' || i.key === 'tearOffLayers') && [1, 2, 3].indexOf(i.value) !== -1)));
  const unrel = clone(BRIEF); unrel.transcriptOk.reliable = false;
  ok('an unreliable transcript prefills nothing', P.fromBrief(unrel).items.length === 0 && P.fromBrief(unrel).hints.sqft.length === 0);
  ok('no brief → an empty prefill, no throw', P.fromBrief(null).items.length === 0 && P.fromBrief(undefined).hints.sqft.length === 0);

  const fresh = { jobMode: 'insurance', tier: 'better', workKind: null, measurements: { stories: 1, tearOffLayers: 1, hasChimneyFlash: false, hasSkylightFlash: false } };
  const tiers5 = ['economy', 'good', 'better', 'best', 'beyond'];
  const plan = P.plan(pre, { state: fresh, leadJobType: '', tiers: tiers5 });
  ok('plan: from → to for each change', plan.length === 6 && plan.every((p) => 'from' in p && 'to' in p) && plan.find((p) => p.key === 'tier').from === 'better' && plan.find((p) => p.key === 'tier').to === 'best', plan);
  ok('plan: the customer\'s own job type wins over the call', !P.plan(pre, { state: fresh, leadJobType: 'insurance', tiers: tiers5 }).some((p) => p.key === 'jobMode'));
  ok('plan: a tier this company does not offer is skipped', !P.plan(pre, { state: fresh, leadJobType: '', tiers: ['good', 'better'] }).some((p) => p.key === 'tier'));
  ok('plan: a work kind the rep already set is kept', !P.plan(pre, { state: Object.assign({}, fresh, { workKind: 'replacement' }), tiers: tiers5 }).some((p) => p.key === 'workKind'));
  ok('plan: an unchanged value is not a change', !P.plan(pre, { state: Object.assign({}, fresh, { jobMode: 'cash' }), tiers: tiers5 }).some((p) => p.key === 'jobMode'));
  const forged = { items: [{ key: 'rawSqft', value: 2800 }, { key: 'total', value: 1 }, { key: 'claim', value: { deductible: 1 } }, { key: 'tier', value: 'best', quote: 'q' }, { key: 'stories', value: 9 }], hints: {} };
  const fp = P.plan(forged, { state: fresh, tiers: tiers5 });
  ok('plan refuses a forged prefill: only the valid tier survives', fp.length === 1 && fp[0].key === 'tier', fp);

  // Template matches: a fake JobTemplates with repair, emergency and replacement templates.
  const TPL = [
    { id: 'rep_chimney', name: 'Chimney Flashing Repair', description: 'Re-flash a leaking chimney', jobType: 'repair', category: 'leak_flashing', tags: ['chimney', 'flashing', 'leak'] },
    { id: 'rep_shingle', name: 'Shingle Patch', description: 'Replace a few blown-off shingles', jobType: 'repair', category: 'roof_repair', tags: ['shingle'] },
    { id: 'rep_pipe', name: 'Pipe Boot Repair', description: 'New pipe boot', jobType: 'repair', category: 'leak_flashing', tags: ['pipe'] },
    { id: 'emg_tarp', name: 'Emergency Tarp', description: 'Tarp a leak', jobType: 'emergency', category: 'storm_emergency', tags: ['leak'] },
    { id: 'rpl_full', name: 'Full Roof Replacement', description: 'Tear off and replace', jobType: 'replacement', category: 'roof_replacement', tags: ['chimney'] },
  ];
  const searched = [];
  const JT = { search: (q, f) => { searched.push([q, f]); return TPL.filter((t) => !f || !f.jobType || t.jobType === f.jobType); } };
  const m = P.templateMatches(JT, pre, 5);
  ok('repair call: JobTemplates.search filtered to repair templates', searched.some((s) => s[1] && s[1].jobType === 'repair') && m.length >= 1 && m.every((t) => TPL.find((x) => x.id === t.id).jobType === 'repair'), m);
  ok('…the one that matches the said words comes first', m[0].id === 'rep_chimney', m);
  ok('…and when the said words match some, only those (no unrelated shingle patch)', !m.some((t) => t.id === 'rep_shingle'), m);
  const vague = P.fromBrief(clone(BRIEF)); vague.words = 'zzzz';
  ok('words that match nothing → the repair list as JobTemplates.search returns it', P.templateMatches(JT, vague, 5).map((t) => t.id).join() === 'rep_chimney,rep_shingle,rep_pipe');
  ok('…returns ids and names only (no price)', m.every((t) => Object.keys(t).sort().join() === 'id,name'));
  ok('replacement call: replacement templates only', P.templateMatches(JT, P.fromBrief(clone(REPLACE)), 5).every((t) => t.id === 'rpl_full'));
  const noKind = clone(BRIEF); noKind.fields.workKind = null;
  ok('no work kind said → no template suggestion', P.templateMatches(JT, P.fromBrief(noKind), 5).length === 0);
  ok('no JobTemplates loaded → no suggestion, no throw', P.templateMatches(null, pre, 5).length === 0);
}

// ════════════════════════════════════════════════════════════════════
// Sandbox — the real engine stack and the real V2 builder in a fake window.
// ════════════════════════════════════════════════════════════════════
function makeSandbox() {
  const byId = {};
  function el(tag) {
    const classes = new Set();
    return {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, hidden: false, firstChild: null, checked: false, parentNode: null, options: [],
      classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); }, toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); } },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; }, insertBefore(n) { return n; },
      focus() {}, setSelectionRange() {}, remove() {}, after() {}, contains() { return true; },
    };
  }
  // Every id resolves (the builder's markup is not parsed here), so the real
  // setters that touch their buttons run unchanged.
  const document = { head: el('head'), body: el('body'), createElement: el,
    getElementById(id) { if (!byId[id]) { byId[id] = el('div'); byId[id].id = id; } return byId[id]; },
    querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {} };
  const store = {};
  const localStorage = { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } };
  const sstore = {};
  const sessionStorage = { getItem(k) { return Object.prototype.hasOwnProperty.call(sstore, k) ? sstore[k] : null; }, setItem(k, v) { sstore[k] = String(v); }, removeItem(k) { delete sstore[k]; } };
  const location = { origin: 'https://example.test', pathname: '/pro/dashboard.html', search: '', hash: '' };
  const win = { localStorage, sessionStorage, document, location, innerWidth: 1280 };
  win.window = win;
  const sandbox = { window: win, document, localStorage, sessionStorage, location, navigator: { userAgent: 'node' }, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, CSS: { escape: (s) => String(s) }, URLSearchParams, Event: function (t) { this.type = t; } };
  vm.createContext(sandbox);
  return { win, sandbox, store, sstore, location };
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
// The lazy load: the builder asks ScriptLoader for the mapper the first time a
// call prefill arrives. The fake loader runs the real file in the sandbox.
const loads = [];
W.ScriptLoader = { load: (src) => { loads.push(src); if (/estimate-call-prefill\.js/.test(src) && SRC_PREFILL && !W.NBDEstimateCallPrefill) vm.runInContext(SRC_PREFILL, env.sandbox, { filename: 'estimate-call-prefill.js' }); return Promise.resolve(); }, loadBundle: () => Promise.resolve() };
// Firestore spies: every write is recorded; reads answer from `docs`.
const writes = [];
const reads = [];
const docs = {};
W.db = {};
W._user = { uid: 'jo' };
W.doc = (_db, ...segs) => ({ path: segs.join('/') });
W.setDoc = async (ref, data) => { writes.push({ path: ref.path, data }); };
W.updateDoc = async (ref, data) => { writes.push({ path: ref.path, data }); };
W.addDoc = async (ref, data) => { writes.push({ path: ref && ref.path, data }); return { id: 'x' }; };
W.deleteDoc = async (ref) => { writes.push({ path: ref.path, del: true }); };
W.getDoc = async (ref) => { reads.push(ref.path); const d = docs[ref.path]; return { exists: () => !!d, data: () => d, id: ref.path.split('/').pop() }; };
W.serverTimestamp = () => 'ts';
W.showToast = () => {};
const DRAFT_KEY = 'nbd_v2_draft_v1';
const draftWrites = () => writes.filter((w) => /^estimate_drafts\//.test(w.path || ''));

const V2 = W.EstimateV2UI;
const st = () => V2.getState();
const CP = () => (V2 && V2._test && V2._test.callPrefill) || null;
function moneySnapshot() {
  const s = st();
  return JSON.stringify({ rawSqft: s.measurements.rawSqft, pitch: s.measurements.pitch, eave: s.measurements.eaveLf, pipes: s.measurements.pipes, chimneys: s.measurements.chimneys,
    skylights: s.measurements.skylights, gutters: s.measurements.guttersLf, valley: s.measurements.valleyMetalLf, deck: s.measurements.deckReplacePct, access: s.measurements.accessLevel,
    claim: s.claim, minJobCharge: s.minJobCharge, passThru: s.passThru, upgrades: s.upgrades, specialOrderAmount: s.specialOrderAmount, scope: s.scope, county: s.county, mode: s.mode });
}
function leads(list) { W._leads = list; W._leadDoc = null; }

(async () => {
  section('B. the real V2 builder (estimate-v2-ui.js)');
  ok('builder loaded with its test seam for the call prefill', !!(V2 && CP() && typeof CP().clear === 'function' && typeof CP().template === 'function' && typeof CP().panelHtml === 'function'));
  if (V2 && CP()) {
    leads([{ id: 'L1', firstName: 'Pat', lastName: 'Lee', address: '1 Elm St, Dayton, OH 45402', jobType: '' }]);
    W.openEstimateV2Builder({ leadId: 'L2-warm' });   // a warm builder: another customer first
    await tick(450);
    writes.length = 0;
    try { delete env.store[DRAFT_KEY]; } catch (_) {}
    W.openEstimateV2Builder({ leadId: 'L1' });
    await tick(450);
    const baseline = moneySnapshot();
    writes.length = 0;
    try { delete env.store[DRAFT_KEY]; } catch (_) {}
    W.openEstimateV2Builder({ leadId: 'L1', callPrefill: { callId: 'cube_ABC', brief: clone(HOSTILE) } });
    await tick(20);
    ok('the mapper is loaded lazily, through ScriptLoader, only when a call prefill arrives', loads.length === 1 && /\/pro\/js\/estimate-call-prefill\.js\?v=\d+$/.test(loads[0]), loads);
    await tick(600);   // past the 400 ms autosave debounce and its Firestore push
    const s = st();
    ok('a hostile brief: only its one valid choice (chimney flashing) applies; junk job type, work kind, tier, stories and layers do not',
      s.measurements.hasChimneyFlash === true && s.jobMode === 'insurance' && s.workKind == null && s.measurements.stories === 1 && s.measurements.tearOffLayers === 1
      && CP().applied().length === 1 && CP().applied()[0].key === 'hasChimneyFlash', { jobMode: s.jobMode, workKind: s.workKind, m: s.measurements, applied: CP().applied() });
    ok('a hostile brief: rawSqft, every measurement, the claim money, the floor, pass-throughs, upgrades and the scope are untouched', moneySnapshot() === baseline, [baseline, moneySnapshot()]);
    ok('…and its off-list tier did not apply', s.tier === 'better', s.tier);
    ok('rawSqft is still empty (0) — the said "twenty-eight squares" is only a hint', s.measurements.rawSqft === 0);
    ok('estimate_drafts/{uid} is never written by the prefill', draftWrites().length === 0, writes.map((w) => w.path));
    ok('…nor the local draft', env.store[DRAFT_KEY] === undefined);
    ok('no Firestore write of any kind', writes.length === 0, writes.map((w) => w.path));
    ok('no template inserted by itself (scope still empty)', (s.scope || []).length === 0);

    // A clean prefill from a normal brief.
    leads([{ id: 'L3', firstName: 'Sam', lastName: 'Ray', address: '3 Oak St', jobType: '' }]);
    W.openEstimateV2Builder({ leadId: 'L3' });
    await tick(450);
    const base3 = moneySnapshot();
    writes.length = 0;
    try { delete env.store[DRAFT_KEY]; } catch (_) {}
    W.openEstimateV2Builder({ leadId: 'L3', callPrefill: { callId: 'cube_DEF', brief: clone(BRIEF) } });
    await tick(600);
    ok('the tier the caller named applies (best)', st().tier === 'best', st().tier);
    ok('choices set: cash, repair, best, 2 stories, 2 layers, chimney flashing', st().jobMode === 'cash' && st().workKind === 'repair' && st().measurements.stories === 2 && st().measurements.tearOffLayers === 2 && st().measurements.hasChimneyFlash === true,
      { jobMode: st().jobMode, workKind: st().workKind, m: st().measurements });
    const html = CP().panelHtml();
    ok('the panel shows a "from call" chip per choice, each with a clear (×) button', (html.match(/data-action="call-clear"/g) || []).length === 6 && CP().applied().length === 6 && /from call/i.test(html), CP().applied());
    ok('the panel shows the square-count words beside the area, labelled not typed in', /twenty-eight squares/.test(CP().sqftHintHtml()) && /not typed in/i.test(CP().sqftHintHtml()));
    ok('the panel says prices come from the price book and nothing saves until Save', /price book/i.test(html) && /Save/.test(html));
    ok('gutters (mentioned) shows as a note, not a setting', /Gutters mentioned/.test(html));
    // Design §5.1 wants a quote on each choice. P2 (lane dmmap): the chimney
    // and skylight chips now carry the words too (scope.mentionQuotes); a
    // mention with no words is a hint line and never switched on.
    const chimChip = (html.split('data-arg="hasChimneyFlash"')[0].split('<span class="v2-call-chip"').pop() || '');
    ok('a chip with the caller\'s words shows them, the chimney chip too', /title="“the best one you have”"/.test(html) && /title="“the flashing around the chimney”"/.test(chimChip), chimChip.slice(0, 160));
    ok('measurements and money untouched', moneySnapshot() === base3, [base3, moneySnapshot()]);
    ok('still no draft write after the full prefill', draftWrites().length === 0 && env.store[DRAFT_KEY] === undefined);

    // P2 integration: a walkthrough brief (callId visit_<visitId>) opens the
    // same strip, worded for the walkthrough (the sheet already is).
    W.openEstimateV2Builder({ leadId: 'L3' });
    await tick(450);
    W.openEstimateV2Builder({ leadId: 'L3', callPrefill: { callId: 'visit_vWalk0000001', brief: clone(BRIEF) } });
    await tick(600);
    const vh = CP().panelHtml();
    ok('P2 integration: a walkthrough\'s strip says "From the walkthrough" and "mentioned at the walkthrough", never "on the call"', /From the walkthrough/.test(vh) && /Gutters mentioned at the walkthrough/.test(vh) && !/on the call|From the call/.test(vh), vh.slice(0, 400));
    ok('…and its square-count words say "Said at the walkthrough"', /^Said at the walkthrough/.test(CP().sqftHintHtml()), CP().sqftHintHtml());
    const PFM = W.NBDEstimateCallPrefill;
    const noWords = { scope: { mentions: { chimney: true }, mentionQuotes: { chimney: '' } } };
    ok('…a walkthrough mention with no words says "mentioned at the walkthrough"', PFM && PFM.fromBrief(noWords, { visit: true }).hints.unsure.some((x) => /Chimney was mentioned at the walkthrough/.test(x)));
    ok('…a call\'s line is unchanged', PFM && PFM.fromBrief(noWords).hints.unsure.some((x) => /Chimney was mentioned on the call/.test(x)));
    const tpls = CP().templates();
    ok('repair call: the panel offers repair templates (JobTemplates.search, jobType repair)', tpls.length > 0 && tpls.every((t) => { const x = W.JobTemplates.get(t.id); return x && x.jobType === 'repair'; }), tpls);
    ok('…shown as buttons that insert on a tap', (CP().panelHtml().match(/data-action="call-template"/g) || []).length === tpls.length);
    // × on the tier chip puts "better" back.
    CP().clear('tier');
    ok('× on the tier chip → back to better, chip gone', st().tier === 'better' && !CP().applied().some((a) => a.key === 'tier'));
    // A template tap: the rep acts, so the builder may autosave from here on.
    const before = (st().scope || []).length;
    const r = CP().template(tpls[0].id);
    await tick(600);
    ok('a template tap goes through JobTemplates.insertIntoV2 and lands priced scope lines', (st().scope || []).length > before && r && r.added > 0, r);
    const est = V2._test.effectiveEstimate();
    ok('…the engine prices it (a total in dollars, money stays numeric)', est && typeof est.total === 'number' && est.total > 0, est && est.total);
    ok('after the rep\'s own tap the normal autosave resumes (their work is kept)', env.store[DRAFT_KEY] !== undefined);

    // Closing untouched puts every old value back.
    leads([{ id: 'L4', firstName: 'Kim', lastName: 'Fox', address: '4 Pine St', jobType: '' }]);
    W.openEstimateV2Builder({ leadId: 'L4' });
    await tick(450);
    const pre4 = JSON.stringify({ j: st().jobMode, t: st().tier, w: st().workKind, s: st().measurements.stories, l: st().measurements.tearOffLayers, c: st().measurements.hasChimneyFlash });
    writes.length = 0;
    try { delete env.store[DRAFT_KEY]; } catch (_) {}
    W.openEstimateV2Builder({ leadId: 'L4', callPrefill: { callId: 'cube_GHI', brief: clone(BRIEF) } });
    await tick(600);
    ok('(prefilled)', st().jobMode === 'cash' && st().tier === 'best');
    W.closeEstimateV2Builder();
    await tick(450);
    const post4 = JSON.stringify({ j: st().jobMode, t: st().tier, w: st().workKind, s: st().measurements.stories, l: st().measurements.tearOffLayers, c: st().measurements.hasChimneyFlash });
    ok('closed without touching anything → every value back as before', post4 === pre4, [pre4, post4]);
    ok('…and nothing was saved', draftWrites().length === 0 && env.store[DRAFT_KEY] === undefined);

    // The customer's own job type wins.
    leads([{ id: 'L5', firstName: 'Lee', lastName: 'Wu', address: '5 Ash St', jobType: 'insurance' }]);
    W.openEstimateV2Builder({ leadId: 'L5', callPrefill: { callId: 'cube_JKL', brief: clone(BRIEF) } });
    await tick(600);
    ok('the customer is an insurance job → the call\'s "cash" is not applied', st().jobMode === 'insurance' && !CP().applied().some((a) => a.key === 'jobMode'));
    W.closeEstimateV2Builder();

    // A plain open after a prefill: no panel, no leftover suppression.
    leads([{ id: 'L6', firstName: 'Ana', lastName: 'Diaz', address: '6 Elm St', jobType: '' }]);
    W.openEstimateV2Builder({ leadId: 'L6' });
    await tick(450);
    ok('a plain open shows no call panel and autosaves as before', CP().applied().length === 0 && env.store[DRAFT_KEY] !== undefined);

    section('C. the deep link from the customer page');
    // Kill switch (review 2026-11-09): the builder never reads the stored
    // brief itself. The brief arrives only from the sheet, which got it from
    // the callBrief callable (and that checks callBriefDisabled), handed over
    // in sessionStorage because the dashboard cleans its URL before the lazy
    // builder loads. A ?lead=&callBrief= URL alone prefills nothing.
    leads([{ id: 'L7', firstName: 'Jo', lastName: 'Kay', address: '7 Elm St', jobType: '' }]);
    docs['leads/L7/call_briefs/cube_MNO'] = { callId: 'cube_MNO', leadId: 'L7', brief: clone(BRIEF) };
    env.location.search = '?lead=L7&callBrief=cube_MNO';
    reads.length = 0; writes.length = 0;
    try { delete env.store[DRAFT_KEY]; } catch (_) {}
    W.openEstimateV2Builder({ leadId: 'L7' });   // exactly what the dashboard's ?lead= branch calls
    await tick(600);
    ok('a hand-typed ?lead=<id>&callBrief=<callId> alone reads no brief (the kill switch is only checked by the callable)', reads.length === 0, reads);
    ok('…and prefills nothing: a plain open, autosave as usual', st().workKind == null && CP().applied().length === 0 && env.store[DRAFT_KEY] !== undefined);
    W.closeEstimateV2Builder();
    env.location.search = '';

    // The customer page hands the brief the callable returned over in sessionStorage.
    leads([{ id: 'L8', firstName: 'Bo', lastName: 'Ng', address: '8 Elm St', jobType: '' }]);
    env.sstore['nbd.callBriefLink'] = JSON.stringify({ leadId: 'L8', callId: 'cube_PQR', brief: clone(BRIEF), at: Date.now() });
    reads.length = 0; writes.length = 0;
    try { delete env.store[DRAFT_KEY]; } catch (_) {}
    W.openEstimateV2Builder({ leadId: 'L8' });
    await tick(600);
    ok('the sessionStorage hand-off (brief included) prefills when the URL is already clean', st().workKind === 'repair' && st().jobMode === 'cash' && st().measurements.stories === 2);
    ok('…with no Firestore read', reads.length === 0, reads);
    ok('…without writing anything', writes.length === 0 && env.store[DRAFT_KEY] === undefined, writes.map((w) => w.path));
    ok('…and is used once (removed)', env.sstore['nbd.callBriefLink'] === undefined);
    W.closeEstimateV2Builder();

    leads([{ id: 'L9', firstName: 'Cy', lastName: 'Po', address: '9 Elm St', jobType: '' }]);
    env.sstore['nbd.callBriefLink'] = JSON.stringify({ leadId: 'L9', callId: 'cube_STU', brief: clone(BRIEF), at: Date.now() - 6 * 60 * 1000 });
    W.openEstimateV2Builder({ leadId: 'L9' });
    await tick(300);
    ok('a stale hand-off (over 5 minutes) is ignored', st().workKind == null && CP().applied().length === 0);
    W.closeEstimateV2Builder();
    leads([{ id: 'L10', firstName: 'Di', lastName: 'Ox', address: '10 Elm St', jobType: '' }]);
    env.sstore['nbd.callBriefLink'] = JSON.stringify({ leadId: 'L9', callId: 'cube_STU', brief: clone(BRIEF), at: Date.now() });
    W.openEstimateV2Builder({ leadId: 'L10' });
    await tick(300);
    ok('a hand-off for another customer is ignored', st().workKind == null && CP().applied().length === 0);
    W.closeEstimateV2Builder();
    leads([{ id: 'L11', firstName: 'Ed', lastName: 'Lu', address: '11 Elm St', jobType: '' }]);
    env.sstore['nbd.callBriefLink'] = JSON.stringify({ leadId: 'L11', callId: '../../users/jo', brief: clone(BRIEF), at: Date.now() });
    W.openEstimateV2Builder({ leadId: 'L11' });
    await tick(300);
    ok('a call id that is not an id (path tricks) is ignored', st().workKind == null && CP().applied().length === 0);
    W.closeEstimateV2Builder();
    leads([{ id: 'L12', firstName: 'Fa', lastName: 'Mo', address: '12 Elm St', jobType: '' }]);
    env.sstore['nbd.callBriefLink'] = JSON.stringify({ leadId: 'L12', callId: 'cube_VWX', brief: clone(BRIEF), at: Date.now() });
    env.location.search = '?lead=L12&callBrief=cube_OTHER';
    W.openEstimateV2Builder({ leadId: 'L12' });
    await tick(300);
    ok('a hand-off whose call is not the one in the URL is ignored', st().workKind == null && CP().applied().length === 0);
    env.location.search = '';
    W.closeEstimateV2Builder();
    leads([{ id: 'L12b', firstName: 'Ga', lastName: 'No', address: '12 Elm St', jobType: '' }]);
    env.sstore['nbd.callBriefLink'] = JSON.stringify({ leadId: 'L12b', callId: 'cube_YZA', at: Date.now() });
    try { delete env.store[DRAFT_KEY]; } catch (_) {}
    W.openEstimateV2Builder({ leadId: 'L12b' });
    await tick(600);
    ok('a hand-off with no brief → the builder opens as usual, and autosave is not held back', reads.length === 0 && CP().applied().length === 0 && env.store[DRAFT_KEY] !== undefined);
    W.closeEstimateV2Builder();

    section('C2. the brief lands after the rep has already acted (review 2026-11-09)');
    // The mapper loads (and the hand-off parses) asynchronously. A rep who
    // taps or types first has started their own estimate: the call's choices
    // are shown as suggestions only, never applied, so nothing the rep did
    // not tap reaches the drafts, and V3 is not re-opened under them.
    leads([{ id: 'L13', firstName: 'Hu', lastName: 'Ix', address: '13 Elm St', jobType: '' }]);
    W.openEstimateV2Builder({ leadId: 'L13' });
    await tick(450);
    const pre13 = JSON.stringify({ j: st().jobMode, t: st().tier, w: st().workKind, s: st().measurements.stories, l: st().measurements.tearOffLayers, c: st().measurements.hasChimneyFlash });
    const v3Opens = [];
    const prevV3 = W.EstimateV3;
    W.EstimateV3 = { onOpen: (o) => { v3Opens.push(o); } };
    W.openEstimateV2Builder({ leadId: 'L13', callPrefill: { callId: 'cube_LATE1', brief: clone(BRIEF) } });
    const opensAtOpen = v3Opens.length;
    ok('(test seam: the rep-acted hook exists)', typeof CP().acted === 'function' && typeof CP().suggested === 'function');
    if (typeof CP().acted === 'function') CP().acted();   // the rep taps before the brief lands
    await tick(600);
    const post13 = JSON.stringify({ j: st().jobMode, t: st().tier, w: st().workKind, s: st().measurements.stories, l: st().measurements.tearOffLayers, c: st().measurements.hasChimneyFlash });
    ok('a brief that lands after the rep acted changes nothing', post13 === pre13 && CP().applied().length === 0, [pre13, post13]);
    ok('…its choices are offered as suggestions, marked not filled in', typeof CP().suggested === 'function' && CP().suggested().length === 6 && /not filled in/i.test(CP().panelHtml()), typeof CP().suggested === 'function' ? CP().suggested() : null);
    ok('…and V3 is not re-opened over the rep\'s step', v3Opens.length === opensAtOpen, v3Opens);
    let saved13 = null;
    try { saved13 = JSON.parse(env.store[DRAFT_KEY] || 'null'); } catch (_) { saved13 = null; }
    ok('…so the draft the rep\'s own act saves holds none of the call\'s choices', !saved13 || (saved13.jobMode !== 'cash' && saved13.workKind !== 'repair'), saved13 && { jobMode: saved13.jobMode, workKind: saved13.workKind });
    W.EstimateV3 = prevV3;
    W.closeEstimateV2Builder();

    section('C3. a call tier that would switch the shingle line is not set (review 2026-11-09)');
    // setTierChoice runs _v2EnforceTierShingles: Beyond → HailGuard, Economy →
    // no 3-tab. On a same-customer reopen that already has a shingle line, a
    // call that says "beyond" would swap it, and neither × nor an untouched
    // close swaps it back. The call never sets the scope, so that tier is
    // offered, not set.
    leads([{ id: 'L14', firstName: 'Iv', lastName: 'Jo', address: '14 Elm St', jobType: '' }]);
    W.openEstimateV2Builder({ leadId: 'L14' });
    await tick(450);
    V2.addToScope('RFG 240-TAMKO-HERITAGE');
    await tick(450);
    const scope14 = JSON.stringify(st().scope);
    const tier14 = st().tier;
    ok('(a Heritage shingle line is in scope)', (st().scope || []).some((x) => x.code === 'RFG 240-TAMKO-HERITAGE'), st().scope);
    const beyond = clone(BRIEF); beyond.scope.tierInterest = { value: 'beyond', quote: 'the hail one' };
    W.openEstimateV2Builder({ leadId: 'L14', callPrefill: { callId: 'cube_BEY1', brief: beyond } });
    await tick(600);
    ok('the call\'s "beyond" is not set, and the shingle line is untouched', st().tier === tier14 && JSON.stringify(st().scope) === scope14 && !CP().applied().some((a) => a.key === 'tier'), { tier: st().tier, scope: st().scope });
    ok('…it is offered instead, with the reason', typeof CP().suggested === 'function' && CP().suggested().some((a) => a.key === 'tier' && a.to === 'beyond') && /shingle/i.test(CP().panelHtml()));
    ok('…the other choices still apply', st().jobMode === 'cash' && st().measurements.stories === 2);
    W.closeEstimateV2Builder();
    await tick(450);
    ok('closed untouched → the scope is exactly as before', JSON.stringify(st().scope) === scope14 && st().tier === tier14);
    W.openEstimateV2Builder({ leadId: 'L14', callPrefill: { callId: 'cube_BEY2', brief: clone(BRIEF) } });
    await tick(600);
    ok('a call tier that swaps nothing (best) still applies on the same scope', st().tier === 'best' && JSON.stringify(st().scope) === scope14);
    W.closeEstimateV2Builder();
    await tick(450);

    section('C4. an autosave still pending from before the open (review 2026-11-09)');
    // The rep edits, then (inside the 400 ms debounce) Start estimate opens
    // the builder for the same customer. The pending save must keep the
    // rep's state, not pick up the call's choices when it fires.
    leads([{ id: 'L15', firstName: 'Ka', lastName: 'Le', address: '15 Elm St', jobType: '' }]);
    W.openEstimateV2Builder({ leadId: 'L15' });
    await tick(450);
    try { delete env.store[DRAFT_KEY]; } catch (_) {}
    V2.addToScope('RFG 240-TAMKO-HERITAGE');   // queues the debounced autosave
    W.openEstimateV2Builder({ leadId: 'L15', callPrefill: { callId: 'cube_PEND1', brief: clone(BRIEF) } });
    await tick(600);
    let saved15 = null;
    try { saved15 = JSON.parse(env.store[DRAFT_KEY] || 'null'); } catch (_) { saved15 = null; }
    ok('(the call\'s choices did apply)', st().jobMode === 'cash' && st().workKind === 'repair');
    ok('the rep\'s pending edit is saved (the Heritage line)', !!saved15 && (saved15.scope || []).some((x) => x.code === 'RFG 240-TAMKO-HERITAGE'), saved15 && saved15.scope);
    ok('…from the state before the call\'s choices (no cash, no repair in the draft)', !!saved15 && saved15.jobMode !== 'cash' && saved15.workKind !== 'repair', saved15 && { jobMode: saved15.jobMode, workKind: saved15.workKind });
    W.closeEstimateV2Builder();
    await tick(450);

    section('C5. which taps count as the rep acting (review 2026-11-09)');
    // Moving around the builder (search, the presentation, the packet
    // choice) changes no estimate input, so it does not end the hold on autosave.
    const isAct = CP().isAct;
    ok('(test seam: the act test exists)', typeof isAct === 'function');
    if (typeof isAct === 'function') {
      const click = (act, attr) => ({ type: 'click', isTrusted: true, target: { closest: () => ({ getAttribute: (k) => (k === (attr || 'data-action') ? act : null) }) } });
      const typed = (action) => ({ type: 'input', isTrusted: true, target: { getAttribute: (k) => (k === 'data-action' ? action : null), closest: () => null } });
      const nav = ['present', 'pres-close', 'set-packet', 'toggle-packet-photo', 'set-category', 'mstep', 'next', 'back', 'close'];
      ok('navigation taps do not count: ' + nav.join(', '), nav.every((a) => isAct(click(a)) === false), nav.filter((a) => isAct(click(a))));
      ok('typing in (or tapping into) the catalog search does not count', isAct(click('search')) === false && isAct(typed('search')) === false && isAct(Object.assign(typed('search'), { type: 'change' })) === false);
      const acts = ['set-tier', 'set-job-mode', 'add-to-scope', 'call-clear', 'call-template', 'pres-tier', 'toggle-photo', 'open-job-templates', 'save'];
      ok('choices and edits do count: ' + acts.join(', '), acts.every((a) => isAct(click(a)) === true), acts.filter((a) => !isAct(click(a))));
      ok('typing in a measurement counts', isAct(typed(null)) === true);
      ok('a click with no action (a label, the backdrop) does not count', isAct({ type: 'click', isTrusted: true, target: { closest: () => null } }) === false);
      ok('a synthetic event never counts', isAct(Object.assign(click('set-tier'), { isTrusted: false })) === false);
    }

    section('C6. the said square count is tied to the area input (review 2026-11-09)');
    {
      const input = W.document.getElementById('v2rawSqft');
      const attrs = { 'aria-describedby': 'v2areaHelp' };
      const kids = [];
      input.setAttribute = (k, v) => { attrs[k] = String(v); };
      input.getAttribute = (k) => (k in attrs ? attrs[k] : null);
      input.removeAttribute = (k) => { delete attrs[k]; };
      input.parentNode = { appendChild: (x) => { kids.push(x); return x; } };
      leads([{ id: 'L16', firstName: 'Lo', lastName: 'Ma', address: '16 Elm St', jobType: '' }]);
      W.openEstimateV2Builder({ leadId: 'L16', callPrefill: { callId: 'cube_SQ1', brief: clone(BRIEF) } });
      await tick(600);
      const hintEl = kids.find((k) => k && k.id === 'v2callSqftHint');
      ok('the hint is placed beside #v2rawSqft', !!hintEl && /twenty-eight squares/.test(hintEl.innerHTML), kids.map((k) => k && k.id));
      ok('…and #v2rawSqft names it in aria-describedby (keeping what was there)', (attrs['aria-describedby'] || '').split(' ').sort().join(' ') === 'v2areaHelp v2callSqftHint', attrs);
      W.closeEstimateV2Builder();
      await tick(50);
      ok('closing takes it out of aria-describedby again', attrs['aria-describedby'] === 'v2areaHelp', attrs);
      input.parentNode = null;
    }

    section('C7. the strip on a phone (review 2026-11-09)');
    {
      // A fake modal that holds the strip, so _callPaint's real DOM path runs.
      const modal = W.document.getElementById('estV2Modal');
      let panel = null, collapsedByRep = null;
      const prevQS = modal.querySelector;
      modal.querySelector = (sel) => {
        if (sel === '.v2-hdr') return { after: (x) => { panel = x; x.querySelector = (q) => (q === 'details' && collapsedByRep !== null ? { open: !collapsedByRep } : null); } };
        if (sel === '#v2callPanel') return panel;
        return null;
      };
      const isOpen = () => !!panel && /<details class="v2-call" open>/.test(panel.innerHTML);
      const prevMM = W.matchMedia;
      W.matchMedia = () => ({ matches: true });   // a phone
      try { delete env.store['nbd.callStripSeen']; } catch (_) {}
      leads([{ id: 'L17', firstName: 'Mo', lastName: 'Ni', address: '17 Elm St', jobType: '' }]);
      W.openEstimateV2Builder({ leadId: 'L17', callPrefill: { callId: 'cube_PH1', brief: clone(BRIEF) } });
      await tick(600);
      ok('phone, first time: the strip opens expanded', isOpen(), panel && panel.innerHTML.slice(0, 80));
      W.closeEstimateV2Builder(); panel = null; collapsedByRep = null;
      W.openEstimateV2Builder({ leadId: 'L17', callPrefill: { callId: 'cube_PH2', brief: clone(BRIEF) } });
      await tick(600);
      ok('phone, after the first view: the strip starts collapsed (the summary still shows the count)', !!panel && !isOpen() && /choices filled in/.test(panel.innerHTML), panel && panel.innerHTML.slice(0, 80));
      W.closeEstimateV2Builder(); panel = null; collapsedByRep = null;
      W.matchMedia = () => ({ matches: false });   // a desktop
      W.openEstimateV2Builder({ leadId: 'L17', callPrefill: { callId: 'cube_PH3', brief: clone(BRIEF) } });
      await tick(600);
      ok('desktop: the strip opens expanded', isOpen());
      collapsedByRep = true;   // the rep folds it, then taps × on a chip
      CP().clear('stories');
      ok('a repaint keeps the strip the way the rep left it (folded)', !!panel && !isOpen());
      W.closeEstimateV2Builder(); panel = null; collapsedByRep = null;
      W.matchMedia = prevMM;
      modal.querySelector = prevQS;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  section('D. the sheet: Start estimate (call-brief-ui.js)');
  // ════════════════════════════════════════════════════════════════════
  {
    const SRC = read('docs/pro/js/call-brief-ui.js');
    function load(o) {
      const listeners = {};
      const dlgEl = {
        className: '', innerHTML: '', open: false, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'open') this.open = false; },
        addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
        showModal() { this.open = true; }, close() { this.open = false; (listeners.close || []).forEach((f) => f()); },
        contains() { return true; }, querySelector() { return null; },
      };
      const body = { kids: [], appendChild(x) { this.kids.push(x); }, contains(x) { return this.kids.includes(x); } };
      const calls = [];
      const sstore = {};
      const win = {
        ScriptLoader: { load: async () => {}, loadBundle: async () => {} },
        _functions: {}, _httpsCallable: (_f, name) => async (data) => {
          calls.push({ name, data });
          if (o && o.decideFails && name === 'callBriefDecide') { const e = new Error(o.decideFails.message); e.code = o.decideFails.code; throw e; }
          return { data: { ok: true } };
        },
        auth: { currentUser: { uid: 'jo' } },
        location: { href: '/pro/customer.html?id=L1', pathname: (o && o.path) || '/pro/customer.html' },
        sessionStorage: { getItem: (k) => sstore[k] || null, setItem: (k, v) => { sstore[k] = String(v); }, removeItem: (k) => { delete sstore[k]; } },
      };
      const opened = [];
      if (o && o.builder) win.openEstimateV2Builder = (x) => { opened.push(x); };
      const ctx = vm.createContext({ window: win, location: win.location, sessionStorage: win.sessionStorage, document: { createElement: () => dlgEl, body, querySelector: () => null }, console, setTimeout, Date, Event: function () {} });
      vm.runInContext(SRC, ctx);
      const click = async (attrs) => {
        const b = { getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false, closest: () => b };
        for (const fn of listeners.click) fn({ target: b });
        await tick(5);
      };
      return { CB: win.NBDCallBrief, dlg: dlgEl, calls, win, opened, sstore, click };
    }
    const CALL = { startedAtMs: Date.parse('2026-11-05T15:00:00Z'), durationSec: 200, attachedBy: 'jo', leadId: 'L1' };
    const LEAD = { firstName: 'Pat', lastName: 'Lee', scopeOfWork: '' };
    {
      const t = load({ builder: true, path: '/pro/dashboard.html' });
      t.CB._showWith({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: LEAD, leadId: 'L1', page: 'calls' });
      const html = t.CB._render();
      const drafts = (html.split('id="cbDraftH"')[1] || '').split('cb-foot')[0];
      ok('a repair call: "Start repair quote" in the drafts card', /data-cb-act="estimate"/.test(drafts) && /Start repair quote/.test(drafts), drafts.slice(0, 400));
      ok('…it says the choices come from the call and prices from the price book, nothing saved', /price book/i.test(drafts) && /nothing is saved/i.test(drafts));
      await t.click({ 'data-cb-act': 'estimate' });
      ok('on the dashboard it opens the builder with the brief as the prefill', t.opened.length === 1 && t.opened[0].leadId === 'L1' && t.opened[0].callPrefill && t.opened[0].callPrefill.callId === 'cube_ABCDE12345' && t.opened[0].callPrefill.brief && t.opened[0].callPrefill.brief.fields.workKind.value === 'repair', t.opened);
      ok('…and logs the tap (callBriefDecide draft:estimate)', t.calls.some((c) => c.name === 'callBriefDecide' && c.data.item === 'draft:estimate' && c.data.decision === 'accept'));
      const logged = t.calls.find((c) => c.name === 'callBriefDecide' && c.data.item === 'draft:estimate');
      ok('…logged as the tap it is, not as "opened the estimate builder" (the open happens after)', logged && /tapped/i.test(logged.data.value) && !/opened/i.test(logged.data.value), logged && logged.data.value);
      ok('…and the sheet closes', t.dlg.open === false);
    }
    {
      const t = load({ builder: false, path: '/pro/customer.html' });
      const rb = clone(REPLACE);
      t.CB._showWith({ callId: 'cube_ABCDE12345', brief: rb, call: CALL, lead: LEAD, leadId: 'L1', page: 'customer' });
      const html = t.CB._render();
      const drafts = (html.split('id="cbDraftH"')[1] || '').split('cb-foot')[0];
      ok('a replacement call on the customer page: "Start estimate"', /data-cb-act="estimate"/.test(drafts) && /Start estimate/.test(drafts) && !/Start repair quote/.test(drafts));
      ok('the customer page keeps one filled button (Draft proposal); Start estimate is quiet', (drafts.match(/btn-orange/g) || []).length === 1 && /btn-ghost" data-cb-act="estimate"/.test(drafts), drafts.slice(0, 600));
      await t.click({ 'data-cb-act': 'estimate' });
      ok('on the customer page it goes to the dashboard deep link ?lead=<id>&callBrief=<callId>', t.win.location.href === '/pro/dashboard.html?lead=L1&callBrief=cube_ABCDE12345', t.win.location.href);
      const hand = JSON.parse(t.sstore['nbd.callBriefLink'] || 'null');
      ok('…and hands the same pair over in sessionStorage (the dashboard cleans its URL first)', hand && hand.leadId === 'L1' && hand.callId === 'cube_ABCDE12345' && Math.abs(Date.now() - hand.at) < 5000, hand);
      ok('…with the brief the callable returned (the builder never reads the stored brief itself)', hand && hand.brief && hand.brief.fields && hand.brief.fields.workKind.value === 'replace', hand && Object.keys(hand));
    }
    {
      // Call briefs switched off after the sheet showed the brief: the log
      // callable refuses (it checks callBriefDisabled), so nothing opens.
      const t = load({ builder: true, path: '/pro/dashboard.html', decideFails: { code: 'functions/failed-precondition', message: 'Call briefs are switched off right now.' } });
      t.CB._showWith({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: LEAD, leadId: 'L1', page: 'calls' });
      await t.click({ 'data-cb-act': 'estimate' });
      ok('switched off: Start estimate opens nothing and the sheet stays open with the reason', t.opened.length === 0 && t.dlg.open === true && /switched off/.test(t.CB._render()), t.opened);
      const c = load({ builder: false, path: '/pro/customer.html', decideFails: { code: 'functions/failed-precondition', message: 'Call briefs are switched off right now.' } });
      c.CB._showWith({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: LEAD, leadId: 'L1', page: 'customer' });
      await c.click({ 'data-cb-act': 'estimate' });
      ok('switched off on the customer page: no deep link and no hand-off', c.win.location.href === '/pro/customer.html?id=L1' && !c.sstore['nbd.callBriefLink']);
      const n = load({ builder: true, path: '/pro/dashboard.html', decideFails: { code: 'functions/unavailable', message: 'network' } });
      n.CB._showWith({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: LEAD, leadId: 'L1', page: 'calls' });
      await n.click({ 'data-cb-act': 'estimate' });
      ok('a log that fails for another reason (network) still opens the builder (the log is best effort)', n.opened.length === 1);
    }
    {
      const t = load({ builder: true });
      const b = clone(BRIEF); b.transcriptOk.reliable = false;
      t.CB._showWith({ callId: 'cube_ABCDE12345', brief: b, call: CALL, lead: LEAD, leadId: 'L1', page: 'calls' });
      ok('an unreliable brief offers no Start estimate', !/data-cb-act="estimate"/.test(t.CB._render()));
    }
    {
      const t = load({ builder: true });
      const b = clone(BRIEF); b.fields.workKind = { value: '"><img src=x onerror=alert(1)>', quote: 'x' };
      t.CB._showWith({ callId: 'cube_ABCDE12345', brief: b, call: CALL, lead: LEAD, leadId: 'L1', page: 'calls' });
      const h = t.CB._render();
      ok('the button label is fixed text (no model words reach it)', !/<img/.test(h) && /Start estimate/.test(h));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  section('E. boot, CSP, held files, the server log');
  // ════════════════════════════════════════════════════════════════════
  {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
      ok(page + ' has no <script> tag for estimate-call-prefill.js', !/estimate-call-prefill/.test(read(page)));
    }
    const loader = read('docs/pro/js/script-loader.js');
    ok('not in any ScriptLoader bundle (loaded only on a call prefill)', !/estimate-call-prefill/.test(loader));
    ok('the mapper has no DOM, no Firestore, no fetch', SRC_PREFILL && !/document\.|getDoc|setDoc|fetch\(|XMLHttpRequest/.test(strip(SRC_PREFILL)));
    const v2 = read('docs/pro/js/estimate-v2-ui.js');
    const callBlock = (v2.split('CALL TO CLOSE P1')[1] || '').split('KENTUCKY SIGNING GATE')[0] || '';
    ok('the builder\'s call-prefill block exists', callBlock.length > 500);
    ok('…never assigns rawSqft, a price, the claim money or the scope', !/rawSqft\s*=|\.rawSqft\]?\s*=|claim\.(deductible|acv)\s*=|\.total\s*=|minJobCharge\s*=|passThru\s*=|scope\.push|scope\s*=/.test(strip(callBlock)), (strip(callBlock).match(/rawSqft\s*=|claim\.(deductible|acv)\s*=|\.total\s*=|minJobCharge\s*=|scope\.push|scope\s*=/) || [])[0]);
    ok('…never reads or writes Firestore itself (the brief comes from the callable, through the sheet)', !/getDoc|setDoc|updateDoc|addDoc|deleteDoc|pushDraftToFirestore|call_briefs/.test(strip(callBlock)));
    ok('…inserts templates only through JobTemplates.insertIntoV2', /insertIntoV2\(/.test(callBlock));
    ok('…escapes what it shows', /_callEsc\(/.test(callBlock) && !/innerHTML\s*=\s*[^;]*\+\s*(it|h|q)\.(quote|label|name)\b/.test(callBlock));
    ok('no style= attribute and no inline handler added', !/\sstyle=/.test(callBlock) && !/\son[a-z]+=\\?["']/i.test(callBlock));
    ok('the folded strip shows it can open (a chevron on the summary, which display:flex strips of its marker)', /\.v2-call summary::after\s*\{[^}]*content:/.test(v2) && /\.v2-call\[open\] summary::after\s*\{[^}]*content:/.test(v2));
    // Review 2026-11-09 (builder-2-strip-open-desktop): in the V3 wizard the
    // step body is a centred 560 px column, so a full-width strip sat apart
    // from the builder at desktop width. It takes the same column.
    const v3 = read('docs/pro/js/estimate-v3-wizard.js');
    const bodyW = (v3.match(/#estV2Modal\.v3-on \.v2-body \{[^}]*max-width:(\d+)px; margin:0 auto/) || [])[1];
    const stripRule = (v2.match(/#estV2Modal\.v3-on \.v2-call-wrap \{([^}]*)\}/) || [])[1] || '';
    ok('in the V3 wizard the strip takes the step body\'s centred column', !!bodyW && new RegExp('max-width:' + bodyW + 'px').test(stripRule) && /margin:0 auto/.test(stripRule) && /box-sizing:border-box/.test(stripRule), { bodyW, stripRule });
    const ui = read('docs/pro/js/call-brief-ui.js');
    ok('the sheet links to the dashboard\'s ?lead= branch (dashboard-bootstrap.module.js stays held)', /\/pro\/dashboard\.html\?lead=' \+ encodeURIComponent\(leadId\) \+ '&callBrief=' \+ encodeURIComponent\(callId\)/.test(ui));
    const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
    ok('the held bootstrap still opens the builder for ?lead= (the hook this relies on)', /window\.openEstimateV2Builder\(leadParam \? \{ leadId: leadParam \} : \{\}\)/.test(boot));
    const cb = read('functions/call-brief.js');
    ok('callBriefDecide accepts the draft:estimate log item', /draft:proposal\|draft:estimate|draft:\((?:[A-Za-z]+\|)*estimate[|)]/.test(cb));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
