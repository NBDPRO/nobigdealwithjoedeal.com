/**
 * tests/d2d-convert-lock-release-2026-09-28.test.js
 *
 * CRM sweep R13 (2026-09-28) — D2D knock → lead (d2d-tracker-core-2026b.js
 * convertToLead).
 *
 * THE BUG: convertToLead locks the knock (a transaction sets
 * convertedToLead:true) BEFORE writing the lead. When no lead got written —
 * the rep declined the duplicate prompt or hit the plan cap (_saveLead returns
 * null), or the save threw — the lock stayed. Both guards (the local
 * `knock.convertedToLead` check and the transaction) then refused every retry:
 * "Failed to convert to lead", and the prospect could never be converted.
 * _saveLead's own catch comment expected the knock to be left unmarked.
 *
 * THE FIX: every exit that wrote no lead releases the lock; once a lead exists
 * the knock stays converted whatever follows.
 *
 * Runs the REAL convertToLead lifted out of the file into a vm against a fake
 * transactional knocks store. Break-test: against main the release cases go red.
 *
 * Zero deps. Run: node tests/d2d-convert-lock-release-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/d2d-tracker-core-2026b.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function extractFn(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const FN = extractFn(SRC, 'convertToLead');
ok('convertToLead found', !!FN);

// saveLead: 'null' | 'throw' | 'ok'
function rig(saveLead) {
  const store = { k1: { convertedToLead: false } };
  const calls = { save: 0, toasts: [], updateKnock: [] };
  const win = {
    _db: {},
    _user: { uid: 'u1' },
    doc: (_db, coll, id) => ({ coll, id }),
    serverTimestamp: () => 'ts',
    updateDoc: async (ref, data) => { Object.assign(store[ref.id], data); },
    runTransaction: async (_db, fn) => {
      const staged = {};
      const tx = {
        get: async (ref) => ({ exists: () => !!store[ref.id], data: () => Object.assign({}, store[ref.id]) }),
        update: (ref, data) => { staged[ref.id] = Object.assign(staged[ref.id] || {}, data); },
      };
      const r = await fn(tx);
      for (const id of Object.keys(staged)) Object.assign(store[id], staged[id]);
      return r;
    },
    _saveLead: async () => {
      calls.save++;
      if (saveLead === 'throw') throw new Error('network');
      return saveLead === 'null' ? null : 'lead-1';
    },
    showToast: (m, t) => calls.toasts.push(t),
    D2D: null,
  };
  const state = { knocks: [{ id: 'k1', homeowner: 'ZZ_QA Knock', disposition: 'interested', convertedToLead: false }] };
  const ctx = vm.createContext({
    window: win, state, console: { error() {}, warn() {}, log() {} },
    INS_DISPOSITIONS: [], DISPOSITIONS: {},
    loadKnocks: async () => {},
    updateKnock: async (id, d) => { calls.updateKnock.push(d); Object.assign(store[id], d); },
  });
  vm.runInContext(FN + '\nglobalThis.convertToLead = convertToLead;', ctx);
  return { convert: () => ctx.convertToLead('k1'), store, state, calls };
}

(async () => {
  console.log('D2D convertToLead — lock release');
  {
    const r = rig('null');
    await r.convert();
    ok('declined dedup / plan cap: stored knock is NOT left converted', r.store.k1.convertedToLead === false, JSON.stringify(r.store.k1));
    ok('…nor the local cache', r.state.knocks[0].convertedToLead === false);
    await r.convert();
    ok('…so a retry reaches the save again', r.calls.save === 2, 'saves=' + r.calls.save);
  }
  {
    const r = rig('throw');
    await r.convert();
    ok('a failed save releases the lock', r.store.k1.convertedToLead === false && r.state.knocks[0].convertedToLead === false);
    ok('…and still tells the rep it failed', r.calls.toasts.includes('error'));
  }
  {
    const r = rig('ok');
    await r.convert();
    ok('success: the knock stays converted', r.store.k1.convertedToLead === true && r.calls.save === 1);
    await r.convert();
    ok('…and a second call does not create a second lead', r.calls.save === 1);
  }
  {
    const r = rig('ok');
    r.store.k1.convertedToLead = true; // another tab already won the race
    await r.convert();
    ok('already converted in Firestore: no save, lock untouched', r.calls.save === 0 && r.store.k1.convertedToLead === true);
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
