/**
 * tests/field-sunlight-2026-10-19.test.js
 *
 * Grabber idea #12: Sunlight mode in EVERY layout (not just the Field App) as
 * a Comfort setting, with an Auto mode at a customer's address.
 * BEHAVIOUR test: docs/pro/js/field-sunlight.js runs whole in a vm sandbox.
 *
 *   - default is off; junk stored values fall back to off
 *   - On adds html.sun-all; Off removes it; the choice persists (nbd_sunlight)
 *   - Auto: off until a fix lands inside 150 m of a lead, on there, still on at
 *     200 m (hysteresis), off past 250 m; leads without coordinates never match
 *   - Auto never prompts: permission not granted -> no getCurrentPosition call
 *   - leaving Auto clears the on-site latch
 *   - wiring: preboot stamps 'on', sign-out keeps the key, markup + CSS exist
 *
 * Run: node tests/field-sunlight-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const SRC = rd('docs/pro/js/field-sunlight.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function boot(o) {
  o = o || {};
  const store = Object.assign({}, o.store || {});
  const classes = new Set();
  const listeners = {};
  const sel = { id: 'npm-sunlight', value: 'off' };
  const hint = { id: 'npm-sunlight-hint', textContent: '' };
  const timers = [];
  const geoCalls = { n: 0, pos: o.pos || null, perm: o.perm || 'granted', err: false };
  const doc = {
    readyState: 'complete', hidden: false,
    documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return !!on; } } },
    getElementById: (id) => (id === 'npm-sunlight' ? sel : id === 'npm-sunlight-hint' ? hint : null),
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent: () => true
  };
  const win = {
    document: doc,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    _leads: o.leads || [],
    setInterval: (f) => { timers.push(f); return timers.length; },
    clearInterval: () => {},
    navigator: {
      permissions: { query: () => Promise.resolve({ state: geoCalls.perm }) },
      geolocation: { getCurrentPosition: (cb, errCb) => { geoCalls.n++; if (geoCalls.err) errCb({ code: 3 }); else if (geoCalls.pos) cb({ coords: { latitude: geoCalls.pos[0], longitude: geoCalls.pos[1] } }); } }
    }
  };
  win.window = win;
  vm.createContext(Object.assign(win, { CustomEvent: function (t, d) { this.type = t; this.detail = d && d.detail; }, Math, Number, isFinite, Promise, Infinity }));
  vm.runInContext(SRC, win);
  return { win, store, classes, sel, geoCalls, listeners, setPos: (p) => { geoCalls.pos = p; }, change: (v) => { sel.value = v; listeners.change.forEach((f) => f({ target: sel })); } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  const LEAD = { lat: 39.1, lng: -84.5 };
  const AT = [39.1, -84.5];
  const NEAR200 = [39.1 + 200 / 111320, -84.5];   // ~200 m north
  const FAR = [39.1 + 400 / 111320, -84.5];       // ~400 m north

  console.log('\nmode + persistence');
  let b = boot();
  ok('default is off (nothing changes until someone opts in)', !b.classes.has('sun-all') && b.win.NBDFieldSunlight.getMode() === 'off');
  b = boot({ store: { nbd_sunlight: 'banana' } });
  ok('junk stored value falls back to off', b.win.NBDFieldSunlight.getMode() === 'off' && !b.classes.has('sun-all'));
  b = boot({ store: { nbd_sunlight: 'on' } });
  ok('stored On paints at boot', b.classes.has('sun-all'));
  b = boot();
  b.change('on');
  ok('choosing On adds html.sun-all and persists', b.classes.has('sun-all') && b.store.nbd_sunlight === 'on');
  b.change('off');
  ok('choosing Off removes it and persists', !b.classes.has('sun-all') && b.store.nbd_sunlight === 'off');

  console.log('\nauto at a customer');
  b = boot({ leads: [LEAD], pos: AT });
  b.change('auto');
  ok('auto alone does not turn it on before a fix', !b.classes.has('sun-all') || b.geoCalls.n > 0);
  await tick();
  ok('auto turns on inside 150 m of a lead', b.classes.has('sun-all'));
  b.setPos(NEAR200); b.win.NBDFieldSunlight._poll(); await tick();
  ok('still on at ~200 m (hysteresis)', b.classes.has('sun-all'));
  b.setPos(FAR); b.win.NBDFieldSunlight._poll(); await tick();
  ok('off beyond 250 m', !b.classes.has('sun-all'));
  b = boot({ leads: [LEAD], pos: FAR });
  b.change('auto'); await tick();
  ok('auto stays off when no customer is near', !b.classes.has('sun-all'));
  b = boot({ leads: [{ lat: 0, lng: 0 }, { lat: null, lng: null }, {}], pos: [0, 0] });
  b.change('auto'); await tick();
  ok('leads without real coordinates never match', !b.classes.has('sun-all'));
  b = boot({ leads: [LEAD], pos: AT, perm: 'prompt' });
  b.change('auto'); await tick();
  ok('never prompts from a timer: permission not granted -> no position request', b.geoCalls.n === 0 && !b.classes.has('sun-all'));
  b = boot({ leads: [LEAD], pos: AT });
  b.change('auto'); await tick();
  b.change('off');
  ok('leaving auto turns it off', !b.classes.has('sun-all'));
  b.change('on'); b.change('auto');
  ok('re-entering auto does not inherit the old on-site latch', !b.classes.has('sun-all') || b.geoCalls.n > 1);

  console.log('\npure rules');
  const C = boot().win.NBDFieldSunlight.core;
  console.log('\nfails closed (reviewer findings 2026-10-19)');
  b = boot({ leads: [LEAD], pos: AT });
  b.change('auto'); await tick();
  ok('precondition: on at the address', b.classes.has('sun-all'));
  b.geoCalls.perm = 'denied'; b.win.NBDFieldSunlight._poll(); await tick();
  ok('permission revoked -> off at once', !b.classes.has('sun-all'));
  b = boot({ leads: [LEAD], pos: AT });
  b.change('auto'); await tick();
  b.geoCalls.err = true;
  b.win.NBDFieldSunlight._poll(); await tick();
  ok('one failed fix keeps it on (a single GPS blip does not flicker it)', b.classes.has('sun-all'));
  b.win.NBDFieldSunlight._poll(); await tick();
  ok('two failed fixes in a row -> off', !b.classes.has('sun-all'));
  b = boot({ leads: [LEAD], pos: AT });
  b.change('auto'); await tick();
  b.geoCalls.err = true; b.win.NBDFieldSunlight._poll(); await tick();
  b.geoCalls.err = false; b.win.NBDFieldSunlight._poll(); await tick();
  b.geoCalls.err = true; b.win.NBDFieldSunlight._poll(); await tick();
  ok('a good fix between failures resets the miss count', b.classes.has('sun-all'));
  b = boot({ leads: [LEAD], pos: AT });
  b.change('auto'); await tick();
  b.win._leads = []; b.win.NBDFieldSunlight._poll(); await tick();
  ok('leads list emptied -> off', !b.classes.has('sun-all'));

  ok('shouldBeOn: on / auto+onsite only', C.shouldBeOn('on', false) && C.shouldBeOn('auto', true) && !C.shouldBeOn('auto', false) && !C.shouldBeOn('off', true));
  ok('nextOnSite thresholds', C.nextOnSite(false, 149) && !C.nextOnSite(false, 151) && C.nextOnSite(true, 249) && !C.nextOnSite(true, 251) && !C.nextOnSite(true, Infinity));

  console.log('\nwiring');
  const pre = rd('docs/pro/js/shape-preboot.js');
  ok('preboot stamps sun-all from nbd_sunlight === on', /nbd_sunlight'\) === 'on'\) document\.documentElement\.classList\.add\('sun-all'\)/.test(pre));
  ok('sign-out keeps nbd_sunlight', /'nbd_sunlight'/.test(rd('docs/pro/js/nbd-auth.js')));
  const html = rd('docs/pro/dashboard.html');
  ok('Comfort markup has the select with off/on/auto', /id="npm-sunlight"[\s\S]{0,300}value="off"[\s\S]{0,80}value="on"[\s\S]{0,80}value="auto"/.test(html));
  ok('stylesheet linked; script rides the theme bundle (boot script budget)', /css\/field-sunlight\.css/.test(html) && /'js\/field-sunlight\.js/.test(rd('docs/pro/js/script-loader.js')));
  ok('boot kicks the bundle when sunlight is on/auto', /nbd_sunlight'\)\) >= 0/.test(rd('docs/pro/js/dashboard-state.js')));
  const css = rd('docs/pro/css/field-sunlight.css');
  ok('css: black on white tokens under html.sun-all', /html\.sun-all:not\(#fa-sun\)\s*\{[^}]*--bg:\s*#ffffff[^}]*--t:\s*#000000/.test(css));
  console.log('\nCSS vs My Skin and OS high contrast');
  ok('wallpaper ::before, .myskin-layer, mascot and overlay are hidden under sun-all',
    /html\.sun-all\.my-skin-wallpaper::before\s*\{\s*content:\s*none/.test(css) && /html\.sun-all \.myskin-layer[^{]*\.myskin-mascot[^{]*\{[^}]*display:\s*none\s*!important/.test(css));
  ok('prefers-contrast: more keeps sunlight pure black (specific !important block)',
    /@media \(prefers-contrast: more\)\s*\{\s*html\.sun-all:not\(#fa-sun\)\s*\{[^}]*--m:\s*#000000 !important[^}]*--rule:\s*#000000 !important[^}]*--br:\s*#000000 !important/.test(css));
  ok('header documents its own geofence, not a registerRule', /OWN geofence/.test(rd('docs/pro/js/field-sunlight.js')));

  ok('css: no inline handlers / no external urls', !/url\(/.test(css));

  console.log('\n─'.repeat(1) + '─'.repeat(49));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
