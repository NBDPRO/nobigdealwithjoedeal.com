/**
 * tests/cu-f14-2026-11-08.test.js — the document drop zone is wired once
 * (CRM audit 2026-11-06, CU-F14).
 *
 * customer-bootstrap.module.js carried a second copy of the DOCUMENT UPLOAD
 * SYSTEM from customer-photo-report-generator.js: the queue init,
 * openDocUploadModal / closeDocUploadModal, and a DOMContentLoaded block that
 * put a second click / drop / change listener on #docDropZone and
 * #docFileInput. One drop queued the files twice (the dedupe in
 * addDocumentsToQueue hid it) and one click called fileInput.click() twice.
 * The generator's copy (which also has the CU-F15 Enter / Space handler) is
 * now the only one.
 *
 * Runs every DOMContentLoaded block that wires #docDropZone, from both files
 * in page order (generator, then the module), against counting stubs, then
 * runs the opener that wins and checks it still clears the queue (CU-F01).
 * Zero deps. Run: node tests/cu-f14-2026-11-08.test.js
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
const GEN = read('docs/pro/js/customer-photo-report-generator.js');
const BOOT = read('docs/pro/js/customer-bootstrap.module.js');

// Every top-level DOMContentLoaded block in a file that wires the drop zone.
function dropZoneWirings(src) {
  const out = [];
  const START = "document.addEventListener('DOMContentLoaded', () => {";
  let i = src.indexOf(START);
  while (i >= 0) {
    const j = src.indexOf('\n});\n', i);
    if (j < 0) break;
    const block = src.slice(i, j + 5);
    if (/getElementById\('docDropZone'\)/.test(block)) out.push(block);
    i = src.indexOf(START, j);
  }
  return out;
}
// Every top-level assignment of the upload-modal opener.
function openers(src) {
  const out = [];
  const START = 'window.openDocUploadModal = function() {';
  let i = src.indexOf(START);
  while (i >= 0) {
    const j = src.indexOf('\n};\n', i);
    if (j < 0) break;
    out.push(src.slice(i, j + 4));
    i = src.indexOf(START, j);
  }
  return out;
}

const genWire = dropZoneWirings(GEN), bootWire = dropZoneWirings(BOOT);
console.log('\nSOURCE');
ok('control: the generator wires the drop zone (one block)', genWire.length === 1, genWire.length);
ok('the module no longer wires #docDropZone', bootWire.length === 0 && !/getElementById\('docDropZone'\)/.test(BOOT), bootWire.length);
ok('the module no longer defines openDocUploadModal / closeDocUploadModal',
  !/window\.openDocUploadModal\s*=/.test(BOOT) && !/window\.closeDocUploadModal\s*=/.test(BOOT));
ok('the generator still defines both (the page keeps an opener)',
  /window\.openDocUploadModal\s*=/.test(GEN) && /window\.closeDocUploadModal\s*=/.test(GEN));

console.log('\nTHE PAGE: one gesture, one handler');
{
  const counts = {};
  const zone = {}, input = {};
  const mk = (who, el) => (t, f) => { const k = who + ':' + t; counts[k] = (counts[k] || 0) + 1; (el.ls = el.ls || {})[t] = (el.ls[t] || []).concat(f); };
  zone.addEventListener = mk('zone', zone);
  zone.classList = { add() {}, remove() {} };
  input.addEventListener = mk('input', input);
  let pickerOpens = 0; input.click = () => { pickerOpens++; };
  const queued = [];
  const dcl = [];
  const ctx = {
    document: { addEventListener: (t, f) => { if (t === 'DOMContentLoaded') dcl.push(f); }, getElementById: (id) => ({ docDropZone: zone, docFileInput: input }[id] || null) },
    addDocumentsToQueue: (files) => queued.push(files.length), Array,
  };
  vm.createContext(ctx);
  genWire.concat(bootWire).forEach((b) => vm.runInContext(b, ctx));
  dcl.forEach((f) => f());
  ok('control: the drop zone got wired', (counts['zone:click'] || 0) >= 1);
  ok('exactly one click listener on the zone', counts['zone:click'] === 1, counts['zone:click']);
  ok('exactly one drop listener on the zone', counts['zone:drop'] === 1, counts['zone:drop']);
  ok('exactly one change listener on the file input', counts['input:change'] === 1, counts['input:change']);
  ok('the Enter / Space handler is still there (CU-F15)', counts['zone:keydown'] === 1, counts['zone:keydown']);
  (zone.ls.click || []).forEach((f) => f({}));
  ok('one click opens the picker once', pickerOpens === 1, pickerOpens);
  const two = [{ name: 'a.pdf' }, { name: 'b.pdf' }];
  (zone.ls.drop || []).forEach((f) => f({ preventDefault() {}, dataTransfer: { files: two } }));
  ok('one drop hands the files to the queue once', queued.length === 1 && queued[0] === 2, JSON.stringify(queued));
  queued.length = 0;
  (input.ls.change || []).forEach((f) => f({ target: { files: two } }));
  ok('one pick hands the files to the queue once', queued.length === 1 && queued[0] === 2, JSON.stringify(queued));
}

console.log('\nTHE OPENER THAT WINS still clears the queue (CU-F01)');
{
  const all = openers(GEN).concat(openers(BOOT)); // page order: the last one wins
  ok('control: an opener is found', all.length >= 1, all.length);
  let opened = null, previews = 0;
  const win = { _docUploadQueue: [{ name: 'old.pdf' }], nbdModal: { open: (id, o) => { opened = { id, o }; } } };
  const ctx = { window: win, updateDocUploadPreview: () => { previews++; } };
  vm.createContext(ctx);
  all.forEach((b) => vm.runInContext(b, ctx));
  win.openDocUploadModal();
  ok('opening starts from an empty queue', win._docUploadQueue.length === 0 && opened && opened.id === 'docUploadModal');
  win._docUploadQueue.push({ name: 'picked.pdf' });
  if (opened && opened.o && typeof opened.o.onClose === 'function') opened.o.onClose();
  ok('every dismiss path clears the in-progress picks', win._docUploadQueue.length === 0 && previews === 2, previews);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
