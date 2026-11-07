/**
 * tests/integrity-2-guards-2026-11-06.test.js — CRM audit 2026-11-06,
 * second integrity pass. Every case runs the real code in a vm.
 *
 * CU-F04 customer-edit-modal.js saveCustomerEdits updated only
 *   window._currentLead. Modules that replace _currentLead with a copy left
 *   window._leadDoc — what the document generator and pre-flight read — on the
 *   OLD address, so a contract generated right after Edit Info carried it.
 * CU-F02 customer-photo-report-generator.js uploadDocuments stopped the batch at
 *   the first failure and kept already-uploaded files queued, so a retry
 *   uploaded them again.
 * PL-F08 crm-list-view.js: the stage select kept the new stage after moveCard
 *   refused or the rep cancelled (moveCard resolves undefined without
 *   re-rendering).
 * ST-F06 dashboard-bootstrap.module.js: a failed users/{uid} read was silent
 *   and the next Save wrote the empty Phone / Google review / Cal.com boxes over
 *   the stored values.
 * Zero deps. Run: node tests/integrity-2-guards-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
const mkEl = (v) => ({ value: v == null ? '' : v, textContent: '', innerHTML: '', href: '', checked: false, disabled: false, style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, focus() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {},
  querySelector() { return null; }, querySelectorAll() { return []; }, appendChild(c) { return c; } });

(async () => {
  // ── CU-F04 ─────────────────────────────────────────────────────────────
  console.log('EDIT INFO UPDATES THE LEAD THE DOCUMENTS READ (CU-F04)');
  {
    const vals = { editFirstName: 'Test', editLastName: 'Homeowner 01', editPhone: '(555) 010-1000', editEmail: 'h01@example.test',
      editAddress: '200 New St, Testville, OH 45000', editDamageType: '', editScope: '', editJobValue: '12000' };
    const els = {};
    const document = { getElementById: (id) => (els[id] = els[id] || mkEl(vals[id])), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
    const writes = [];
    const win = { _customerId: 'L1', db: {}, doc: (db, c, id) => c + '/' + id, updateDoc: async (ref, u) => { writes.push(u); },
      _currentLead: { id: 'L1', address: '100 Old St' }, _leadDoc: { id: 'L1', address: '100 Old St' } };
    const sandbox = { window: win, document, console: { log() {}, warn() {}, error() {} }, showToast() {}, setTimeout: () => 0, parseFloat, String, Object };
    vm.createContext(sandbox);
    let loadErr = null;
    try { vm.runInContext(read('customer-edit-modal.js'), sandbox, { filename: 'customer-edit-modal.js' }); } catch (e) { loadErr = e; }
    sandbox.closeEditCustomerModal = () => {};
    let err = null;
    try { await sandbox.saveCustomerEdits(); } catch (e) { err = e; }
    ok('Edit Info saves (positive control)', !loadErr && !err && writes.length === 1 && writes[0].address === '200 New St, Testville, OH 45000', (loadErr || err || {}).message);
    ok('window._currentLead has the new address', win._currentLead.address === '200 New St, Testville, OH 45000');
    ok('window._leadDoc (documents/pre-flight) has the new address too', win._leadDoc.address === '200 New St, Testville, OH 45000', win._leadDoc.address);
  }

  // ── CU-F02 ─────────────────────────────────────────────────────────────
  console.log('A FAILED FILE DOES NOT RE-UPLOAD THE OTHERS (CU-F02)');
  {
    const src = read('customer-photo-report-generator.js');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const s0 = src.indexOf('window.uploadDocuments = async function() {');
    const fn = s0 >= 0 ? src.slice(s0, src.indexOf(eol + '};', s0) + eol.length + 2) : '';
    ok('uploadDocuments is found (positive control)', fn.length > 200);
    const sent = [];
    const notes = [];
    const win = { _customerId: 'L1', _docUploadQueue: [{ name: 'a.pdf' }, { name: 'b.pdf' }, { name: 'c.pdf' }], NBDCustomerDocs: { refresh: async () => {} } };
    const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, Promise,
      _nbdNotify: (m, k) => notes.push(k + ':' + m), _setDocUploadBusy() {}, updateDocUploadPreview() {}, closeDocUploadModal: () => { notes.push('closed'); },
      uploadSingleDocument: async (item) => { sent.push(item.name); if (item.name === 'b.pdf' && !item.retry) throw new Error('refused'); } };
    vm.createContext(sandbox);
    vm.runInContext(fn, sandbox);
    await win.uploadDocuments();
    ok('every file is attempted, not just the ones before the failure', sent.join(',') === 'a.pdf,b.pdf,c.pdf', sent.join(','));
    ok('the rep is told how many went up and how many failed', notes.some((n) => /^error:Uploaded 2 of 3\. 1 failed/.test(n)), notes.join(' | '));
    ok('only the failed file stays queued', win._docUploadQueue.length === 1 && win._docUploadQueue[0].name === 'b.pdf');
    sent.length = 0;
    win._docUploadQueue[0].retry = true;
    await win.uploadDocuments();
    ok('a retry sends ONLY the failed file (no duplicates)', sent.join(',') === 'b.pdf', sent.join(','));
    ok('…and then reports success and closes', notes.some((n) => /^success:Uploaded 1 file\./.test(n)) && notes.indexOf('closed') !== -1);
  }

  // ── PL-F08 ─────────────────────────────────────────────────────────────
  console.log('LIST-VIEW STAGE SELECT SNAPS BACK WHEN THE MOVE DOES NOT HAPPEN (PL-F08)');
  {
    const src = read('crm-list-view.js');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const s0 = src.indexOf('  function _wireStageSelect(sel) {');
    const fn = s0 >= 0 ? src.slice(s0, src.indexOf(eol + '  }', s0) + eol.length + 3) : '';
    ok('the stage-select wiring is found (positive control)', fn.length > 100);
    const run = async (result) => {
      let onChange = null;
      const sel = { value: 'new', isConnected: true, dataset: { id: 'L1' }, addEventListener: (t, f) => { onChange = f; } };
      const sandbox = { window: { moveCard: async () => result }, Promise };
      vm.createContext(sandbox);
      vm.runInContext(fn + '\nglobalThis.__w = _wireStageSelect;', sandbox);
      sandbox.__w(sel);
      sel.value = 'lost';
      onChange();
      await new Promise((r) => setTimeout(r, 10));
      return sel.value;
    };
    const okRun = fn.length > 100;
    ok('a successful move keeps the new stage', okRun && (await run(true)) === 'lost');
    ok('a refused / cancelled move (undefined) snaps back to the stored stage', okRun && (await run(undefined)) === 'new');
  }

  // ── ST-F06 ─────────────────────────────────────────────────────────────
  console.log('A FAILED PROFILE READ CANNOT BLANK THE STORED PROFILE (ST-F06)');
  {
    const BOOT = read('dashboard-bootstrap.module.js');
    const eol = BOOT.includes('\r\n') ? '\r\n' : '\n';
    const a = BOOT.indexOf('  let _profileFieldsLoaded = false;');
    const b = BOOT.indexOf('  const _saveSettings = async () => {');
    const c = b >= 0 ? BOOT.indexOf(eol + '  };', b) : -1;
    ok('the load flag and both functions are found (positive control)', a >= 0 && b > a && c > b);
    const code = BOOT.slice(a, c + eol.length + 4);
    const run = async (readOk) => {
      const els = {};
      const document = { getElementById: (id) => (els[id] = els[id] || mkEl('')) };
      const writes = [];
      const toasts = [];
      const win = { _user: { uid: 'u1', displayName: 'Test Rep', email: 'rep@example.test' }, db: {}, doc: (d, c, id) => c + '/' + id,
        setDoc: async (ref, data) => { writes.push(data); } };
      const sandbox = { window: win, document, console: { log() {}, warn() {}, error() {} }, setTimeout, Promise, Object, String,
        db: {}, doc: (d, c, id) => c + '/' + id, updateProfile: async () => {}, showToast: (m, k) => toasts.push(k + ':' + m),
        getDoc: async () => { if (!readOk) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
          return { exists: () => true, data: () => ({ phone: '(555) 010-0100', googleReviewUrl: 'https://g.example/review', calcomUsername: 'rep' }) }; } };
      vm.createContext(sandbox);
      vm.runInContext(code + '\nglobalThis.__load = _loadProfileSettings; globalThis.__save = _saveSettings;', sandbox);
      await sandbox.__load();
      try { await sandbox.__save(); } catch (_) { /* later steps of save may need more DOM; the write is what matters */ }
      return { write: writes[0], toasts };
    };
    const found = a >= 0 && b > a && c > b;
    const good = found ? await run(true) : {};
    ok('after a good read, Save writes the full profile (positive control)', good.write && good.write.phone === '(555) 010-0100' && 'googleReviewUrl' in good.write);
    const bad = found ? await run(false) : { toasts: [] };
    ok('after a FAILED read, Save writes only the display name', bad.write && Object.keys(bad.write).join(',') === 'displayName', bad.write && Object.keys(bad.write).join(','));
    ok('…and tells the rep the other fields were left unchanged', bad.toasts.some((t) => /could not be loaded/.test(t)));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
