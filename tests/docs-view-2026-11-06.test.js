/**
 * tests/docs-view-2026-11-06.test.js — CRM audit 2026-11-06, Docs view and
 * CSV import.
 *
 * VW-F50  dashboard-ui.js: the Template Library "Blank" buttons were injected
 *         once at script load, before the rows existed (they live in the
 *         un-hydrated tpl-view-docs <template>), and matched an onclick the rows
 *         no longer carry. No Blank button ever existed.
 * VW-F53  dashboard-actions.js / dashboard-api.js: Uploaded Documents loaded only
 *         after an upload in the same session; a failed read showed nothing.
 * VW-F155 data-import.js: closing the import modal mid-run threw at the end and
 *         could paint the old run's result into a reopened modal.
 * Zero deps. Run: node tests/docs-view-2026-11-06.test.js
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

console.log('BLANK BUTTONS (VW-F50)');
{
  const UI = read('dashboard-ui.js');
  // Run whichever shape the file has: the named function (called the way
  // goTo('docs') calls it) or the old run-once IIFE.
  let code = '';
  const sFn = UI.indexOf('function _injectBlankButtons() {');
  const sIife = UI.indexOf('(function injectBlankButtons() {');
  if (sFn >= 0) code = UI.slice(sFn, UI.indexOf('\n}\n', sFn) + 3) + '\n_injectBlankButtons();\n';
  else if (sIife >= 0) code = UI.slice(sIife, UI.indexOf('\n})();\n', sIife) + 7);
  ok('the injector is found (positive control)', code.length > 300);

  function mkEl(tag, attrs) {
    const el = { tagName: tag, attrs: Object.assign({}, attrs), children: [], style: {}, listeners: {}, className: '',
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      addEventListener(t, f) { this.listeners[t] = f; },
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); c.parent = this; return c; },
      querySelector(sel) {
        const cls = sel.replace(/^\./, '');
        return this.children.find((c) => (c.className || '').split(' ').includes(cls) || (c.attrs.class || '') === cls) || null;
      } };
    return el;
  }
  const rows = ['proposal', 'invoice'].map((t) => {
    const r = mkEl('div', { 'data-action': 'docgen', 'data-target': t, class: 'tl-doc-row' });
    r.appendChild(mkEl('span', { class: 'tl-doc-arrow' }));
    return r;
  });
  const calls = [];
  const sandbox = {
    document: { querySelectorAll: (s) => (s === '.tl-doc-row' ? rows : []), createElement: (t) => mkEl(t, {}) },
    window: { NBDDocGen: { generateBlank: (t) => calls.push(t) } },
    showToast() {},
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  try { vm.runInContext(code, sandbox); } catch (e) { ok('the injector runs', false, e.message); }
  const blanks = (r) => r.children.filter((c) => c.tagName === 'button');
  ok('every data-action="docgen" row gets a Blank button', rows.every((r) => blanks(r).length === 1), rows.map((r) => blanks(r).length).join(','));
  const b = blanks(rows[1])[0];
  if (b && b.listeners.click) b.listeners.click({ stopPropagation() {} });
  ok('Blank prints that row\'s own document type', calls.join() === 'invoice', calls.join());
  ok('the button sits before the arrow', !!b && rows[1].children.indexOf(b) < rows[1].children.findIndex((c) => c.attrs.class === 'tl-doc-arrow'));
  if (sFn >= 0) { vm.runInContext('_injectBlankButtons();', sandbox); }
  ok('running it again (every visit to Docs) adds no second button', rows.every((r) => blanks(r).length === 1));
  ok('it is exported for goTo', /window\._injectBlankButtons = _injectBlankButtons;/.test(UI));
}

console.log('DOCS VIEW ENTRY (VW-F50, VW-F53)');
{
  const A = read('dashboard-actions.js');
  const m = A.match(/if\(name==='docs'\) \{[\s\S]*?\n  \}\n/);
  ok('goTo has a docs branch', !!m);
  ok('…which adds the Blank buttons', !!m && /window\._injectBlankButtons\(\)/.test(m[0]));
  ok('…and loads Uploaded Documents', !!m && /window\.loadDocs\(\)/.test(m[0]));
  ok('the docs branch runs after the template is hydrated', A.indexOf("_hydrateViewTemplate(name);") >= 0 && A.indexOf("_hydrateViewTemplate(name);") < A.indexOf("if(name==='docs')"));
}

console.log('UPLOADED DOCUMENTS READ FAILURE (VW-F53)');
{
  const API = read('dashboard-api.js');
  const s = API.indexOf('async function loadDocs(){');
  const fn = s >= 0 ? API.slice(s, API.indexOf('\n}\n', s) + 3) : '';
  ok('loadDocs found (positive control)', fn.length > 200);
  const wrap = { innerHTML: 'old' };
  const sandbox = { window: { _user: { uid: 'u1' }, _db: {}, where: () => ({}) }, document: { getElementById: (id) => (id === 'uploadedDocsWrap' ? wrap : null) },
    console: { error() {} }, collection: () => ({}), query: () => ({}), getDocs: () => Promise.reject(new Error('permission-denied')) };
  vm.createContext(sandbox);
  vm.runInContext(fn + '\nglobalThis.__p = loadDocs();', sandbox);
  sandbox.__p.then(() => {
    ok('a failed read says so in the panel', /Could not load your uploaded documents/.test(wrap.innerHTML), wrap.innerHTML);
    imports();
  });
}

function imports() {
  console.log('IMPORT CLOSED MID-RUN (VW-F155)');
  const DI = read('data-import.js');
  const s = DI.indexOf('async function runImport(');
  const fn = s >= 0 ? DI.slice(s, DI.indexOf('\n  function renderDoneStep(', s)) : '';
  ok('runImport found (positive control)', fn.length > 500 && /renderDoneStep\(\{/.test(fn));
  ok('the run remembers its own modal', /const runModal = modalEl;/.test(fn));
  ok('the result is painted only into that same, still-open modal', /if \(modalEl && modalEl === runModal\) \{\s*renderDoneStep\(/.test(fn));
  ok('otherwise the counts arrive as a toast', /window\.showToast\('Import finished: '/.test(fn));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
