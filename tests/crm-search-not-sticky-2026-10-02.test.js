/**
 * tests/crm-search-not-sticky-2026-10-02.test.js
 *
 * Jo (2026-10-02): "when I search something on kanban it sticks even when I
 * refresh or come back to CRM page".
 *
 * Cause: kanbanFilter saved every search to localStorage['nbd_crm_search'],
 * which outlives the session. restoreCrmSearch, run on every leads load,
 * then wrote it back into the box, lowercased. prefs-sync.js always called
 * the key "session-local".
 *
 * Now:
 *   - the search lives only in the box;
 *   - restoreCrmSearch only DROPS a value the old code left behind;
 *   - goTo() clears the box when leaving the Pipeline.
 * Proven end to end on the emulator in a signed-in Chrome session: main kept
 * the search after a reload; with the fix the box is empty after a reload and
 * after leaving and returning (all cards back), and a mid-session data
 * refresh keeps the current search.
 *
 * This suite runs the REAL functions in a vm with a fake DOM and storage.
 * Run: node tests/crm-search-not-sticky-2026-10-02.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// Lift one top-level `function name(...) {...}` out of a file.
function lift(file, name) {
  const src = fs.readFileSync(path.join(JS, file), 'utf8');
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error(name + ' not found in ' + file);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}

function sandbox(boxValue, saved) {
  const store = new Map(saved == null ? [] : [['nbd_crm_search', saved]]);
  const writes = [];
  const els = {
    crmSearch: { value: boxValue },
    crmDmgFilter: { value: '' },
    crmSearchClear: { style: {} },
    crmSearchCount: { textContent: '' },
  };
  const renders = [];
  const ctx = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { writes.push(k); store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    document: { getElementById: (id) => els[id] || null },
    window: { _leads: [{ id: 'a' }, { id: 'b' }] },
    renderLeads: (all, subset) => renders.push(subset === undefined ? 'all' : (subset === null ? 'null' : 'subset')),
    _crmSearchFilter: () => [{ id: 'a' }],
    _searchQuery: null,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(lift('crm-pipeline.js', 'kanbanFilter') + '\n' + lift('crm-portal-bridge.js', 'restoreCrmSearch') + '\nthis.kanbanFilter = kanbanFilter; this.restoreCrmSearch = restoreCrmSearch;', ctx);
  return { ctx, store, writes, els, renders };
}

console.log('\n1. Searching saves nothing');
{
  const t = sandbox('Smith', null);
  t.ctx.kanbanFilter();
  ok('kanbanFilter writes no nbd_crm_search', !t.writes.includes('nbd_crm_search') && !t.store.has('nbd_crm_search'), JSON.stringify(t.writes));
  ok('...and still filters what is in the box', t.renders[t.renders.length - 1] === 'subset' && t.els.crmSearchClear.style.display === 'flex');
  const old = sandbox('Smith', 'smith');
  old.ctx.kanbanFilter();
  ok('a value the old code saved is dropped the next time the board filters', !old.store.has('nbd_crm_search'));
}

console.log('\n2. Loading the page restores nothing');
{
  const t = sandbox('', 'smith');
  t.ctx.restoreCrmSearch();
  ok('a saved search from before the fix does NOT come back into the box', t.els.crmSearch.value === '', JSON.stringify(t.els.crmSearch.value));
  ok('...and the leftover key is deleted', !t.store.has('nbd_crm_search'));
  const live = sandbox('Smith', null);
  live.ctx.restoreCrmSearch();
  ok('a mid-session leads reload leaves the CURRENT box alone (case kept)', live.els.crmSearch.value === 'Smith');
}

console.log('\n3. Leaving the Pipeline clears the box');
{
  const src = fs.readFileSync(path.join(JS, 'dashboard-actions.js'), 'utf8');
  // Run the leave-clear block itself: goTo's body is too entangled to run
  // whole, so find the guarded block (inside goTo) and execute it with a
  // fake DOM.
  const norm = src.replace(/\r\n/g, '\n');
  const at2 = norm.indexOf("if (name !== 'crm') {\n    const _crmSearchEl", norm.indexOf('function goTo('));
  ok('goTo has the leave-the-Pipeline clear', at2 > 0);
  if (at2 < 0) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  let i = norm.indexOf('{', at2), depth = 0;
  for (; i < norm.length; i++) { if (norm[i] === '{') depth++; else if (norm[i] === '}' && --depth === 0) break; }
  const block = norm.slice(at2, i + 1);
  const run = (name, value) => {
    const box = { value }; let filtered = 0;
    const ctx = { name, document: { getElementById: (id) => (id === 'crmSearch' ? box : null) }, window: { kanbanFilter: () => { filtered++; } } };
    vm.createContext(ctx); vm.runInContext(block, ctx);
    return { box, filtered };
  };
  const leave = run('dash', 'Smith');
  ok('going anywhere else empties the box and re-filters (every card back on return)', leave.box.value === '' && leave.filtered === 1);
  const stay = run('crm', 'Smith');
  ok('going to the Pipeline itself keeps the search', stay.box.value === 'Smith' && stay.filtered === 0);
  const empty = run('dash', '');
  ok('an empty box costs nothing (no re-filter)', empty.filtered === 0);
  ok('prefs-sync no longer calls the key session-local', !/nbd_crm_search\s+search query — session-local/.test(fs.readFileSync(path.join(JS, 'prefs-sync.js'), 'utf8')) && src.length > 0);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
