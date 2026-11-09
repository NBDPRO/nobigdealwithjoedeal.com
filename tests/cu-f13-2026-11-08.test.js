/**
 * tests/cu-f13-2026-11-08.test.js — the customer page never falls back to a
 * blocking native alert() (CRM audit 2026-11-06, CU-F13).
 *
 * Six "showToast is missing" fallbacks in customer-bootstrap.module.js (stage
 * move failure, photo batch cap, upload with no customer id, and the three
 * PDF-export dead ends) and the Review & Sort click in
 * customer-photo-review-links.js called alert(), which blocks the renderer
 * until dismissed. They now go through the module's _cbNotify (toast, else
 * console) and console.warn. The two window.prompt('Copy this link:') sites
 * are out of scope here (D-012: they wait for a shared non-blocking prompt).
 *
 * Runs the real lifted functions in a vm with no showToast and an alert spy.
 * Zero deps. Run: node tests/cu-f13-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
function slice(src, start, endMarker) {
  const i = src.indexOf(start); if (i < 0) return '';
  const j = src.indexOf(endMarker, i); return j < 0 ? '' : src.slice(i, j + endMarker.length);
}
// Comments out, strings kept, line by line: drop comment-only lines (//, /*,
// and the * continuation lines of a block) and a trailing // comment when the
// // follows whitespace (so 'https://' or 'image/*' inside a string stays).
const code = (src) => src.split('\n')
  .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');

const BOOT = read('docs/pro/js/customer-bootstrap.module.js');
const LINKS = read('docs/pro/js/customer-photo-review-links.js');

console.log('\nSOURCE: no alert() left on the customer page bootstrap or the Review link');
{
  const boot = code(BOOT), links = code(LINKS);
  ok('control: comment stripping keeps code (_cbNotify calls and the D-012 prompt survive)',
    /_cbNotify\(/.test(boot) && /window\.prompt\('Copy this link:'/.test(boot) && /addEventListener\('click'/.test(links));
  const bootHits = boot.split('\n').filter((l) => /\balert\s*\(/.test(l)).map((l) => l.trim());
  ok('customer-bootstrap.module.js calls no alert() / window.alert()', bootHits.length === 0, bootHits.join(' | '));
  const linkHits = links.split('\n').filter((l) => /\balert\s*\(/.test(l)).map((l) => l.trim());
  ok('customer-photo-review-links.js calls no alert()', linkHits.length === 0, linkHits.join(' | '));
}

function sandbox(win) {
  const calls = { alert: [], error: [], warn: [], log: [] };
  const con = { error: (...a) => calls.error.push(a.join(' ')), warn: (...a) => calls.warn.push(a.join(' ')), log: (...a) => calls.log.push(a.join(' ')) };
  win.alert = (m) => calls.alert.push(String(m));
  const ctx = { window: win, console: con, alert: win.alert, Array, Promise, Error, Date, String };
  vm.createContext(ctx);
  return { ctx, calls };
}

const CB_NOTIFY = slice(BOOT, 'function _cbNotify(msg, kind) {', '\n}\n');
ok('control: _cbNotify is found', CB_NOTIFY.length > 80, CB_NOTIFY.length);

console.log('\n_cbNotify with no showToast');
{
  const { ctx, calls } = sandbox({});
  vm.runInContext(CB_NOTIFY + '\n_cbNotify("boom", "error"); _cbNotify("fyi", "warning");', ctx);
  ok('an error goes to console.error, a warning to console.log, nothing to alert',
    calls.alert.length === 0 && calls.error.some((m) => /boom/.test(m)) && calls.log.some((m) => /fyi/.test(m)), JSON.stringify(calls));
}

console.log('\nCUSTOMER PDF EXPORT dead ends (showToast missing)');
const EXPORT = slice(BOOT, 'window.exportCustomerPDF = async function() {', '\n};\n');
ok('control: exportCustomerPDF is found', EXPORT.length > 1500, EXPORT.length);
async function runExport(win) {
  const { ctx, calls } = sandbox(win);
  vm.runInContext(CB_NOTIFY + '\n' + 'async function _gatherTimelineForReport() { return []; }\nasync function _gatherNotesForReport() { return []; }\n' + EXPORT, ctx);
  await ctx.window.exportCustomerPDF();
  return calls;
}
(async () => {
  {
    const calls = await runExport({});
    ok('no customer loaded: no alert, the message is logged', calls.alert.length === 0 && calls.error.some((m) => /Customer data not loaded/.test(m)), JSON.stringify(calls));
  }
  {
    const calls = await runExport({ _customerId: 'L1' });
    ok('document generator missing: no alert, the message is logged', calls.alert.length === 0 && calls.error.some((m) => /Document generator not loaded/.test(m)), JSON.stringify(calls));
  }
  {
    const calls = await runExport({ _customerId: 'L1', _currentLead: { firstName: 'A', lastName: 'B' }, NBDDocGen: { generate: async () => { throw new Error('render failed'); } } });
    ok('generation throws: no alert, the failure is logged', calls.alert.length === 0 && calls.error.some((m) => /Failed to generate report/.test(m)), JSON.stringify(calls));
  }

  console.log('\nUPLOAD with no customer id (showToast missing)');
  {
    const UPLOAD = slice(BOOT, 'window.uploadPhotos = async function() {', '\n};\n');
    ok('control: uploadPhotos is found', UPLOAD.length > 1000, UPLOAD.length);
    const { ctx, calls } = sandbox({ _uploadQueue: [{ file: { name: 'a.jpg' } }] });
    vm.runInContext(CB_NOTIFY + '\nlet _uploadBatchRunning = false;\nfunction renderUploadPreviewStructure() {}\n' + UPLOAD, ctx);
    await ctx.window.uploadPhotos();
    ok('no alert, the message is logged', calls.alert.length === 0 && calls.error.some((m) => /Customer ID not found/.test(m)), JSON.stringify(calls));
  }

  console.log('\nPHOTO BATCH CAP (showToast missing)');
  {
    const ADD = slice(BOOT, 'function addFilesToQueue(files) {', '\n}\n');
    ok('control: addFilesToQueue is found', ADD.length > 500, ADD.length);
    const { ctx, calls } = sandbox({});
    // 26 files over the size cap: the batch-cap notice fires, then each kept
    // file stops at the size check (no FileReader needed).
    const files = Array.from({ length: 26 }, (_, i) => ({ name: 'p' + i + '.jpg', size: 20 * 1024 * 1024 }));
    ctx.__files = files;
    vm.runInContext(CB_NOTIFY + '\nconst PHOTO_MAX_BATCH = 25;\nfunction isSupportedImageFile() { return true; }\n' + ADD + '\naddFilesToQueue(__files);', ctx);
    ok('no alert, the cap notice is logged', calls.alert.length === 0 && calls.log.some((m) => /Only the first 25 photos will upload/.test(m)), JSON.stringify(calls).slice(0, 300));
  }

  console.log('\nREVIEW & SORT before the customer has loaded (showToast missing)');
  {
    const listeners = {};
    const btn = { href: '/pro/photo-review?id=', addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } };
    const win = { location: { href: '/pro/customer.html?id=L1' } };
    const { ctx, calls } = sandbox(win);
    ctx.document = { getElementById: (id) => (id === 'prReviewBtn' ? btn : null) };
    vm.runInContext(LINKS, ctx);
    ok('control: the click handler is wired', (listeners.click || []).length === 1);
    let prevented = 0;
    (listeners.click || []).forEach((f) => f({ preventDefault() { prevented++; } }));
    ok('no alert, a console warning instead, and no navigation',
      calls.alert.length === 0 && calls.warn.some((m) => /Customer still loading/.test(m)) && prevented === 1 && win.location.href === '/pro/customer.html?id=L1', JSON.stringify(calls));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ harness threw — ' + (e && e.stack)); process.exit(1); });
