/**
 * tests/lead-drive-link-2026-11-06.test.js — approved additive field (CRM audit
 * 2026-11-06, CU-F07): a Google Drive folder link on the lead.
 *
 * - Add/Edit Lead modal (dashboard.html #lDriveUrl) saves `driveFolderUrl`.
 * - Only an http(s) URL is stored; anything else (javascript:, text) saves ''.
 * - Omitted entirely when the field is not on the page (a stale cached page
 *   must not blank a stored link) — same omit-when-unknown rule as trades.
 * - The customer card shows it as a link (customer.html #infoDriveFolder),
 *   built with createElement (never innerHTML) and only for http(s).
 *
 * Runs the real crm-leads.js saveLead in a vm. Zero deps.
 * Run: node tests/lead-drive-link-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const LEADS_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/crm-leads.js'), 'utf8');
const STAGE_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/stage-write.js'), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function save(driveField) {
  const el = (v) => ({ value: v, checked: false, style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {} },
    options: [], focus() {}, scrollIntoView() {}, addEventListener() {}, querySelectorAll: () => [] });
  const fields = { lFname: el('Test'), lAddr: el('100 Test St'), lEditId: el('lead-1'), lStage: el('new'), lJobType: el('insurance') };
  if (driveField !== undefined) fields.lDriveUrl = el(driveField);
  const shared = {};
  const document = {
    getElementById: (id) => (id === 'lDriveUrl' ? (fields.lDriveUrl || null) : (fields[id] || shared[id] || (shared[id] = el('')))),
    querySelector: (sel) => (sel === '#leadModal .msave' ? (shared.__btn = shared.__btn || { disabled: false, textContent: 'Save' }) : null),
    querySelectorAll: () => [], addEventListener() {}, dispatchEvent() {},
  };
  const saved = [];
  const win = {
    db: {}, updateDoc: async () => {}, deleteDoc() {}, getDoc() {}, getDocs() {}, where() {}, orderBy() {}, query() {},
    doc: (db, col, id) => col + '/' + id, collection: (db, name) => name, addDoc: async () => ({ id: 'n1' }),
    serverTimestamp: () => 'TS', arrayUnion: (x) => ({ arrayUnion: x }),
    runTransaction: async (db, fn) => fn({ get: async () => ({ exists: () => true, data: () => ({ stage: 'new' }) }), update() {} }),
    stageRole: () => 'active', normalizeStage: (s) => s, missingRequiredFields: () => [], requiredFieldLabel: (f) => f,
    _leads: [{ id: 'lead-1', stage: 'new', jobType: 'insurance' }], _currentUser: { email: 'rep@example.test' },
    _saveLead: async (d) => { saved.push(d); return d.id; },
  };
  const sandbox = { window: win, document, console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, CustomEvent: function () {}, showToast() {} };
  vm.createContext(sandbox);
  vm.runInContext(STAGE_SRC.replace(/^export\s+/gm, '') + '\nglobalThis.__stageWrite = { commitStageChange };', sandbox);
  vm.runInContext(LEADS_SRC.split("import('./stage-write.js')").join('Promise.resolve(globalThis.__stageWrite)'), sandbox);
  await sandbox.saveLead();
  return saved[0];
}

(async () => {
  console.log('DRIVE FOLDER LINK ON THE LEAD');
  const url = 'https://drive.google.com/drive/folders/TEST-FOLDER-1';
  {
    const p = await save('  ' + url + '  ');
    ok('the edit saved (positive control)', !!p && p.firstName === 'Test');
    ok('an https link is stored, trimmed', p && p.driveFolderUrl === url, p && p.driveFolderUrl);
  }
  {
    const p = await save('javascript:alert(1)');
    ok('a javascript: value is stored as ""', p && p.driveFolderUrl === '');
  }
  {
    const p = await save('');
    ok('clearing the box clears the link', p && p.driveFolderUrl === '');
  }
  {
    const p = await save(undefined);
    ok('no field on the page → the key is omitted (stored link untouched)', p && !('driveFolderUrl' in p));
  }
  console.log('MARKUP + DISPLAY');
  {
    const dash = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
    const cust = fs.readFileSync(path.join(ROOT, 'docs/pro/customer.html'), 'utf8');
    const boot = fs.readFileSync(path.join(ROOT, 'docs/pro/js/customer-bootstrap.module.js'), 'utf8');
    const bridge = fs.readFileSync(path.join(ROOT, 'docs/pro/js/crm-portal-bridge.js'), 'utf8');
    ok('the lead modal has a labelled url input #lDriveUrl', /<label for="lDriveUrl">[^<]+<\/label><input type="url" id="lDriveUrl"/.test(dash));
    ok('Edit Lead loads the stored link into it', /setV\('lDriveUrl', l\.driveFolderUrl\|\|''\)/.test(bridge));
    ok('the customer card has a Drive folder slot', /id="infoDriveFolder"/.test(cust));
    const blk = boot.slice(boot.indexOf("getElementById('infoDriveFolder')"), boot.indexOf("getElementById('infoDriveFolder')") + 900);
    ok('…filled with createElement + textContent, never innerHTML', /createElement\('a'\)/.test(blk) && !/innerHTML/.test(blk));
    ok('…only for http(s), opening in a new tab with noopener', /\^https\?:/.test(blk) && /noopener noreferrer/.test(blk));
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
