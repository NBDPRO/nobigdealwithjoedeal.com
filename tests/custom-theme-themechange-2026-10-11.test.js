/**
 * tests/custom-theme-themechange-2026-10-11.test.js — the Custom Builder tells
 * the page which background key is live (My Skin keys backgrounds by theme id).
 *
 *   applyCustomTheme()  → themechange, detail '_custom'
 *   resetCustomTheme()  → themechange, detail = ThemeEngine.getCurrent()
 *   dashboard-ui.js     → the auto-theme "remember my manual pick" listener
 *                          ignores reserved '_' keys (it would otherwise store
 *                          '_custom' as the day/night theme)
 *
 * Run: node tests/custom-theme-themechange-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log('  ✓ ' + name);
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function harness(current) {
  const events = [];
  const inputs = {};
  const style = { set: {}, setProperty(k, v) { this.set[k] = v; }, removeProperty(k) { delete this.set[k]; } };
  const el = (id) => inputs[id] || (inputs[id] = { value: '#123456' });
  const document = {
    documentElement: { style },
    body: { style: { background: '' } },
    getElementById: el,
    dispatchEvent(ev) { events.push(ev); return true; }
  };
  const ctx = {
    document, console, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    window: { ThemeEngine: { getCurrent: () => current } }
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/dashboard-custom-theme.js') +
    '\n;this.__apply = applyCustomTheme; this.__reset = resetCustomTheme;', ctx);
  return { ctx, events };
}

console.log('\n1. dashboard-custom-theme.js announces its key');
{
  const h = harness('pokemon');
  h.ctx.__apply();
  ok('apply dispatches exactly one themechange with detail "_custom"',
    h.events.length === 1 && h.events[0].type === 'themechange' && h.events[0].detail === '_custom',
    JSON.stringify(h.events));
  h.events.length = 0;
  h.ctx.__reset();
  ok('reset dispatches themechange with the real current theme id',
    h.events.length === 1 && h.events[0].type === 'themechange' && h.events[0].detail === 'pokemon',
    JSON.stringify(h.events));
  const h2 = harness(undefined);
  h2.ctx.window.ThemeEngine = undefined;
  h2.ctx.__reset();
  ok('reset falls back to nbd-original when ThemeEngine is absent',
    h2.events.length === 1 && h2.events[0].detail === 'nbd-original');
}

console.log('\n2. auto-theme remembers only real theme ids');
{
  const src = read('docs/pro/js/dashboard-ui.js');
  const m = src.match(/function _nbdRememberManualTheme\(ev\) \{[\s\S]*?\n\}\n/);
  ok('listener found (positive control)', !!m);
  const run = (key) => {
    const store = { nbd_auto_theme: '1' };
    const ctx = {
      window: { ThemeEngine: { getCurrent: () => 'nbd-original' } },
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
      nbdAutoThemeIsDay: () => true
    };
    vm.createContext(ctx);
    vm.runInContext(m[0] + '\n;this.__f = _nbdRememberManualTheme;', ctx);
    ctx.__f({ detail: key });
    return store;
  };
  ok('a real id is remembered (positive control)', run('pokemon').nbd_auto_theme_day === 'pokemon');
  ok('"_custom" is not remembered', run('_custom').nbd_auto_theme_day === undefined);
}

console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
process.exit(failed ? 1 : 0);
