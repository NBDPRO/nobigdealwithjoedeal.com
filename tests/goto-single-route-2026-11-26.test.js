/**
 * tests/goto-single-route-2026-11-26.test.js
 *
 * One goTo() = one route. goTo('d2d') writes '#/d2d'; the browser then fires
 * 'hashchange', and dashboard-main.js's listener called goTo('d2d',
 * {skipHash:true}) a SECOND time ~20 ms later. Every view ran its setup
 * twice. On D2D that meant two waitForD2D polls, two D2D.init() calls, and
 * the second one's renderD2D() replaced #d2dContent — including the Knock
 * button. On a slow CI runner the knock sheet had already opened off the
 * first button, so closing it had no live opener to refocus and focus fell
 * to <body> (crm-overlay-keyboard-2026-10-26 "New knock: focus is back on
 * the button that opened it", a random red on the Pro demo walk).
 *
 * The fix: goTo remembers the hash it just wrote, and the hashchange listener
 * ignores exactly that one echo. Browser Back/Forward (a hash goTo did not
 * write) still routes.
 *
 * This runs the REAL hashchange listener (dashboard-main.js) and the REAL
 * hash-writing block of goTo (lifted from dashboard-actions.js) against a
 * fake window whose location.hash setter queues a hashchange, the way a
 * browser does.
 *
 * Pure Node. Run: node tests/goto-single-route-2026-11-26.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
const actionsSrc = fs.readFileSync(path.join(JS, 'dashboard-actions.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(JS, 'dashboard-main.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(JS, 'dashboard-state.js'), 'utf8');

let failed = 0;
function ok(label, cond, extra) {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.log('  ✗ ' + label + (extra !== undefined ? ' (' + extra + ')' : '')); }
}

// goTo's hash-writing block: from `if (!params.skipHash) {` to its closing brace.
const start = actionsSrc.indexOf('if (!params.skipHash) {');
let hashBlock = '';
if (start >= 0) {
  let depth = 0;
  for (let i = start; i < actionsSrc.length; i++) {
    const c = actionsSrc[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { hashBlock = actionsSrc.slice(start, i + 1); break; } }
  }
}
const routeFn = (stateSrc.match(/function routeFromHash\s*\([\s\S]*?\n\}/) || [''])[0];

function makeWorld() {
  const listeners = {};
  const queue = [];
  const calls = [];
  let hash = '';
  const location = {
    get hash() { return hash; },
    set hash(v) {
      const next = v.charAt(0) === '#' ? v : '#' + v;
      if (next !== hash) { hash = next; queue.push('hashchange'); }
    },
  };
  const window = {
    location,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const document = { addEventListener() {}, getElementById() { return null; } };
  const ctx = vm.createContext({ window, document, console, setInterval, clearInterval });
  vm.runInContext(routeFn, ctx);
  vm.runInContext('var routeConfig = { home:1, crm:1, d2d:1, map:1 };', ctx);
  ctx.__calls = calls;
  // A goTo with the real hash-writing block; it records every call it gets.
  vm.runInContext(
    'function goTo(name, params) { params = params || {}; __calls.push({ name: name, skipHash: !!params.skipHash });\n' +
    hashBlock + '\n}', ctx);
  vm.runInContext(mainSrc, ctx);
  return {
    goTo: (n, p) => ctx.goTo(n, p),
    calls,
    setHashFromBrowser(v) { location.hash = v; },
    flush() {
      while (queue.length) {
        const t = queue.shift();
        (listeners[t] || []).forEach((fn) => fn({ type: t }));
      }
    },
    hash: () => hash,
  };
}

console.log('\ngoTo SINGLE ROUTE: the hashchange echo of goTo\'s own write is ignored');
ok('lifted the hash-writing block from goTo', hashBlock.length > 0);
ok('lifted routeFromHash', routeFn.length > 0);
{
  const w = makeWorld();
  w.goTo('d2d');
  w.flush();
  ok("goTo('d2d') wrote '#/d2d'", w.hash() === '#/d2d', w.hash());
  ok("goTo('d2d') routes ONCE (no second goTo from the hashchange echo)",
     w.calls.length === 1, JSON.stringify(w.calls));

  w.goTo('crm');
  w.flush();
  ok("a second navigation also routes once", w.calls.length === 2, JSON.stringify(w.calls));

  // Browser Back: the hash changes without goTo writing it. That MUST route.
  w.setHashFromBrowser('#/d2d');
  w.flush();
  const last = w.calls[w.calls.length - 1];
  ok('browser Back (a hash goTo did not write) still routes',
     w.calls.length === 3 && last.name === 'd2d' && last.skipHash === true, JSON.stringify(w.calls));

  // goTo to the view already in the hash writes nothing, so no echo is
  // pending; a later Back to that same hash must not be swallowed.
  w.goTo('d2d');
  w.flush();
  ok('goTo to the current hash routes once', w.calls.length === 4, JSON.stringify(w.calls));
  w.setHashFromBrowser('#/crm');
  w.flush();
  w.setHashFromBrowser('#/d2d');
  w.flush();
  ok('no stale echo marker: later Back/Forward both route', w.calls.length === 6, JSON.stringify(w.calls));

  // Deep link with an id round-trips once too.
  w.goTo('crm', { id: 'abc' });
  w.flush();
  ok("goTo('crm', {id}) routes once", w.calls.length === 7 && w.hash() === '#/crm/abc', JSON.stringify(w.calls));
}

console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
process.exit(failed ? 1 : 0);
