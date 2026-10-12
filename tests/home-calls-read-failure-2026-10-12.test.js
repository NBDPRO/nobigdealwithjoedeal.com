#!/usr/bin/env node
/**
 * Audit R5 (2026-10-12): Home's "people need you" strip rendered a FAILED
 * phone_calls / phone_text_days read as nothing (".catch(() => {})" -> empty
 * list -> strip hidden = "all clear"). The strip must now say it could not
 * check. Executes docs/pro/js/home-attention.js in a vm with a fake Firestore.
 * Run: node tests/home-calls-read-failure-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/home-attention.js'), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

async function renderWith({ failCollections, rows }) {
  const el = { innerHTML: '', hidden: true };
  const w = {
    document: { readyState: 'complete', getElementById: (id) => (id === 'homeAttention' ? el : null), addEventListener() {} },
    addEventListener() {}, dispatchEvent() {}, CustomEvent: function () {}, setTimeout: () => 0,
    location: { hash: '' },
    _user: { uid: 'u1' }, _userClaims: { role: 'owner' }, _leads: [],
    db: {}, collection: (db, name) => ({ name }), where: () => ({}), orderBy: () => ({}), limit: () => ({}),
    query: (col) => col,
    getDocs: async (q) => {
      if ((failCollections || []).includes(q.name)) throw new Error('failed-precondition: index');
      return { docs: ((rows || {})[q.name] || []).map((r, i) => ({ id: 'd' + i, data: () => r })) };
    },
  };
  w.window = w;
  const ctx = vm.createContext(Object.assign(w, { console, Date, Promise, Map, Set, Array, Object, String, Number, Math, JSON, isFinite, Error, Intl }));
  // the IIFE reads `window` / `document` as globals
  vm.runInContext(SRC, ctx, { filename: 'home-attention.js' });
  await w.NBDHomeAttention.render(true);
  return el;
}

(async () => {
  const NOW = Date.now();
  const urgentCall = { urgent: true, startedAtMs: NOW - 60000, phoneDigits: '8595550147' };

  console.log('A. executed render');
  let el = await renderWith({ failCollections: ['phone_calls'], rows: {} });
  ok('phone_calls read FAILS -> the strip is shown with a warning, not hidden', el.hidden === false && /Could not check your calls/.test(el.innerHTML) && /NOT an all-clear/.test(el.innerHTML), JSON.stringify(el));
  el = await renderWith({ failCollections: ['phone_text_days'], rows: { phone_calls: [urgentCall] } });
  ok('texts read fails but calls loaded -> warning AND the count so far', /Could not check/.test(el.innerHTML) && /1 person needs you so far/.test(el.innerHTML), el.innerHTML);
  el = await renderWith({ failCollections: [], rows: {} });
  ok('control: a healthy empty read is still a hidden strip', el.hidden === true && el.innerHTML === '');
  el = await renderWith({ failCollections: [], rows: { phone_calls: [urgentCall] } });
  ok('control: a healthy read with one person shows the normal count, no warning', /1 person needs you/.test(el.innerHTML) && !/Could not check/.test(el.innerHTML));

  console.log('B. the pure strip');
  const HA = require(path.join(__dirname, '..', 'docs/pro/js/home-attention.js'));
  ok('stripHtml({callsFailed}) names the Call Center target', /data-target="calls"/.test(HA.stripHtml({ callsFailed: true, calls: 0 })));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
