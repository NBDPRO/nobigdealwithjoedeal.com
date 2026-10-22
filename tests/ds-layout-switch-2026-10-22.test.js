/**
 * tests/ds-layout-switch-2026-10-22.test.js
 *
 * The layout switch (data-ui) that every Daily Success layout plugs into: the pure rules (layout-logic.js), the applier and picker
 * (layout-ui.js, executed in a vm with a DOM stub) and the page wiring (index.html). Layouts that are not ready are listed but can
 * never become active, and bad or blocked storage falls back to Classic.
 *
 * Run: node tests/ds-layout-switch-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const L = require(path.join(DS, 'js', 'layout-logic.js'));
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');
const UI_SRC = read('js/layout-ui.js');
const LOGIC_SRC = read('js/layout-logic.js');
const INDEX = read('index.html');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('\n1. the rules');
{
  ok('the default is classic and classic is ready', L.DEFAULT === 'classic' && L.byId('classic').ready === true);
  ok('the lineup is the eight in the brief, ids unique', L.LAYOUTS.map((l) => l.id).join() === 'classic,logbook,rings,cockpit,quest,arcade,onething,journal' && new Set(L.LAYOUTS.map((l) => l.id)).size === L.LAYOUTS.length);
  ok('every layout has a label and a blurb', L.LAYOUTS.every((l) => l.label && l.blurb));
  ok('a ready layout normalises to itself', L.normLayout('classic') === 'classic');
  ok('a layout that is not ready can never be active (falls back)', L.LAYOUTS.filter((l) => !l.ready).every((l) => L.normLayout(l.id) === 'classic'));
  ok('unknown, empty, null, undefined, numbers and objects fall back', ['nope', '', null, undefined, 7, {}, ['classic']].every((v) => L.normLayout(v) === 'classic'));
  ok('case matters: Classic is not an id', L.normLayout('Classic') === 'classic' && L.byId('Classic') === null);
  const fake = [{ id: 'x', ready: true }];
  ok('control: normLayout honours ready (a ready non-default id would pass through)', (() => {
    const orig = L.LAYOUTS.slice(); L.LAYOUTS.push(fake[0]);
    const r = L.normLayout('x'); L.LAYOUTS.length = 0; orig.forEach((o) => L.LAYOUTS.push(o)); return r === 'x';
  })());
}

console.log('\n2. the applier and picker (real layout-ui.js in a vm)');
function boot(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.store || {});
  const attrs = {};
  const els = {};
  ['npm-layouts', 'wg-layouts'].forEach((id) => { els[id] = { innerHTML: '' }; });
  let clickHandler = null;
  const sandbox = {
    window: {},
    localStorage: o.blocked
      ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: {
      documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
      getElementById: (id) => els[id] || null,
      addEventListener: (t, fn) => { if (t === 'click') clickHandler = fn; },
    },
  };
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(LOGIC_SRC, sandbox);
  if (o.ready) o.ready.forEach((id) => { sandbox.window.NBDLayout.byId(id).ready = true; });
  vm.runInContext(UI_SRC, sandbox);
  const click = (id) => clickHandler({ target: { closest: (sel) => (sel === '[data-ui-pick]' && id ? { getAttribute: () => id } : null) } });
  return { store, attrs, els, click, api: sandbox.window.NBDLayout };
}
{
  const a = boot();
  ok('first run: data-ui is classic and nothing is written to storage yet', a.attrs['data-ui'] === 'classic' && !('nbd_ds_layout' in a.store));
  ok('the picker is rendered in BOTH places (appearance modal and first-run welcome)', /ui-picks/.test(a.els['npm-layouts'].innerHTML) && /ui-picks/.test(a.els['wg-layouts'].innerHTML));
  const html = a.els['npm-layouts'].innerHTML;
  ok('all eight layouts are listed; classic is checked', (html.match(/class="ui-pick[ "]/g) || []).length === 8 && /ui-pick on"[^>]*aria-checked="true"[^>]*data-ui-pick="classic"/.test(html), html.slice(0, 300));
  ok('layouts that are not ready are disabled, say "coming", and carry no pick handle', (html.match(/ui-pick soon/g) || []).length === 7 && (html.match(/data-ui-pick=/g) || []).length === 1 && (html.match(/disabled aria-disabled="true"/g) || []).length === 7);

  const b = boot({ store: { nbd_ds_layout: 'logbook' } });
  ok('a stored layout that is not ready is ignored (classic applied)', b.attrs['data-ui'] === 'classic');
  const c = boot({ store: { nbd_ds_layout: '<img onerror=x>' } });
  ok('hand-edited storage cannot reach the page: classic applied, and the picker html has no raw value', c.attrs['data-ui'] === 'classic' && !/onerror/.test(c.els['npm-layouts'].innerHTML));
  const d = boot({ blocked: true });
  ok('blocked storage (private window): still applies classic and renders; set() does not throw', d.attrs['data-ui'] === 'classic' && /ui-picks/.test(d.els['npm-layouts'].innerHTML) && (() => { try { d.api.set('classic'); return true; } catch (_) { return false; } })());

  const e = boot({ ready: ['logbook'] });
  e.click('logbook');
  ok('picking a ready layout applies data-ui, persists it and re-renders with it checked', e.attrs['data-ui'] === 'logbook' && e.store.nbd_ds_layout === 'logbook' && /ui-pick on"[^>]*aria-checked="true"[^>]*data-ui-pick="logbook"/.test(e.els['wg-layouts'].innerHTML));
  const f = boot({ ready: ['logbook'], store: { nbd_ds_layout: 'logbook' } });
  ok('it comes back after a reload (stored + ready)', f.attrs['data-ui'] === 'logbook');
  e.click('rings');
  ok('a click on a layout that is not ready changes nothing', e.attrs['data-ui'] === 'logbook' && e.store.nbd_ds_layout === 'logbook');
  e.click('');
  e.click(null);
  ok('a click that is not on a picker button is ignored', e.attrs['data-ui'] === 'logbook');
  e.click('classic');
  ok('switching back to classic works', e.attrs['data-ui'] === 'classic' && e.store.nbd_ds_layout === 'classic');
}

console.log('\n3. the page wiring (index.html)');
{
  const tagFor = (re) => (INDEX.match(re) || [''])[0];
  const logicTag = tagFor(/<script[^>]*\/js\/layout-logic\.js[^>]*>/);
  const uiTag = tagFor(/<script[^>]*layout-ui\.js[^>]*>/);
  ok('both scripts are loaded, external, with defer', /defer/.test(logicTag) && /defer/.test(uiTag) && logicTag && uiTag, logicTag + ' | ' + uiTag);
  ok('logic loads before ui', INDEX.indexOf('/js/layout-logic.js') > -1 && INDEX.indexOf('/js/layout-logic.js') < INDEX.indexOf('/js/layout-ui.js'));
  ok('the stylesheet is linked', /<link[^>]*css\/layouts\.css/.test(INDEX));
  ok('the appearance modal has a Layouts tab whose panel id matches the tab handler (npm-panel-layouts)', /data-arg="layouts">Layouts</.test(INDEX) && /id="npm-panel-layouts"/.test(INDEX) && /id="npm-layouts"/.test(INDEX));
  ok('the first-run welcome has the picker mount before its button', INDEX.indexOf('id="wg-layouts"') > -1 && INDEX.indexOf('id="wg-layouts"') < INDEX.indexOf('data-action="close-welcome"'));
  ok('control: every picker mount id the UI renders into exists exactly once in the page', ['npm-layouts', 'wg-layouts'].every((id) => INDEX.split('id="' + id + '"').length === 2 && strip(UI_SRC).includes("'" + id + "'")));
  ok('no inline handler or inline script in the new files', !/\son[a-z]+\s*=/.test(strip(UI_SRC).replace(/'<button[^]*?>'/g, '')) && !/<script(?![^>]*src)/.test(INDEX.slice(INDEX.indexOf('/js/layout-logic.js') - 120, INDEX.indexOf('/js/layout-ui.js') + 120)));
  ok('the picker html escapes label and blurb', /esc\(l\.label\)/.test(strip(UI_SRC)) && /esc\(l\.blurb\)/.test(strip(UI_SRC)));
  ok('the layout is a per-device look: no sync key and no account purge involved', !/nbd_ds_layout/.test(read('ds-firebase-sync.js')) && !/nbd_ds_layout/.test(read('js/ds-sync-logic.js')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
