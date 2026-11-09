// CRM audit 2026-11-06 (PL-F27): sign-out stops the live estimates listener
// BEFORE signOut(auth), so it never errors permission-denied and re-fetches
// during teardown. Runs the shipped _signOut with stubs and records the order.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');
let passed = 0, failed = 0;
function check(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }
function liftAssigned(name) {
  const lines = src.split(/\r?\n/);
  // The function form: window._signOut is also assigned the SDK's signOut once, earlier.
  const i = lines.findIndex((l) => l.startsWith('  window.' + name + ' = ') && /(=> \{|function \(\) \{)\s*$/.test(l));
  const j = lines.findIndex((l, k) => k > i && /^ {2,3}\};\s*$/.test(l));
  return i >= 0 && j > i ? lines.slice(i, j + 1).join('\n') : '';
}

const signOutFn = liftAssigned('_signOut');
const unsubFn = liftAssigned('_unsubscribeEstimates');
check('_signOut is present', !!signOutFn);
check('window._unsubscribeEstimates exists', !!unsubFn);

const order = [];
const ctx = {
  window: { NBDAuth: null, NBDSmsOutbox: null, location: { replace: () => order.push('redirect') } },
  localStorage: { length: 0, key: () => null, removeItem() {} },
  auth: {}, signOut: async () => { order.push('signOut'); },
  Promise, console: { warn() {}, log() {} },
};
(async () => {
  let ok = true;
  try {
    vm.runInNewContext('let _estimatesUnsub = () => order.push("unsubscribed");\n' + unsubFn + '\n' + signOutFn, Object.assign(ctx, { order }));
    await ctx.window._signOut();
  } catch (e) { ok = false; console.log('    ' + e.message); }
  const u = order.indexOf('unsubscribed'), s = order.indexOf('signOut');
  check('sign-out stops the estimates listener', ok && u >= 0);
  check('...before the auth token goes', ok && u >= 0 && s > u);
  check('sign-out still signs out and redirects', ok && s >= 0 && order.includes('redirect'));
  console.log('\nsignout-estimates-unsub: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
