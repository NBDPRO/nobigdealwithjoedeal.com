// CRM audit 2026-11-06 (CU-F19): six customer-page write entry points now call
// NBDRole.guard() first, like their neighbours, so a viewer is told "view-only"
// and nothing is written. Runs each shipped function with a viewer guard.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0, failed = 0;
function check(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

function liftAssigned(src, name) {
  const lines = src.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith('window.' + name + ' = '));
  const j = lines.findIndex((l, k) => k > i && /^\};?\s*$/.test(l));
  return i >= 0 && j > i ? lines.slice(i, j + 1).join('\n') : '';
}
function liftIndented(src, name) {
  const lines = src.split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp('^  (async )?function ' + name + '\\(').test(l));
  const j = lines.findIndex((l, k) => k > i && l === '  }');
  return i >= 0 && j > i ? lines.slice(i, j + 1).join('\n') : '';
}

// Every touch of the page or the database counts. A guarded function returns
// before any of them.
function viewerCtx() {
  const touched = [];
  const trap = new Proxy(function () {}, {
    get: (_, k) => { if (k === Symbol.toPrimitive) return () => ''; if (k === 'then') return undefined; touched.push(String(k)); return trap; },
    apply: () => { touched.push('call'); return trap; },
  });
  let guarded = 0;
  const window = new Proxy({ NBDRole: { guard: () => { guarded++; return false; } } }, {
    get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : (touched.push('window.' + String(k)), trap)),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { ctx: { window, document: trap, console: { warn() {}, log() {}, error() {} } }, touched, guarded: () => guarded };
}

const tasks = read('docs/pro/js/customer-tasks-ui.js');
const FNS = [
  ['openEventModal', []], ['applyBulkPhotoUpdate', ['stage', 'x']], ['applyBulkPhotoDelete', []],
  ['quickSaveMeta', []], ['deletePhoto', ['p1']],
];
(async () => {
  for (const [name, args] of FNS) {
    const fn = liftAssigned(tasks, name);
    const v = viewerCtx();
    let ok = !!fn;
    try {
      vm.runInNewContext(fn, v.ctx);
      await Promise.resolve(v.ctx.window[name].apply(null, args));
    } catch (e) { ok = false; }
    check(name + ': a viewer is stopped before anything is touched', ok && v.guarded() === 1 && v.touched.length === 0);
  }
  const docsSrc = read('docs/pro/js/customer-documents.js');
  const tfn = liftIndented(docsSrc, 'toggleHomeownerShare');
  const v = viewerCtx();
  let ok = !!tfn;
  try { vm.runInNewContext(tfn + '\nout = toggleHomeownerShare("d1", {});', v.ctx); await v.ctx.out; } catch (e) { ok = false; }
  check('toggleHomeownerShare: a viewer is stopped before anything is touched', ok && v.guarded() === 1 && v.touched.length === 0);

  console.log('\nviewer-guard-customer: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
