/**
 * tests/my-skin-background-style-2026-10-19.test.js
 *
 * The "Background style" radios (Color theme | Real theme wallpaper) in
 * Settings > Appearance > My Skin. BEHAVIOUR test: docs/pro/js/my-skin.js runs
 * whole in a vm sandbox, a radio is "clicked" through the document's own
 * 'change' listener, and the result is read from the saved Firestore write
 * (setDoc) and from what the radios show afterwards.
 *
 *   - Wallpaper turns My Skin AND per-theme on and saves; Color theme turns
 *     per-theme off and saves
 *   - off -> wallpaper -> color returns to enabled=false (a saved wallpaper,
 *     texture or mascot never wakes up); on -> wallpaper -> color stays on
 *   - a manual "Use My Skin" switch in between drops the remembered value
 *   - the radios show wallpaper only when My Skin is on AND per-theme is on
 *   - the company-background note shows only when a company picture paints
 *     under Color theme
 *   - markup: each label owns the right input; real radios sharing one name
 *
 * Run: node tests/my-skin-background-style-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const snapOf = (data) => ({ exists: () => !!data, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });

// A window/document just big enough for my-skin.js to boot, load a config and
// render the style radios. Elements are plain objects looked up by id.
function boot(mySkin, company, extra) {
  const els = {};
  const mk = (id, o) => (els[id] = Object.assign({ id, checked: false, hidden: false, disabled: false, value: '', textContent: '',
    matches: () => false, closest: () => null, setAttribute() {}, removeAttribute() {}, hasAttribute() { return true; },
    style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, contains() { return false; } },
    querySelector: () => null, querySelectorAll: () => [] }, o || {}));
  ['myskinPanel', 'myskinEnabled', 'myskinStyleWallpaper', 'myskinStyleColor', 'myskinStyleCo'].forEach((id) => mk(id));
  els.myskinStyleCo.hidden = true;
  const listeners = {};
  const nullEl = () => ({ hidden: false, innerHTML: '', style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; }, appendChild() {}, remove() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
  const html = nullEl(); html.classList = Object.assign([], { add() {}, remove() {}, contains() { return false; } });
  const document = {
    readyState: 'complete', body: nullEl(), documentElement: html, activeElement: null,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [], createElement: nullEl,
  };
  const writes = [];
  const fast = (fn, ms) => setTimeout(fn, Math.max(0, Math.ceil((ms || 0) / 50)));
  const win = Object.assign({
    document, setTimeout: fast, clearTimeout, console, Promise, Date, JSON, Math, Object, Array, String, Number, Error, RegExp,
    MutationObserver: function () { this.observe = () => {}; },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    _user: { uid: 'u1', displayName: 'Jo Test' }, db: {}, storage: {},
    doc: (db, ...parts) => ({ path: parts.join('/') }),
    onSnapshot: (ref, a, b) => { const next = typeof a === 'function' ? a : b; setTimeout(() => next(ref.path.indexOf('skin/config') > -1 ? snapOf(company || null) : snapOf({ mySkin })), 1); return () => {}; },
    getDoc: async () => snapOf({ mySkin }),
    setDoc: async (ref, data) => { writes.push(data.mySkin); },
  }, extra || {});
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  const load = (rel) => vm.runInContext(rd(rel), ctx, { filename: rel });
  load('docs/pro/js/my-skin-logic.js');
  load('docs/pro/js/my-skin.js');
  const click = async (id, checked) => { els[id].checked = checked === undefined ? true : checked; (listeners.change || []).forEach((f) => f({ target: els[id] })); await tick(10); };
  const cfg = () => ctx.NBDMySkin.state().cfg;
  const ready = async () => { for (let i = 0; i < 200 && !cfg(); i++) await tick(10); await tick(20); };
  return { ctx, els, writes, click, cfg, ready, listeners };
}
const last = (w) => w[w.length - 1];
const shows = (b) => (b.els.myskinStyleWallpaper.checked ? 'wallpaper' : '') + (b.els.myskinStyleColor.checked ? 'color' : '');

(async () => {
  console.log('\nclicking the radios');
  {
    const b = boot({ enabled: false, perTheme: false }); await b.ready();
    ok('a saved config loads (enabled off, per-theme off)', !!b.cfg() && b.cfg().enabled === false && b.cfg().perTheme === false);
    ok('radios start on Color theme', shows(b) === 'color', shows(b));
    await b.click('myskinStyleWallpaper');
    ok('Real theme wallpaper: My Skin AND per-theme on', b.cfg().enabled === true && b.cfg().perTheme === true, JSON.stringify(b.cfg()));
    ok('…and it was saved', b.writes.length === 1 && last(b.writes).enabled === true && last(b.writes).perTheme === true, JSON.stringify(b.writes));
    ok('…and the radios now show wallpaper', shows(b) === 'wallpaper', shows(b));
    await b.click('myskinStyleColor');
    ok('back to Color theme: My Skin is off again (off -> wallpaper -> color)', b.cfg().enabled === false && b.cfg().perTheme === false, JSON.stringify(b.cfg()));
    ok('…and that was saved too', b.writes.length === 2 && last(b.writes).enabled === false && last(b.writes).perTheme === false, JSON.stringify(b.writes));
    ok('…and the radios show Color theme', shows(b) === 'color', shows(b));
  }
  {
    const b = boot({ enabled: true, perTheme: false }); await b.ready();
    await b.click('myskinStyleWallpaper');
    await b.click('myskinStyleColor');
    ok('a user with My Skin on keeps it on after wallpaper -> color', b.cfg().enabled === true && b.cfg().perTheme === false && last(b.writes).enabled === true, JSON.stringify(b.cfg()));
  }
  {
    const b = boot({ enabled: false, perTheme: false }); await b.ready();
    await b.click('myskinStyleWallpaper');
    await b.click('myskinEnabled', false);                 // user turns Use My Skin OFF by hand
    ok('turning Use My Skin off by hand while in wallpaper mode saves enabled=false', b.cfg().enabled === false && last(b.writes).enabled === false);
    ok('…and the radios then show Color theme (nothing would paint)', shows(b) === 'color', shows(b));
    await b.click('myskinEnabled', true);
    await b.click('myskinStyleColor');
    ok('a manual switch drops the remembered value: Color theme leaves My Skin as the user set it (on)', b.cfg().enabled === true && b.cfg().perTheme === false, JSON.stringify(b.cfg()));
  }

  console.log('\nwhat the radios show for a stored config');
  for (const [name, cfg, want] of [
    ['enabled + per-theme', { enabled: true, perTheme: true }, 'wallpaper'],
    ['per-theme but My Skin off (nothing paints)', { enabled: false, perTheme: true }, 'color'],
    ['enabled, per-theme off', { enabled: true, perTheme: false }, 'color'],
    ['both off', { enabled: false, perTheme: false }, 'color'],
  ]) {
    const b = boot(cfg); await b.ready();
    ok(name + ' -> ' + want + ' (exactly one radio checked)', shows(b) === want, shows(b));
  }

  console.log('\ncompany background note');
  {
    const co = { enabled: true };
    let b = boot({ enabled: false, perTheme: false }); await b.ready();
    ok('no company background: the note stays hidden', b.els.myskinStyleCo.hidden === true);
    b = boot({ enabled: false, perTheme: false }, co); await b.ready(); await tick(30);
    ok('a company background paints under Color theme: the note shows', b.els.myskinStyleCo.hidden === false);
    await b.click('myskinStyleWallpaper');
    ok('...and hides once the user is on Real theme wallpaper', b.els.myskinStyleCo.hidden === true);
    await b.click('myskinStyleColor');
    ok('...and returns on Color theme', b.els.myskinStyleCo.hidden === false);
  }

  console.log('\nmarkup');
  {
    const D = rd('docs/pro/dashboard.html').replace(/<!--[\s\S]*?-->/g, '');
    const P = D.slice(D.indexOf('id="myskinPanel"'), D.indexOf('<!-- SIDEBAR CUSTOMIZER -->') > 0 ? D.indexOf('<!-- SIDEBAR CUSTOMIZER -->') : undefined);
    const fs1 = P.slice(P.indexOf('id="myskinStyle"'), P.indexOf('</fieldset>', P.indexOf('id="myskinStyle"')));
    const row = (id) => (fs1.match(new RegExp('<label[^>]*for="' + id + '"[^>]*><span>([^<]*)</span><input([^>]*)></label>')) || []);
    const c = row('myskinStyleColor'), w = row('myskinStyleWallpaper');
    ok('the Color theme label belongs to the Color radio', c[1] === 'Color theme (default)' && /id="myskinStyleColor"/.test(c[2]), JSON.stringify(c));
    ok('the Real theme wallpaper label belongs to the Wallpaper radio', w[1] === 'Real theme wallpaper' && /id="myskinStyleWallpaper"/.test(w[2]), JSON.stringify(w));
    ok('both are real radios in one group (type=radio, name=myskinStyle)',
      [c[2], w[2]].every((a) => /type="radio"/.test(a || '') && /name="myskinStyle"/.test(a || '')));
    ok('values are color / wallpaper', /value="color"/.test(c[2] || '') && /value="wallpaper"/.test(w[2] || ''));
    ok('the group has a legend "Background style" and sits above Use My Skin',
      /<legend[^>]*>Background style<\/legend>/.test(fs1) && P.indexOf('id="myskinStyle"') < P.indexOf('id="myskinEnabled"'));
    ok('the company note exists, hidden by default, inside the group', /id="myskinStyleCo" hidden/.test(fs1));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
