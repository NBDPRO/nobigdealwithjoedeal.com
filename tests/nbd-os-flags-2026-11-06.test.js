/**
 * tests/nbd-os-flags-2026-11-06.test.js — NBD OS phase 0: flagged layouts.
 * Since 2026-11-07 the flags are ON unless feature_flags sets them to exactly false.
 *
 * A layout registered with `flag: '<name>'` is hidden from the picker
 * (list / forSurface) and can't be resolved while that flag is off; listAll()
 * still has it. Classic can never be flagged. A saved choice of a dark layout
 * falls back by the normal precedence rule (company default, then Classic),
 * and a company LOCK on a dark layout gives Classic, not the member's pick.
 * The engine installs the check (NBDFlags, else the last-known cache) and
 * re-resolves on `nbd:flags-loaded`.
 *
 * Run: node tests/nbd-os-flags-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/layout-system.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

R._reset();
R.register({ id: 'focus', name: 'Focus', surfaces: ['phone', 'desktop'] });
R.register({ id: 'os', name: 'NBD OS', surfaces: ['phone', 'tablet', 'desktop'], flag: 'osLayout' });
R.register({ id: 'classic', name: 'Classic', flag: 'shouldNotStick' });
R.register({ id: 'bad', name: 'Bad flag', flag: 'has space' });

const ids = (arr) => arr.map((d) => d.id);

console.log('flag off (the default check)');
ok('flagged layout is not in list()', ids(R.list()).indexOf('os') === -1, ids(R.list()).join(','));
ok('flagged layout is not in forSurface(desktop)', ids(R.forSurface('desktop')).indexOf('os') === -1);
ok('listAll() still has it', ids(R.listAll()).indexOf('os') !== -1);
ok('get() still returns it (preview and admin tools)', !!R.get('os'));
ok('Classic is never flagged', R.get('classic').flag === null);
ok('an invalid flag name is dropped', R.get('bad').flag === null);
let r = R.resolve({ surface: 'desktop', user: { id: 'os' } });
ok('a saved dark choice resolves to Classic', r.id === 'classic' && r.source === 'classic', JSON.stringify(r));
r = R.resolve({ surface: 'desktop', user: { id: 'os' }, company: { defaultLayout: 'focus' } });
ok('...or to the company default when there is one', r.id === 'focus' && r.source === 'company-default', JSON.stringify(r));
r = R.resolve({ surface: 'desktop', user: { id: 'focus' }, company: { defaultLayout: 'os', locked: true } });
ok('a company lock on a dark layout gives Classic, not the member pick', r.id === 'classic' && r.source === 'company-lock-fallback', JSON.stringify(r));

console.log('flag on');
R.setFlagCheck((n) => n === 'osLayout');
ok('list() shows it', ids(R.list()).indexOf('os') !== -1);
ok('forSurface(phone) shows it', ids(R.forSurface('phone')).indexOf('os') !== -1);
r = R.resolve({ surface: 'phone', user: { id: 'os' } });
ok('the saved choice resolves', r.id === 'os' && r.source === 'user', JSON.stringify(r));

console.log('a throwing or non-boolean check counts as off');
R.setFlagCheck(() => { throw new Error('boom'); });
ok('throwing check: hidden', ids(R.list()).indexOf('os') === -1);
R.setFlagCheck(() => 'yes');
ok('truthy non-true value: hidden', ids(R.list()).indexOf('os') === -1);
R.setFlagCheck(null);
ok('null check resets to off', ids(R.list()).indexOf('os') === -1);

console.log('engine wiring');
ok('engine installs the check', /R\.setFlagCheck\(isFlagOn\)/.test(SRC));
ok('live NBDFlags wins once loaded (on unless exactly false)', /if \(liveFlags\(\)\) return window\.NBDFlags\.get\(name\) !== false;/.test(SRC));

// 2026-11-07 (Joe: "completely turn it on live, nothing dark"): a layout flag is ON unless
// feature_flags sets it to exactly false. Run the engine's real flag functions against stubs.
console.log('on by default, false is the kill switch');
{
  const cut = (from, to) => { const i = SRC.indexOf(from), j = SRC.indexOf(to, i); return i >= 0 && j > i ? SRC.slice(i, j) : ''; };
  const body = cut('  function liveFlags() {', '  function onFlagsLoaded() {');
  ok('control: found liveFlags / cachedFlags / isFlagOn', /function isFlagOn/.test(body) && /function cachedFlags/.test(body));
  function run(flagsDoc, loaded, cache) {
    const window = { NBDFlags: { isLoaded: () => loaded, enabled: (n) => !!flagsDoc[n], get: (n) => flagsDoc[n] }, _user: { uid: 'u1' } };
    const lsGet = () => (cache === undefined ? null : JSON.stringify({ uid: 'u1', flags: cache }));
    const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
    return new Function('window', 'lsGet', 'parse', 'FLAGS_KEY', body + '\nreturn isFlagOn;')(window, lsGet, parse, 'k');
  }
  ok('live: a flag nobody set is ON', run({}, true)('osLayout') === true);
  ok('live: set true is ON', run({ osLayout: true }, true)('osLayout') === true);
  ok('live: set false is OFF (the kill switch)', run({ osLayout: false }, true)('osLayout') === false);
  ok('live: only an exact false turns it off (0 / null stay on)', run({ osLayout: 0 }, true)('osLayout') === true && run({ osLayout: null }, true)('osLayout') === true);
  ok('before the flags load, with no cache: ON', run({}, false)('osSystemLayer') === true);
  ok('before the flags load, a cached false keeps it OFF', run({}, false, { osSystemLayer: false })('osSystemLayer') === false);
  ok('the cache records false only for an exact false', /flags\[n\] = window\.NBDFlags\.get\(n\) !== false;/.test(SRC));
  ok('the system layer starts before the flag read unless last known off', /cachedFlags\(\)\[SYSTEM_FLAG\] !== false\) loadSystemLayer\(\)/.test(SRC));
}
ok('re-resolves on nbd:flags-loaded', /addEventListener\('nbd:flags-loaded', onFlagsLoaded\)/.test(SRC));
ok('last-known cache is per account', /c\.uid && c\.uid !== who/.test(SRC));
ok('boot never paints a dark stamped layout', /R\.flagOn\(R\.get\(stamped\)\)/.test(SRC));

R._reset();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
