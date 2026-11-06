/**
 * tests/edit-lead-keeps-stored-fields-2026-11-06.test.js
 *
 * CRM audit 2026-11-06 — PL-F01 and PL-F06 (data integrity).
 *
 * PL-F01: the Edit Lead modal's saveLead() (docs/pro/js/crm-leads.js) always put
 * yearBuilt / marketValue / lastSaleDate / lastSaleAmt / propertyType / parcelId
 * (null), isLLC / homestead (false), parcel (null) and d2dKnockId (null) in the
 * payload, filled from window._modalIntel / window._pendingD2DConvertId. Those
 * are only set by a Pull Property Intel lookup or a D2D conversion in the SAME
 * modal session, and _saveLead spreads the payload into updateDoc — so every
 * ordinary edit erased the stored property intel, the parcel polygon and the
 * door-knock link (which analytics-kpi.js uses to credit reps).
 * Fix: omit-when-unknown, the rule `trades` and `stage` already follow.
 *
 * PL-F06: closing the modal without saving left window._pendingD2DConvertId
 * armed, so the next lead saved inherited that knock. Fix: _leadModalReset
 * clears it, like the pending map pin.
 *
 * Runs the REAL crm-leads.js in a vm context (same harness shape as
 * tests/edit-lead-stage-write-2026-09-28.test.js). Break-test: against main the
 * "omitted" and "cleared" cases go red; the positive controls stay green.
 *
 * Zero deps. Run: node tests/edit-lead-keeps-stored-fields-2026-11-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LEADS_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/crm-leads.js'), 'utf8');
const STAGE_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/stage-write.js'), 'utf8');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const INTEL_KEYS = ['yearBuilt', 'marketValue', 'lastSaleDate', 'lastSaleAmt', 'propertyType', 'parcelId', 'isLLC', 'homestead'];

function makeSandbox(opts) {
  const el = (v) => ({ value: v, checked: false, style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {} },
    options: [], focus() {}, scrollIntoView() {}, addEventListener() {}, querySelectorAll: () => [] });
  const fields = { lFname: el('Test'), lAddr: el('100 Test St'), lEditId: el(opts.editId || ''), lStage: el('new'), lJobType: el('insurance') };
  const shared = {};
  const document = {
    getElementById: (id) => fields[id] || shared[id] || (shared[id] = el('')),
    querySelector: (sel) => (sel === '#leadModal .msave' ? (shared.__btn = shared.__btn || { disabled: false, textContent: 'Save' }) : null),
    querySelectorAll: () => [],
    addEventListener() {}, dispatchEvent() {},
  };
  const rec = { saved: [] };
  const win = {
    db: {}, updateDoc: async () => {}, deleteDoc() {}, getDoc() {}, getDocs() {}, where() {}, orderBy() {}, query() {},
    doc: (db, col, id) => col + '/' + id, collection: (db, name) => name,
    addDoc: async () => ({ id: 'n1' }), serverTimestamp: () => 'SERVER_TS', arrayUnion: (x) => ({ arrayUnion: x }),
    runTransaction: async (db, fn) => fn({ get: async () => ({ exists: () => true, data: () => ({ stage: 'new' }) }), update() {} }),
    stageRole: () => 'active', normalizeStage: (s) => s, missingRequiredFields: () => [], requiredFieldLabel: (f) => f,
    _leads: opts.editId ? [{ id: opts.editId, stage: 'new', jobType: 'insurance' }] : [],
    _currentUser: { email: 'rep@example.test' },
    _saveLead: async (data) => { rec.saved.push(data); return data.id || 'new-id'; },
    _modalIntel: opts.intel || null,
    _pendingD2DConvertId: opts.knock || null,
  };
  const sandbox = { window: win, document, console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, CustomEvent: function () {}, showToast() {} };
  vm.createContext(sandbox);
  vm.runInContext(STAGE_SRC.replace(/^export\s+/gm, '') + '\nglobalThis.__stageWrite = { commitStageChange };', sandbox, { filename: 'stage-write.js' });
  vm.runInContext(LEADS_SRC.split("import('./stage-write.js')").join('Promise.resolve(globalThis.__stageWrite)'), sandbox, { filename: 'crm-leads.js' });
  return { sandbox, win, rec };
}

async function save(opts) {
  const s = makeSandbox(opts);
  await s.sandbox.saveLead();
  return s.rec.saved[0];
}

(async () => {
  console.log('EDIT LEAD — stored property intel, parcel and knock link survive an ordinary edit (PL-F01)');
  {
    const p = await save({ editId: 'lead-1' });
    assert('the edit saved (positive control)', !!p && p.firstName === 'Test' && p.address === '100 Test St');
    const present = INTEL_KEYS.filter((k) => p && k in p);
    assert('no property-intel key is written when no lookup ran', p && present.length === 0, 'written: ' + present.join(','));
    assert('no parcel key is written without a parcel polygon', p && !('parcel' in p));
    assert('no d2dKnockId key is written without a pending conversion', p && !('d2dKnockId' in p));
  }
  {
    const intel = { yearBuilt: 1994, marketValue: 210000, parcelId: 'TEST-PARCEL-1', isLLC: false, homestead: true,
      parcelGeometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] }, parcelCenter: { lat: 1, lng: 2 } };
    const p = await save({ editId: 'lead-1', intel });
    assert('a lookup in this session IS written (yearBuilt, parcelId, homestead)', p && p.yearBuilt === 1994 && p.parcelId === 'TEST-PARCEL-1' && p.homestead === true);
    assert('…absent lookup fields still go as null (unchanged behaviour)', p && p.lastSaleDate === null && p.propertyType === null);
    assert('…and the parcel polygon is stamped', p && p.parcel && p.parcel.source === 'regrid' && p.parcel.geometry.type === 'Polygon');
  }
  {
    const p = await save({ editId: '', knock: 'knock-123' });
    assert('a pending D2D conversion still links its knock', p && p.d2dKnockId === 'knock-123');
  }
  {
    const p = await save({ editId: '' });
    assert('a brand-new lead with no lookup carries no intel/parcel/knock keys', p && INTEL_KEYS.concat(['parcel', 'd2dKnockId']).every((k) => !(k in p)));
  }

  console.log('LEAD MODAL — dismissing clears an abandoned D2D conversion (PL-F06)');
  {
    const s = makeSandbox({ knock: 'knock-abandoned' });
    assert('the pending knock is armed before dismiss (positive control)', s.win._pendingD2DConvertId === 'knock-abandoned');
    s.sandbox.closeLeadModal();
    assert('closeLeadModal clears window._pendingD2DConvertId', s.win._pendingD2DConvertId === null, String(s.win._pendingD2DConvertId));
    assert('…alongside the pending map pin it already cleared', s.win._pendingPinId === null);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
