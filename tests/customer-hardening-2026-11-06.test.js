/**
 * tests/customer-hardening-2026-11-06.test.js — CRM audit 2026-11-06.
 *
 * CU-F16 customer-tasks-ui.js showPhotoActions: photo.url went into
 *        <img src="..."> unescaped. Now http(s) only and escaped (as the grid).
 * CU-F22 customer-photo-report-generator.js addDocumentsToQueue: a drop
 *        bypassed the input's accept= list and there was no size cap. Now the
 *        same type list and the same 20 MB cap as customer-dnd-upload.js.
 * Real code in a vm. Zero deps. Run: node tests/customer-hardening-2026-11-06.test.js
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
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');

console.log('PHOTO POPUP THUMBNAIL (CU-F16)');
{
  const SRC = read('customer-tasks-ui.js');
  const s = SRC.indexOf('window.showPhotoActions = function(idx, event) {');
  const show = s >= 0 ? SRC.slice(s, SRC.indexOf('\n};\n', s) + 4) : '';
  const e0 = SRC.indexOf('function nbdEscFn() {');
  const escFn = e0 >= 0 ? SRC.slice(e0, SRC.indexOf('\n}\n', e0) + 3) : '';
  const c0 = SRC.indexOf('function _closePhotoActionPopup() {');
  const close = c0 >= 0 ? SRC.slice(c0, SRC.indexOf('\n}\n', c0) + 3) : '';
  ok('showPhotoActions, nbdEscFn and _closePhotoActionPopup found (positive control)', show.length > 500 && escFn.length > 30 && close.length > 30);
  function render(url) {
    let html = '';
    const el = () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {}, querySelector: () => null,
      set innerHTML(v) { html += v; }, get innerHTML() { return html; } });
    const sb = { window: { _allPhotos: [{ id: 'p1', url, phase: 'Before' }], _currentLead: {} }, _dmgOptions: () => [], _dmgNorm: (x) => x,
      document: { activeElement: null, createElement: el, getElementById: () => null, body: { appendChild() {} } } };
    vm.createContext(sb);
    vm.runInContext(escFn + '\n' + close + '\n' + show + '\nwindow.showPhotoActions(0);', sb);
    return html;
  }
  const good = render('https://example.test/p.jpg?a=1&b=2');
  ok('an https photo still shows (positive control)', /<img src="https:\/\/example\.test\/p\.jpg\?a=1&amp;b=2"/.test(good), (good.match(/<img[^>]*>/) || [''])[0]);
  const evil = render('x" onerror="alert(1)');
  ok('a url that tries to break out of src= cannot', !/onerror=/.test(evil), (evil.match(/<img[^>]*>/) || [''])[0]);
  const js = render('javascript:alert(1)');
  ok('a non-http(s) url is not used at all', /<img src=""/.test(js));
}

console.log('FILES MODAL TYPE + SIZE (CU-F22)');
{
  const SRC = read('customer-photo-report-generator.js');
  const s = SRC.indexOf('function addDocumentsToQueue(files) {');
  const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n}\n', s) + 3) : '';
  ok('addDocumentsToQueue found (positive control)', fn.length > 200);
  const toasts = [];
  const sb = { window: { _docUploadQueue: [], showToast: (m) => toasts.push(m) }, updateDocUploadPreview() {}, Set };
  vm.createContext(sb);
  vm.runInContext(fn + '\nglobalThis.__add = addDocumentsToQueue;', sb);
  const added = sb.__add([
    { name: 'contract.pdf', size: 1000, lastModified: 1 },
    { name: 'photo.JPG', size: 2000, lastModified: 1 },
    { name: 'tool.exe', size: 100, lastModified: 1 },
    { name: 'huge.pdf', size: 21 * 1024 * 1024, lastModified: 1 },
  ]);
  const names = sb.window._docUploadQueue.map((q) => q.file.name);
  ok('supported files under 20 MB are queued (positive control)', names.includes('contract.pdf') && names.includes('photo.JPG'), names.join(','));
  ok('a type outside the accept= list is skipped on drop', !names.includes('tool.exe'));
  ok('a file over 20 MB is skipped', !names.includes('huge.pdf'));
  ok('…and the rep is told which and why', toasts.length === 1 && /tool\.exe/.test(toasts[0]) && /huge\.pdf: too large/.test(toasts[0]), toasts.join(' | '));
  ok('the return value counts only what was queued', added === 2, String(added));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
