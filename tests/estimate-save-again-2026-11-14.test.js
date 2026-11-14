#!/usr/bin/env node
/**
 * tests/estimate-save-again-2026-11-14.test.js — "Save Again" on the V2
 * estimate builder UPDATES the estimate; "Save as copy" makes the duplicate.
 *
 * The bug: after the first save, the button read "✓ Saved — Save Again?",
 * but window._saveEstimate clears window._editingEstimateId after an update
 * and a fresh estimate never had one, so every later tap went down the
 * CREATE branch: a second estimate on the customer each time, and (because
 * the lead now had a primary estimate) "Use this new estimate's $X instead?"
 * Jo's decision (2026-11-14): Save Again updates the same estimate; a
 * separate "Save as copy" action makes a duplicate when one is wanted.
 *
 *   A. Fresh estimate: Save, Save again → one create, then an update of THAT
 *      estimate; the edit id never leaks past the save.
 *   B. "Save as copy" → a new estimate; Save after it updates the COPY.
 *   C. A reopened estimate: Save, Save again → both update it; Save as copy
 *      leaves it alone.
 *   D. Signed / out for signature since the save → Save again refuses with a
 *      message naming Save as copy, writes nothing; Save as copy still works.
 *   E. Changed on another device since the save → asks before overwriting;
 *      "no" writes nothing, "yes" updates.
 *   F. Gone from the list (archived elsewhere) → saved as a new estimate,
 *      never written onto the archived one, and the rep is told.
 *   G. Markup + wiring: a CSP-safe data-action button, hidden until there is
 *      a saved estimate, placed by the V3 wizard.
 *
 * Behaviour, not source shape (except G): estimate-v2-ui.js runs in a vm with
 * a fake _saveEstimate that mirrors the real one's create / update split.
 * Run: node tests/estimate-save-again-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
async function asection(title, fn) {
  console.log(title);
  try { await fn(); } catch (e) { ok(title + ' — ran', false, e && e.stack); }
}

function fakeEl(id) {
  const cls = new Set();
  return {
    id, textContent: '', innerHTML: '', hidden: false, disabled: false, style: {}, value: '',
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
    },
  };
}
function fakeDoc(ids) {
  const els = {};
  (ids || []).forEach((i) => { els[i] = fakeEl(i); });
  return {
    els,
    getElementById: (i) => els[i] || null,
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => Object.assign(fakeEl(''), { appendChild() {}, addEventListener() {}, setAttribute() {} }),
    addEventListener() {}, body: { appendChild() {} }, head: { appendChild() {} },
  };
}
const ts = (ms) => ({ toMillis: () => ms });

// estimate-v2-ui.js in a vm. _saveEstimate mirrors the real one
// (dashboard-bootstrap.module.js): an edit id → updateDoc that doc and clear
// the id; none → addDoc a NEW doc. Both keep window._estimates current, as
// the real one's loadEstimates() does.
function loadV2(opts) {
  opts = opts || {};
  const SRC = read('docs/pro/js/estimate-v2-ui.js');
  const doc = fakeDoc(['v2saveBtn', 'v2saveCopyBtn', 'v2saveStatus', 'v2signBtn', 'v2signStatus', 'v2kyNote',
    'v2kyContractBtn', 'v2sendHoBtn', 'v2shareStatus', 'v2shareBox', 'estV2Modal', 'v2coName', 'v2coEmail', 'v2cosign']);
  doc.els.v2saveCopyBtn.hidden = true; // as the markup ships it
  const calls = [];
  const win = {};
  win.window = win;
  win._user = { uid: 'u1' };
  win._leads = [];
  win._estimates = opts.estimates || [];
  win.NBD_XACT_CATALOG = { find: (code) => ({ code, name: code, unit: 'SQ' }) };
  win.EstimateLogic = {
    resolveEstimate: () => ({ lines: [{ code: 'RFG', name: 'Shingles', quantity: 20, unit: 'SQ', lineTotal: 9000 }], subtotal: 9000, tax: 0, total: 9000 }),
    buildContext: (x) => x, MEASUREMENT_VARS: [],
  };
  win.EstimateBuilderV2 = {
    loadSettings: () => ({ countyTax: {} }),
    calculatePerSq: () => ({}),
    calculateAllTiers: () => ({
      economy: { total: 9000, subtotal: 9000 }, good: { total: 11000, subtotal: 11000 },
      better: { total: 13000, subtotal: 13000 }, best: { total: 15000, subtotal: 15000 }, beyond: { total: 17000, subtotal: 17000 },
    }),
  };
  let n = 0, clock = 1000;
  win._saveEstimate = async (payload) => {
    const editId = win._editingEstimateId || null;
    if (opts.saveFails) { calls.push(['save', { editing: editId, failed: true }]); return null; }
    clock += 10;
    if (editId) {
      calls.push(['save', { editing: editId, kind: 'update' }]);
      const i = win._estimates.findIndex((e) => e.id === editId);
      if (i !== -1) win._estimates[i] = Object.assign({}, win._estimates[i], payload, { updatedAt: ts(clock) });
      win._editingEstimateId = null;
      return editId;
    }
    const id = 'est_new' + (++n);
    calls.push(['save', { editing: null, kind: 'create', id }]);
    win._estimates.push(Object.assign({ id, userId: 'u1' }, payload, { createdAt: ts(clock), updatedAt: ts(clock) }));
    return id;
  };
  win.showToast = (m, t) => { calls.push(['toast', m, t]); };
  win.nbdConfirm = async (m) => { calls.push(['confirm', m]); return opts.confirm !== undefined ? opts.confirm : true; };
  win.location = { href: 'https://example.test/pro/dashboard' };
  const sandbox = {
    window: win, document: doc, navigator: {},
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Set, Map, Promise, setTimeout: () => 0, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'estimate-v2-ui.js' });
  const UI = win.EstimateV2UI;
  const T = UI._test;
  const st = T.getState();
  st.scope = [{ code: 'RFG' }];
  st.measurements.rawSqft = 2000;
  st.mode = 'per-sq';
  st.jobMode = 'cash';
  st.tier = 'better';
  st.customer = { name: 'Pat Homeowner', address: '1 Test St, Milford, OH 45150', phone: '', email: '', leadId: 'L1' };
  return { UI, T, st, win, doc, calls };
}
const saves = (V) => V.calls.filter((c) => c[0] === 'save').map((c) => c[1]);
const creates = (V) => saves(V).filter((s) => s.kind === 'create');
const findEst = (V, id) => V.win._estimates.find((e) => e.id === id);

async function main() {
  await asection('A. Fresh estimate: Save, then Save again updates the same estimate', async () => {
    const V = loadV2();
    const id1 = await V.UI.save();
    ok('first Save creates the estimate', id1 === 'est_new1' && creates(V).length === 1, JSON.stringify(saves(V)));
    V.st.measurements.rawSqft = 2400; // the rep changes something, then saves again
    const id2 = await V.UI.save();
    const s = saves(V);
    ok('second Save is an UPDATE of that estimate', s.length === 2 && s[1].kind === 'update' && s[1].editing === 'est_new1', JSON.stringify(s));
    ok('second Save returns the same id', id2 === 'est_new1', id2);
    ok('no second estimate on the customer', creates(V).length === 1 && V.win._estimates.length === 1, V.win._estimates.length);
    ok('the edit id does not leak past the save', V.win._editingEstimateId == null, V.win._editingEstimateId);
    const id3 = await V.UI.save();
    ok('a third Save still updates it', id3 === 'est_new1' && creates(V).length === 1, JSON.stringify(saves(V)));
    ok('no "which price?" confirm on Save again', !V.calls.some((c) => c[0] === 'confirm'));
  });

  await asection('B. Save as copy makes a new estimate; Save after it updates the copy', async () => {
    const V = loadV2();
    await V.UI.save();
    ok('Save as copy is exposed', typeof V.UI.saveAsCopy === 'function');
    const copyId = await V.UI.saveAsCopy();
    const s = saves(V);
    ok('Save as copy CREATES a new estimate', s.length === 2 && s[1].kind === 'create' && copyId === 'est_new2', JSON.stringify(s));
    ok('the original is still there', !!findEst(V, 'est_new1') && V.win._estimates.length === 2);
    ok('status says it was saved as a copy', /new copy/i.test(V.doc.els.v2saveStatus.textContent), V.doc.els.v2saveStatus.textContent);
    const again = await V.UI.save();
    const s2 = saves(V);
    ok('Save after the copy updates the COPY, not the original', again === 'est_new2' && s2[2].kind === 'update' && s2[2].editing === 'est_new2', JSON.stringify(s2));
    ok('a plain save does not say "copy"', !/copy/i.test(V.doc.els.v2saveStatus.textContent), V.doc.els.v2saveStatus.textContent);

    const F = loadV2({ saveFails: true });
    F.win._v2SavedEstimateId = 'est_keep';
    F.win._estimates = [{ id: 'est_keep', userId: 'u1', updatedAt: ts(5) }];
    const r = await F.UI.saveAsCopy();
    ok('a failed copy returns null', r === null);
    ok('a failed copy keeps Save again pointed at the original', F.win._v2SavedEstimateId === 'est_keep', F.win._v2SavedEstimateId);
  });

  await asection('C. Reopened estimate: Save + Save again update it; Save as copy leaves it alone', async () => {
    const seed = loadV2();
    await seed.UI.save();
    const saved = JSON.parse(JSON.stringify(findEst(seed, 'est_new1')));
    saved.id = 'est_A'; saved.updatedAt = ts(500); saved.createdAt = ts(400);
    const V = loadV2({ estimates: [saved] });
    ok('reopen works', V.T.rehydrateFromSaved('est_A') === true);
    await V.UI.save();
    await V.UI.save();
    const s = saves(V);
    ok('both saves update the reopened estimate', s.length === 2 && s.every((x) => x.kind === 'update' && x.editing === 'est_A'), JSON.stringify(s));
    const before = JSON.stringify(findEst(V, 'est_A'));
    const copyId = await V.UI.saveAsCopy();
    ok('Save as copy creates a new estimate', copyId === 'est_new1' && saves(V)[2].kind === 'create', JSON.stringify(saves(V)));
    ok('the reopened estimate is untouched by the copy', JSON.stringify(findEst(V, 'est_A')) === before);
  });

  await asection('D. Signed / out for signature since the save → Save again refuses; Save as copy works', async () => {
    for (const mark of [{ signatureStatus: 'signed' }, { signedPrice: { fields: { grandTotal: 13000 } } }, { signatureStatus: 'sent' }, { signatureStatus: 'viewed' }]) {
      const label = JSON.stringify(mark).slice(0, 40);
      const V = loadV2();
      await V.UI.save();
      Object.assign(findEst(V, 'est_new1'), mark);
      const r = await V.UI.save();
      ok(label + ': Save again writes nothing', r === null && saves(V).length === 1, JSON.stringify(saves(V)));
      const msg = V.doc.els.v2saveStatus.textContent;
      ok(label + ': the message names Save as copy', /save as copy/i.test(msg), msg);
      ok(label + ': the message says why (signed / out for signature)', /sign/i.test(msg), msg);
      const c = await V.UI.saveAsCopy();
      ok(label + ': Save as copy still saves (a new, unsigned estimate)', c === 'est_new2' && saves(V)[1].kind === 'create', JSON.stringify(saves(V)));
    }
    // Signed BEFORE this builder saved it (reopened from the list): the reopen's
    // first save updates it (the existing R6-2-2 path — bills keep the signed
    // price), so Save again does the same instead of refusing half-way.
    const seed = loadV2();
    await seed.UI.save();
    const signedDoc = JSON.parse(JSON.stringify(findEst(seed, 'est_new1')));
    Object.assign(signedDoc, { id: 'est_S', signatureStatus: 'signed', signedPrice: { fields: { grandTotal: 13000 } }, updatedAt: ts(500) });
    const R = loadV2({ estimates: [signedDoc] });
    R.T.rehydrateFromSaved('est_S');
    await R.UI.save();
    const r2 = await R.UI.save();
    ok('reopened signed estimate: Save again updates it like the first save did', r2 === 'est_S'
      && saves(R).length === 2 && saves(R).every((x) => x.kind === 'update' && x.editing === 'est_S'), JSON.stringify(saves(R)));
    // ...but signed AFTER that save (signed while it was open) → refuses again.
    const R2 = loadV2({ estimates: [Object.assign({}, signedDoc, { id: 'est_O', signatureStatus: 'sent', signedPrice: undefined })] });
    R2.T.rehydrateFromSaved('est_O');
    await R2.UI.save();
    findEst(R2, 'est_O').signatureStatus = 'signed';
    const r3 = await R2.UI.save();
    ok('out for signature at the save, signed since → Save again refuses', r3 === null && saves(R2).length === 1, JSON.stringify(saves(R2)));

    // Declined / voided / expired envelopes are no longer out: Save again updates.
    const V = loadV2();
    await V.UI.save();
    findEst(V, 'est_new1').signatureStatus = 'voided';
    const r = await V.UI.save();
    ok('voided envelope: Save again updates', r === 'est_new1' && saves(V)[1].kind === 'update', JSON.stringify(saves(V)));
  });

  await asection('E. Changed on another device since the save → ask before overwriting', async () => {
    const no = loadV2({ confirm: false });
    await no.UI.save();
    findEst(no, 'est_new1').updatedAt = ts(999999); // another device saved it
    const r = await no.UI.save();
    ok('asks the rep', no.calls.some((c) => c[0] === 'confirm' && /another device|changed/i.test(c[1])), JSON.stringify(no.calls.filter((c) => c[0] === 'confirm')));
    ok('"no" writes nothing', r === null && saves(no).length === 1, JSON.stringify(saves(no)));
    const yes = loadV2({ confirm: true });
    await yes.UI.save();
    findEst(yes, 'est_new1').updatedAt = ts(999999);
    const r2 = await yes.UI.save();
    ok('"yes" updates the estimate', r2 === 'est_new1' && saves(yes)[1].kind === 'update', JSON.stringify(saves(yes)));
    const quiet = loadV2();
    await quiet.UI.save();
    await quiet.UI.save();
    ok('no change elsewhere → no question', !quiet.calls.some((c) => c[0] === 'confirm'));
  });

  await asection('F. Saved estimate gone from the list (archived elsewhere) → saved as a new one', async () => {
    const V = loadV2();
    await V.UI.save();
    V.win._estimates = []; // archived on another device: the list drops it
    const r = await V.UI.save();
    ok('not written onto the archived estimate', saves(V)[1].kind === 'create' && r === 'est_new2', JSON.stringify(saves(V)));
    ok('the rep is told', V.calls.some((c) => c[0] === 'toast' && /new estimate/i.test(c[1])), JSON.stringify(V.calls.filter((c) => c[0] === 'toast')));
  });

  await asection('G. Markup + wiring (CSP-safe, V3-placed)', async () => {
    const SRC = read('docs/pro/js/estimate-v2-ui.js');
    const btn = /<button id="v2saveCopyBtn"[^>]*>/.exec(SRC);
    ok('a "Save as copy" button exists', !!btn && /Save as copy/.test(SRC.slice(btn.index, btn.index + 400)));
    ok('it uses data-action="save-copy" (no inline handler)', !!btn && /data-action="save-copy"/.test(btn[0]) && !/\son[a-z]+=/i.test(btn[0]), btn && btn[0]);
    ok('it ships hidden', !!btn && /\shidden[\s>]/.test(btn[0]));
    ok('the delegate routes save-copy to saveAsCopy', /case 'save-copy':\s*saveAsCopy\(\)/.test(SRC));
    ok('the V3 wizard places it with Save', /\['#v2saveCopyBtn', 'finish', 'more'\]/.test(read('docs/pro/js/estimate-v3-wizard.js')));
    const V = loadV2();
    ok('gate seam exposed', typeof V.T.applySaveCopyGate === 'function');
    if (typeof V.T.applySaveCopyGate === 'function') {
      V.T.applySaveCopyGate();
      ok('hidden before anything is saved', V.doc.els.v2saveCopyBtn.hidden === true);
      await V.UI.save();
      ok('shown once the estimate is saved', V.doc.els.v2saveCopyBtn.hidden === false);
    }
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
}
main();
