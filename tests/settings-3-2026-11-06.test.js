/**
 * tests/settings-3-2026-11-06.test.js — CRM audit 2026-11-06, Settings round 3.
 *
 * ST-F41 admin-manager.js render(): Team Manager showed "Rotate Access Codes"
 *        and "Run Migrations" to every company owner; both are platform-admin
 *        callables (403 for everyone else), and the prompt names NBD's codes.
 * ST-F65 pricing-page.module.js subscribe(): read auth.currentUser before the
 *        session was restored, so a signed-in user who tapped a plan right
 *        after load was told to create an account.
 * Real code in a vm. Zero deps. Run: node tests/settings-3-2026-11-06.test.js
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

(async function main() {
  console.log('PLATFORM-ADMIN TOOLS (ST-F41)');
  {
    const SRC = read('admin-manager.js');
    const s = SRC.indexOf('  function render() {');
    const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n  }\n', s) + 4) : '';
    ok('render found (positive control)', /adminRosterContainer/.test(fn));
    const run = (claims) => {
      const btns = [{ style: { display: 'x' } }, { style: { display: 'x' } }];
      let sel = '';
      const sb = { window: { _userClaims: claims }, document: { querySelectorAll: (q) => { sel = q; return btns; }, getElementById: () => null }, state: {} };
      vm.createContext(sb);
      vm.runInContext(fn + '\nrender();', sb);
      return { btns, sel };
    };
    const owner = run({ role: 'company_admin', companyId: 'co' });
    ok('it targets exactly the two platform tools', /rotateAccessCodes/.test(owner.sel) && /runMigrationsNow/.test(owner.sel));
    ok('a company owner / company_admin does not see them', owner.btns.every((b) => b.style.display === 'none'));
    const solo = run({});
    ok('a solo owner does not see them either', solo.btns.every((b) => b.style.display === 'none'));
    const admin = run({ role: 'admin' });
    ok('the platform admin still sees them (positive control)', admin.btns.every((b) => b.style.display === ''));
  }

  console.log('CHECKOUT WAITS FOR THE SESSION (ST-F65)');
  {
    const SRC = read('pricing-page.module.js');
    const s = SRC.indexOf('window.subscribe = async function(plan, evt) {');
    const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n};\n', s) + 4) : '';
    ok('subscribe found (positive control)', /auth\.currentUser/.test(fn));
    const order = [];
    const auth = {
      authStateReady() { order.push('ready'); return Promise.resolve(); },
      get currentUser() { order.push('read'); return null; },
    };
    const sb = { window: {}, auth, confirm: () => false, console: { log() {}, warn() {}, error() {} } };
    vm.createContext(sb);
    vm.runInContext(fn, sb);
    try { await sb.window.subscribe('starter', null); } catch (e) { /* the declined-confirm path may return early */ }
    ok('the restored session is awaited before currentUser is read', order[0] === 'ready' && order.indexOf('read') > 0, order.join(','));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
