/**
 * tests/hygiene-guards-2026-11-06.test.js — CRM audit 2026-11-06, hygiene pass.
 *
 * VW-F150 docs/pro/js/tools.js exportLeadsCSV (pipeline header "Export CSV")
 *   wrote lead fields raw; names/notes come from the PUBLIC intake form, so a
 *   value starting = + - @ ran as a formula in the owner's spreadsheet. The file
 *   was also named "NBD-Leads-" for every tenant.
 * ST-F02 docs/pro/js/company-profile.js _saveCompanyProfile merged the edit into
 *   memory + the tenant cache BEFORE setDoc and never rolled back, so a rules
 *   denial still changed the values this session's estimates/documents used.
 * ST-F60 docs/pro/js/pages/onboarding.js prefill put the LOGIN email in the
 *   business-email box before the profile was read (setIfEmpty then ignored the
 *   profile), and Save always set alertEmail = email.
 *
 * Every case runs the real code in a vm. Zero deps.
 * Run: node tests/hygiene-guards-2026-11-06.test.js
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
function slice(src, start, endMarker) {
  const s = src.indexOf(start);
  if (s < 0) return null;
  const e = src.indexOf(endMarker, s);
  return e < 0 ? null : src.slice(s, e + endMarker.length);
}

(async () => {
  // ── VW-F150 ──────────────────────────────────────────────────────────────
  console.log('CSV EXPORT NEUTRALISES SPREADSHEET FORMULAS (VW-F150)');
  {
    const SRC = fs.readFileSync(path.join(JS, 'tools.js'), 'utf8');
    const eol = SRC.includes('\r\n') ? '\r\n' : '\n';
    const exp = slice(SRC, 'function exportLeadsCSV() {', eol + '}');
    const safe = slice(SRC, 'function _csvSafe(s) {', eol + '}') || '';
    ok('exportLeadsCSV is found (positive control)', !!exp);
    const run = (isNbd) => {
      const out = { csv: null, name: null, toast: null };
      const win = { _leads: [
        { firstName: '=HYPERLINK("http://x.test","Click")', lastName: 'Homeowner', address: '100 Test St', notes: '@SUM(A1)', jobValue: -1500, source: 'Website' },
        { firstName: '+cmd', lastName: '-2+3', address: '101 Test St', jobValue: 12000 },
      ] };
      if (isNbd !== undefined) win._isNbdPlatformTenant = () => isNbd;
      const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, String, Date,
        Blob: function (parts) { out.csv = parts.join(''); },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
        document: { createElement: () => ({ click() {}, set download(v) { out.name = v; }, get download() { return out.name; } }) },
        showToast: (m) => { out.toast = m; } };
      vm.createContext(sandbox);
      vm.runInContext(safe + '\n' + exp + '\nglobalThis.__x = exportLeadsCSV;', sandbox);
      sandbox.__x();
      return out;
    };
    const t = run(false);
    ok('the export writes a CSV (positive control)', !!t.csv && /100 Test St/.test(t.csv));
    ok('a =HYPERLINK name is demoted to text', /"'=HYPERLINK\(/.test(t.csv), (t.csv || '').split('\n')[1]);
    ok('@ / + / formula-shaped minus values are demoted', /"'@SUM\(A1\)"/.test(t.csv) && /"'\+cmd"/.test(t.csv) && /"'-2\+3"/.test(t.csv));
    ok('a plain negative number still exports as a number', /"-1500"/.test(t.csv));
    ok('another tenant\'s file is not named NBD-…', /^Leads-\d{4}-\d{2}-\d{2}\.csv$/.test(t.name), t.name);
    ok('NBD keeps its file name', /^NBD-Leads-/.test(run(true).name));
  }

  // ── ST-F02 ───────────────────────────────────────────────────────────────
  console.log('DENIED COMPANY-PROFILE SAVE ROLLS BACK (ST-F02)');
  {
    const CP = fs.readFileSync(path.join(JS, 'company-profile.js'), 'utf8');
    const RE = /import\((['"])\/assets\/vendor\/firebase\/[\d.]+\/firebase-firestore\.js\1\)/g;
    const load = (setDocImpl) => {
      const store = {};
      const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
      const win = { localStorage, addEventListener() {}, dispatchEvent() { return true; }, db: { name: 'db' }, _userClaims: { companyId: 'c1' }, _user: { uid: 'u1' } };
      win.window = win;
      const fsStub = { doc: (...a) => a.slice(1).join('/'), setDoc: setDocImpl,
        getDoc: () => Promise.resolve({ exists: () => true, data: () => ({ businessName: 'Before Co' }), metadata: { fromCache: false, hasPendingWrites: false } }) };
      const sandbox = { window: win, localStorage, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Promise,
        CustomEvent: function (type) { this.type = type; }, __fsImport: async () => fsStub };
      vm.runInNewContext(CP.replace(RE, '__fsImport()'), sandbox, { filename: 'company-profile.js' });
      return { win, store };
    };
    const denied = () => Promise.reject(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
    {
      const m = load(() => Promise.resolve());
      await m.win._loadCompanyProfile();
      await m.win._saveCompanyProfile({ businessName: 'Accepted Co' });
      ok('an accepted save updates the profile (positive control)', m.win._companyProfile.businessName === 'Accepted Co');
    }
    {
      const m = load(denied);
      await m.win._loadCompanyProfile();
      const before = m.win._companyProfile.businessName;
      const cacheKey = Object.keys(m.store).find((k) => k.indexOf('nbd_company_profile_v1') === 0);
      const cacheBefore = cacheKey ? m.store[cacheKey] : null;
      let threw = null;
      try { await m.win._saveCompanyProfile({ businessName: 'Denied Co' }); } catch (e) { threw = e; }
      ok('the denied save still rejects to its caller', !!threw && threw.code === 'permission-denied');
      ok('…and the in-memory profile is rolled back', m.win._companyProfile.businessName === before && before !== 'Denied Co', m.win._companyProfile.businessName);
      const cacheAfter = cacheKey ? m.store[cacheKey] : Object.keys(m.store).filter((k) => k.indexOf('nbd_company_profile_v1') === 0).map((k) => m.store[k])[0] || null;
      ok('…and the tenant cache is rolled back', cacheAfter === cacheBefore && !/Denied Co/.test(String(cacheAfter)), String(cacheAfter).slice(0, 80));
    }
  }

  // ── ST-F60 ───────────────────────────────────────────────────────────────
  console.log('SETUP WIZARD RE-RUN KEEPS THE BUSINESS + ALERT EMAILS (ST-F60)');
  {
    const OB = fs.readFileSync(path.join(JS, 'pages', 'onboarding.js'), 'utf8');
    const eol = OB.includes('\r\n') ? '\r\n' : '\n';
    const fns = (slice(OB, 'function setIfEmpty(id, value) {', eol + '}') || '') + '\n' + (slice(OB, 'async function prefill() {', eol + '}') || '');
    ok('prefill is found (positive control)', fns.length > 400);
    const els = {};
    const el = (id) => (els[id] = els[id] || { value: '' });
    const state = { user: { uid: 'u1', email: 'login@example.test' }, claims: { companyId: 'c1' } };
    const profile = { brand: { legalName: 'Test Roofing LLC', contact: { email: 'office@example.test', alertEmail: 'alerts@example.test' } } };
    const sandbox = { state, $: el, val: (id) => el(id).value, db: {}, doc: (db, c, id) => c + '/' + id, deriveSeal: () => 'TR',
      getDoc: async (ref) => (ref.indexOf('companyProfile/') === 0 ? { exists: () => true, data: () => profile } : { exists: () => false }), String, console };
    vm.createContext(sandbox);
    vm.runInContext(fns + '\nglobalThis.__p = prefill;', sandbox);
    await sandbox.__p();
    ok('the business email box shows the profile\'s email, not the login email', els.obEmail.value === 'office@example.test', els.obEmail.value);
    ok('a separate stored alert inbox is flagged to keep', state.keepAlertEmail === true);
    ok('Save leaves alertEmail alone when it is flagged', /if \(email\)\s*\{ contact\.email = email; if \(!state\.keepAlertEmail\) contact\.alertEmail = email; \}/.test(OB));
    const fresh = { user: { uid: 'u2', email: 'login@example.test' }, claims: {} };
    const els2 = {};
    const sb2 = Object.assign({}, sandbox, { state: fresh, $: (id) => (els2[id] = els2[id] || { value: '' }), val: (id) => (els2[id] || { value: '' }).value,
      getDoc: async () => ({ exists: () => false }) });
    vm.createContext(sb2);
    vm.runInContext(fns + '\nglobalThis.__p = prefill;', sb2);
    await sb2.__p();
    ok('a first-time tenant still gets the login email as the default', els2.obEmail.value === 'login@example.test');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
