/**
 * tests/pl-f21-2026-11-08.test.js — the kanban bulk bar speaks the tenant's
 * pipeline (CRM audit 2026-11-06, PL-F21).
 *
 * THE BUG (three faces of one bar, crm-portal-bridge.js + dashboard.html):
 *   1. bulkMoveStage's confirm read `Move 2 lead(s) to "estimate_submitted"?`:
 *      the stage KEY, though the label was computed two lines later.
 *   2. #bulkStageSelect said "Populated dynamically" but nothing populated it:
 *      nine hard-coded built-in stages, so a tenant's custom stage could not
 *      be bulk-set, a renamed stage showed its old name, a hidden one stayed.
 *   3. #bulkJobTypeSelect offered insurance / cash / finance only; warranty and
 *      service (JOB_TYPES in crm-stages.js) could not be bulk-set.
 *
 * THE FIX: the confirm names the stage by its label; entering bulk mode
 * rebuilds the stage options from window.STAGE_META (tenant-resolved by
 * applyPipelineConfig: labels, custom stages, hidden stages left out), in the
 * current board's column order (window._stageKeys) once a board has rendered,
 * keeping the markup's static options when STAGE_META is absent; the job type
 * select lists every JOB_TYPES value.
 *
 * Runs the REAL crm-portal-bridge.js in a vm with a small fake DOM, and reads
 * the real dashboard.html / crm-stages.js. Zero deps.
 * Run: node tests/pl-f21-2026-11-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const BRIDGE = read('docs/pro/js/crm-portal-bridge.js');
const HTML = read('docs/pro/dashboard.html');
const STAGES = read('docs/pro/js/crm-stages.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}

// The option list of one <select id="…"> in the real markup.
function selectOptions(id) {
  const m = HTML.match(new RegExp('<select[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)</select>'));
  if (!m) return null;
  return [...m[1].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((x) => [x[1], x[2]]);
}

// A fake <select>: options, value (falls back to '' like a real one), the
// HTMLSelectElement remove(index) / add(option) and Node appendChild.
function fakeSelect(pairs) {
  return {
    children: pairs.map(([v, t]) => ({ tagName: 'OPTION', value: v, textContent: t })),
    _v: '',
    get options() { return this.children; },
    get length() { return this.children.length; },
    get value() { return this._v; },
    set value(v) { this._v = this.children.some((o) => o.value === String(v)) ? String(v) : ''; },
    remove(i) { if (typeof i === 'number') this.children.splice(i, 1); },
    add(o) { this.children.push(o); },
    appendChild(o) { this.children.push(o); return o; },
  };
}
const cls = () => ({ add() {}, remove() {}, toggle() {}, contains() { return false; } });

function boot(win) {
  const els = {
    bulkStageSelect: fakeSelect(selectOptions('bulkStageSelect') || []),
    bulkModeBtn: { textContent: 'Select', classList: cls() },
    bulkActionBar: { classList: cls(), style: {} },
    bulkSelectedCount: { textContent: '' },
  };
  const toasts = [], asked = [], moved = [];
  win.nbdConfirm = async (m) => { asked.push(String(m)); return true; };
  const ctx = vm.createContext({
    window: win,
    console: { warn() {}, error() {}, log() {} },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => ({ tagName: String(tag).toUpperCase(), value: '', textContent: '' }),
    },
    showToast: (m, t) => toasts.push({ m: String(m), t }),
    moveCard: async (id, s) => { moved.push([id, s]); return true; },
  });
  vm.runInContext(BRIDGE, ctx, { filename: 'crm-portal-bridge.js' });
  return { ctx, els, toasts, asked, moved, reg: win.__NBD_CALL_REGISTRY || {} };
}

// A tenant-resolved STAGE_META, the shape applyPipelineConfig leaves on window:
// a renamed built-in, a hidden built-in, a custom stage, a hidden custom stage.
function tenantMeta() {
  return {
    new: { label: 'New Lead' },
    contacted: { label: 'Contacted', hidden: true },
    inspected: { label: 'Inspected' },
    estimate_submitted: { label: 'Proposal Out' },
    contract_signed: { label: 'Contract Signed' },
    warranty_scheduled: { label: 'Warranty Visit' },
    lost: { label: 'Lost' },
    custom_roof_walk: { label: 'Roof Walk <b>2</b>', custom: true, role: 'active' },
    custom_parked: { label: 'Parked', custom: true, role: 'active', hidden: true },
  };
}
const labelFrom = (meta) => (k) => (meta[k] || {}).label || k;

(async () => {
  console.log('\nPL-F21 — the confirm names the stage, not its key');
  {
    const meta = tenantMeta();
    const win = { STAGE_META: meta, stageLabel: labelFrom(meta), normalizeStage: (s) => String(s), _leads: [{ id: 'A', stage: 'new' }, { id: 'B', stage: 'new' }] };
    const r = boot(win);
    ok('control: the real module ran and registered bulkMoveStage', typeof r.reg.bulkMoveStage === 'function');
    win._bulkSelected = new Set(['A', 'B']);
    r.els.bulkStageSelect.children.push({ tagName: 'OPTION', value: 'estimate_submitted', textContent: 'x' });
    r.els.bulkStageSelect.value = 'estimate_submitted';
    await r.reg.bulkMoveStage();
    const q = r.asked[0] || '';
    ok('the confirm asks to move to "Proposal Out" (the tenant\'s label)', /Move 2 lead\(s\) to "Proposal Out"\?/.test(q), q);
    ok('…and never shows the raw key', !/estimate_submitted/.test(q), q);
    ok('control: the move still went to the KEY', r.moved.length === 2 && r.moved.every((x) => x[1] === 'estimate_submitted'), JSON.stringify(r.moved));
  }
  {
    const win = { _leads: [{ id: 'A', stage: 'new' }] };   // no stage engine on window
    const r = boot(win);
    win._bulkSelected = new Set(['A']);
    r.els.bulkStageSelect.value = 'contacted';
    await r.reg.bulkMoveStage();
    ok('without window.stageLabel the confirm falls back to the key (no throw)', /to "contacted"\?/.test(r.asked[0] || ''), r.asked[0]);
  }

  console.log('\nPL-F21 — entering bulk mode fills the stage list from the tenant pipeline');
  {
    const meta = tenantMeta();
    const win = { STAGE_META: meta };
    const r = boot(win);
    ok('control: toggleBulkMode is registered', typeof r.reg.toggleBulkMode === 'function');
    r.reg.toggleBulkMode();                       // enter bulk mode
    const opts = r.els.bulkStageSelect.options.map((o) => [o.value, o.textContent]);
    const vals = opts.map((o) => o[0]);
    ok('the placeholder stays first', opts[0] && opts[0][0] === '' && /Move to stage/.test(opts[0][1]), JSON.stringify(opts[0]));
    ok('a custom stage is offered, by its label (as text, never markup)', opts.some((o) => o[0] === 'custom_roof_walk' && o[1] === 'Roof Walk <b>2</b>'), JSON.stringify(opts));
    ok('a renamed built-in shows the tenant\'s label', opts.some((o) => o[0] === 'estimate_submitted' && o[1] === 'Proposal Out'), JSON.stringify(opts));
    ok('hidden stages (built-in and custom) are left out', !vals.includes('contacted') && !vals.includes('custom_parked'), vals.join());
    ok('every visible STAGE_META stage is offered once, in pipeline order',
      JSON.stringify(vals.slice(1)) === JSON.stringify(Object.keys(meta).filter((k) => !meta[k].hidden)), vals.join());
    ok('nothing from the static fallback list is left behind', !vals.includes('claim_filed') && !vals.includes('install_in_progress'), vals.join());

    // A pick survives leaving and re-entering bulk mode (no rebuild reset).
    r.els.bulkStageSelect.value = 'custom_roof_walk';
    r.reg.toggleBulkMode();                       // exit
    r.reg.toggleBulkMode();                       // enter again
    ok('a stage already picked stays picked across a rebuild', r.els.bulkStageSelect.value === 'custom_roof_walk', r.els.bulkStageSelect.value);
    ok('…and the rebuild does not duplicate options', r.els.bulkStageSelect.options.length === vals.length, r.els.bulkStageSelect.options.length + ' vs ' + vals.length);
    meta.custom_roof_walk.hidden = true;          // the tenant hides it meanwhile
    r.reg.toggleBulkMode(); r.reg.toggleBulkMode();
    ok('a picked stage that became hidden resets to the placeholder', r.els.bulkStageSelect.value === '' && !r.els.bulkStageSelect.options.some((o) => o.value === 'custom_roof_walk'), r.els.bulkStageSelect.value);
  }
  {
    // A rendered board: the list is that board's columns, in column order,
    // not every stage the tenant has (the Ins board is 14 columns, the whole
    // built-in pipeline 33).
    const meta = tenantMeta();
    const win = { STAGE_META: meta, _stageKeys: ['new', 'contacted', 'custom_roof_walk', 'estimate_submitted', 'lost', 'new'] };
    const r = boot(win);
    r.reg.toggleBulkMode();
    const vals = r.els.bulkStageSelect.options.map((o) => o.value).slice(1);
    ok('with a rendered board the list is its columns, in board order, each once',
      JSON.stringify(vals) === JSON.stringify(['new', 'custom_roof_walk', 'estimate_submitted', 'lost']), vals.join());
    ok('…a stage that is not a column on this board is not offered', !vals.includes('inspected') && !vals.includes('warranty_scheduled'), vals.join());
    ok('…and a hidden column stays out', !vals.includes('contacted'), vals.join());
    win._stageKeys = [];
    r.reg.toggleBulkMode(); r.reg.toggleBulkMode();
    const all = r.els.bulkStageSelect.options.map((o) => o.value).slice(1);
    ok('an empty board key list falls back to every visible stage', JSON.stringify(all) === JSON.stringify(Object.keys(meta).filter((k) => !meta[k].hidden)), all.join());
  }
  {
    const win = {};                               // STAGE_META absent (engine not loaded)
    const r = boot(win);
    const before = JSON.stringify(r.els.bulkStageSelect.options.map((o) => [o.value, o.textContent]));
    r.reg.toggleBulkMode();
    const after = JSON.stringify(r.els.bulkStageSelect.options.map((o) => [o.value, o.textContent]));
    ok('without STAGE_META the markup\'s static options are kept as they are', before === after && JSON.parse(after).length >= 9, after);
    const win2 = { STAGE_META: {} };
    const r2 = boot(win2);
    r2.reg.toggleBulkMode();
    ok('an empty STAGE_META also keeps the static options', r2.els.bulkStageSelect.options.length === JSON.parse(before).length);
  }

  console.log('\nPL-F21 — the job type list is every JOB_TYPES value');
  {
    const jt = STAGES.match(/export const JOB_TYPES = \{([\s\S]*?)\};/);
    const types = jt ? [...jt[1].matchAll(/:\s*'([a-z_]+)'/g)].map((x) => x[1]) : [];
    const metaBlock = (STAGES.match(/export const JOB_TYPE_META = \{([\s\S]*?)\n\};/) || [])[1] || '';
    const label = (t) => ((metaBlock.match(new RegExp('\\b' + t + ":\\s*\\{\\s*label:\\s*'([^']+)'")) || [])[1]);
    ok('control: JOB_TYPES parsed from crm-stages.js (5 types incl. warranty/service)', types.length === 5 && types.includes('warranty') && types.includes('service'), types.join());
    const opts = (selectOptions('bulkJobTypeSelect') || []).filter((o) => o[0]);
    ok('#bulkJobTypeSelect offers exactly the JOB_TYPES values', JSON.stringify(opts.map((o) => o[0]).sort()) === JSON.stringify(types.slice().sort()), JSON.stringify(opts));
    ok('…each with its JOB_TYPE_META label', opts.length > 0 && opts.every((o) => label(o[0]) === o[1]), JSON.stringify(opts));
  }
  {
    const pairs = selectOptions('bulkStageSelect') || [];
    ok('control: the static stage fallback is still in the markup (9 stages + placeholder)', pairs.length === 10 && pairs[0][0] === '', pairs.length);
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
