/**
 * tests/customer-files-guards-2026-11-06.test.js — CRM audit 2026-11-06,
 * customer card (docs/pro/customer.html).
 *
 * CU-F01: customer-tasks-ui.js (deferred, runs after customer-bootstrap.module.js)
 *   overwrote the module's openDocUploadModal — whose open + onClose clear the
 *   upload queue — with a bare open, so a reopened modal re-filed the last
 *   batch. Now only a fallback when no opener exists.
 * CU-F03: the photo quick-edit popup wrote through _allPhotos[index]; a refresh
 *   while it was open moved the write onto another photo. Now resolved by id.
 * DT-F10: a second window.toggleTask in customer-bootstrap.module.js wrote the
 *   retired top-level /tasks store; removed.
 *
 * Runs the real customer-tasks-ui.js top level in a vm (with the module's
 * opener pre-installed, as the page does), and checks the id-based lookups by
 * executing the quick-edit handlers against a reordered photo list.
 * Zero deps. Run: node tests/customer-files-guards-2026-11-06.test.js
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
const TASKS_UI = fs.readFileSync(path.join(JS, 'customer-tasks-ui.js'), 'utf8');
const BOOT = fs.readFileSync(path.join(JS, 'customer-bootstrap.module.js'), 'utf8');

// Load customer-tasks-ui.js as the page does, AFTER the module installed its opener.
function loadTasksUi(preinstalled) {
  const mkEl = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, appendChild(c) { return c; }, querySelector() { return null; }, querySelectorAll() { return []; }, remove() {}, insertAdjacentHTML() {}, dataset: {} });
  const win = { location: { pathname: '/pro/customer.html', search: '?id=L1', hash: '' }, addEventListener() {}, removeEventListener() {},
    nbdModal: { open() {}, close() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1280, innerHeight: 800 };
  if (preinstalled) { win.openDocUploadModal = preinstalled.open; win.closeDocUploadModal = preinstalled.close; }
  const document = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, createElement: mkEl, body: mkEl(), head: mkEl(), documentElement: mkEl() };
  const sandbox = { window: win, document, console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    clearInterval() {}, requestAnimationFrame: () => 0, IntersectionObserver: function () { return { observe() {}, disconnect() {} }; },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; }, navigator: { userAgent: 'node' }, localStorage: { getItem() { return null; }, setItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {} }, Date, Math, JSON, Promise };
  win.document = document;
  vm.createContext(sandbox);
  let err = null;
  try { vm.runInContext(TASKS_UI, sandbox, { filename: 'customer-tasks-ui.js' }); } catch (e) { err = e; }
  return { win, err, sandbox };
}

console.log('UPLOAD MODAL OPENER (CU-F01)');
{
  const realOpen = function realOpen() {}; const realClose = function realClose() {};
  const { win, err } = loadTasksUi({ open: realOpen, close: realClose });
  ok('customer-tasks-ui.js loads in the harness (positive control)', !err, err && err.message);
  ok('the module\'s queue-clearing opener is NOT overwritten', win.openDocUploadModal === realOpen);
  ok('…nor its closer', win.closeDocUploadModal === realClose);
  const alone = loadTasksUi(null);
  ok('with no opener installed, the fallback still provides one', typeof alone.win.openDocUploadModal === 'function' && typeof alone.win.closeDocUploadModal === 'function');
}

console.log('PHOTO QUICK-EDIT BY ID (CU-F03)');
{
  const uses = TASKS_UI.match(/_allPhotos \|\| \[\]\)\.find\(function \(p\) \{ return p && p\.id === window\._quickEditPhotoId; \}\)/g) || [];
  ok('the three quick-edit writers resolve the photo by id', uses.length === 3, String(uses.length));
  ok('no quick-edit writer indexes _allPhotos by position', !/_allPhotos \|\| \[\]\)\[window\._quickEditPhotoIdx\]/.test(TASKS_UI));
  // Behaviour, real code: the popup opened on p1 while it was first in the
  // list (index 0); the list then refreshed and p2 moved to index 0.
  const { win, sandbox } = loadTasksUi({ open() {}, close() {} });
  sandbox.quickSaveMeta = function () {}; // the save itself is not under test, only which photo it targets
  win._allPhotos = [{ id: 'p2', phase: 'Before' }, { id: 'p1', phase: 'Before' }];
  win._quickEditPhotoId = 'p1';
  win._quickEditPhotoIdx = 0;
  let threw = null;
  try { win.quickSetPhase('After', { style: {}, classList: { add() {}, remove() {} } }); } catch (e) { threw = e; }
  ok('quickSetPhase runs (positive control)', !threw && typeof win.quickSetPhase === 'function', threw && threw.message);
  ok('after a reorder, the phase lands on the photo the popup opened on', win._allPhotos[1].phase === 'After', JSON.stringify(win._allPhotos));
  ok('…and not on the photo now at its old index', win._allPhotos[0].phase === 'Before');
}

console.log('ONE toggleTask, ON THE LIVE STORE (DT-F10)');
{
  ok('customer-bootstrap.module.js no longer defines window.toggleTask', !/window\.toggleTask\s*=/.test(BOOT));
  ok('customer-tasks-ui.js defines it (positive control)…', /window\.toggleTask\s*=\s*async function/.test(TASKS_UI));
  ok('…writing leads/{leadId}/tasks', /doc\(window\.db, 'leads', window\._customerId, 'tasks', taskId\)/.test(TASKS_UI));
  ok('nothing on the customer page writes the retired top-level tasks store', !/doc\(db, 'tasks', taskId\)/.test(BOOT));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
