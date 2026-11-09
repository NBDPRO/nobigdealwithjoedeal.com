/**
 * tests/pricing-signed-out-redirect-2026-11-08.test.js — the public pricing
 * page sends a signed-out visitor straight to register (CRM audit ST-F63).
 *
 * subscribe() asked "Create your account to continue to checkout?" in a native
 * confirm() before the redirect: the dialog rule says no native dialogs, and
 * the question only made a stranger agree to the page they were already
 * asking for. Now it redirects, with the plan passed only when it is one of
 * the three real plans.
 *
 * Runs the real subscribe() in a vm (the settings-3 harness).
 * Run: node tests/pricing-signed-out-redirect-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/pricing-page.module.js'), 'utf8').replace(/\r\n/g, '\n');
const s = SRC.indexOf('window.subscribe = async function(plan, evt) {');
const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n};\n', s) + 4) : '';
ok('control: subscribe is found', /auth\.currentUser/.test(fn));

async function run(plan, user) {
  let confirms = 0;
  const auth = { authStateReady: () => Promise.resolve(), get currentUser() { return user; } };
  const sb = { window: { location: { href: '/pro/pricing.html' } }, auth, confirm: () => { confirms++; return false; }, fetch: () => { throw new Error('no network in this test'); }, getFunctionsBase: () => '', console: { log() {}, warn() {}, error() {} } };
  vm.createContext(sb);
  vm.runInContext(fn, sb);
  try { await sb.window.subscribe(plan, null); } catch (e) { /* signed-in path has no network here */ }
  return { href: sb.window.location.href, confirms };
}

(async () => {
  console.log('\nPRICING: signed out');
  {
    const r = await run('team', null);
    ok('a signed-out tap on Team goes straight to register with the plan', r.href === '/pro/register.html?plan=team', r.href);
    ok('no native confirm is asked', r.confirms === 0, r.confirms);
  }
  {
    const r = await run('starter', null);
    ok('Starter carries its plan too', r.href === '/pro/register.html?plan=starter', r.href);
  }
  {
    const r = await run('<script>', null);
    ok('an unknown plan is not put in the URL', r.href === '/pro/register.html', r.href);
  }
  {
    const r = await run('team', { getIdToken: async () => 'tok' });
    ok('a signed-in user is not redirected (checkout path)', r.href === '/pro/pricing.html' && r.confirms === 0, r.href);
  }
  ok('the file has no native confirm() left', !/\bconfirm\(/.test(SRC.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('this suite is in the node bucket', fs.readFileSync(path.join(ROOT, 'tests/ci-manifest.json'), 'utf8').indexOf('"pricing-signed-out-redirect-2026-11-08.test.js"') >= 0);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
