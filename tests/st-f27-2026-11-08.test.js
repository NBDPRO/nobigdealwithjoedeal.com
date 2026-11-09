/**
 * tests/st-f27-2026-11-08.test.js — Settings > Appearance draws the real theme
 * picker even when it opens before the theme engine lands (CRM audit ST-F27,
 * 2026-11-08).
 *
 * The theme engine ships in the lazy 'theme' bundle. goTo('settings') starts
 * that bundle without waiting and switches tab 50 ms later, so a fast or
 * deep-linked open (?settings=appearance, openSettingsTab, NBD OS settingsTab)
 * ran the appearance branch with no window.ThemeEngine: it drew the legacy
 * plain-name grid with only an "All" filter, then set the grid's
 * dataset.loaded = '1' anyway, so the category bar and the themed cards never
 * drew until a page reload. Now the grid counts as loaded only when the
 * engine drew it; otherwise the branch asks for the bundle and, when it
 * lands, redraws if the Appearance tab is still the one open.
 *
 * Runs the real switchSettingsTab lifted from ui.js in a vm with a fake DOM
 * and a ScriptLoader stub whose bundle lands when the test says so.
 * Zero deps. Run: node tests/st-f27-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const UI = read('docs/pro/js/ui.js');
const START = 'function switchSettingsTab(tab) {';
const END = '\n}\nwindow.switchSettingsTab = switchSettingsTab;';
const s = UI.indexOf(START);
const e = s >= 0 ? UI.indexOf(END, s) : -1;
const FN = s >= 0 && e > s ? UI.slice(s, e + 2) : '';
ok('control: switchSettingsTab is found in ui.js', /if \(tab === 'appearance'\)/.test(FN) && /te-theme-grid/.test(FN), FN.length);

const ENGINE = {
  getCurrent: () => 'nbd-original',
  getAll: () => ({ 'nbd-original': { name: 'NBD Original', category: 'brand', colors: {} }, midnight: { name: 'Midnight', category: 'dark', colors: {} } }),
  getCategories: () => [{ key: 'brand', icon: '*', label: 'Brand' }, { key: 'dark', icon: '*', label: 'Dark' }],
};
function makeEl() {
  return { style: {}, dataset: {}, innerHTML: '', checked: false, classList: { add() {}, remove() {}, contains() { return false; } } };
}
// A settings page with two tabs. `loader`: 'none' (no ScriptLoader), or a stub
// whose loadBundle() resolves when land() is called; land(true) delivers the engine.
function page(opts) {
  const els = {};
  ['te-theme-grid', 'te-cat-bar', 'stab-panel-appearance', 'stab-appearance', 'stab-panel-profile', 'stab-profile'].forEach((id) => { els[id] = makeEl(); });
  const panels = [els['stab-panel-appearance'], els['stab-panel-profile']];
  const btns = [els['stab-appearance'], els['stab-profile']];
  const bundles = [];
  let open = null;
  const ctx = {
    console, setTimeout: () => 0, Promise,
    THEME_KEYS: ['nbd-original', 'midnight'],
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: (sel) => (sel === '.stab-panel' ? panels : sel === '.stab-btn' ? btns : []),
      documentElement: { getAttribute: () => 'nbd-original' },
      body: { classList: { contains: () => false } },
    },
  };
  ctx.window = ctx;
  if (opts.engine) ctx.ThemeEngine = ENGINE;
  if (opts.loader !== 'none') {
    ctx.ScriptLoader = {
      loadBundle(name) {
        bundles.push(name);
        return new Promise((r) => { open = r; });
      },
    };
  }
  vm.createContext(ctx);
  vm.runInContext(FN + '\nglobalThis.__sst = switchSettingsTab;', ctx);
  return {
    els, bundles, ctx, open: (tab) => ctx.__sst(tab),
    land(withEngine) { if (withEngine) ctx.ThemeEngine = ENGINE; if (open) open(); return new Promise((r) => setImmediate(r)); },
  };
}
const grid = (p) => p.els['te-theme-grid'];
const catBtns = (p) => (p.els['te-cat-bar'].innerHTML.match(/class="te-filter-btn"/g) || []).length;

(async () => {
  console.log('\nST-F27: opened before the theme engine lands, then it lands');
  {
    const p = page({});
    p.open('appearance');
    ok('the legacy grid draws meanwhile (no blank tab)', /data-ui-action="applyTheme"/.test(grid(p).innerHTML), grid(p).innerHTML.slice(0, 80));
    ok('…but the grid is NOT marked loaded while the engine is missing', !grid(p).dataset.loaded, grid(p).dataset.loaded);
    ok('the theme bundle is requested', p.bundles.length === 1 && p.bundles[0] === 'theme', JSON.stringify(p.bundles));
    ok('meanwhile the filter bar holds only "All"', catBtns(p) === 1, catBtns(p));
    await p.land(true);
    ok('when it lands the grid redraws with the engine\'s cards', /data-ui-action="previewTheme"/.test(grid(p).innerHTML) && !/data-ui-action="applyTheme"/.test(grid(p).innerHTML), grid(p).innerHTML.slice(0, 80));
    ok('…the category bar now holds All plus each category', catBtns(p) === 3, catBtns(p));
    ok('…and the grid is marked loaded', grid(p).dataset.loaded === '1', grid(p).dataset.loaded);
    ok('…with no second bundle request', p.bundles.length === 1, JSON.stringify(p.bundles));
  }

  console.log('\nST-F27: the rep moved to another tab before the bundle landed');
  {
    const p = page({});
    p.open('appearance');
    p.open('profile');
    await p.land(true);
    ok('no redraw yanks them back: the Profile panel stays shown', p.els['stab-panel-profile'].style.display === 'block' && p.els['stab-panel-appearance'].style.display === 'none');
    ok('the grid stays unmarked, so the next Appearance open draws the real picker', !grid(p).dataset.loaded);
    p.open('appearance');
    ok('…and it does', grid(p).dataset.loaded === '1' && catBtns(p) === 3, catBtns(p));
  }

  console.log('\nST-F27: the bundle failed to load (offline)');
  {
    const p = page({});
    p.open('appearance');
    await p.land(false);
    ok('no redraw loop: one bundle request, legacy grid kept, still unmarked', p.bundles.length === 1 && /applyTheme/.test(grid(p).innerHTML) && !grid(p).dataset.loaded, JSON.stringify(p.bundles));
  }

  console.log('\nST-F27: controls');
  {
    const p = page({ engine: true });
    p.open('appearance');
    ok('engine already loaded: real picker, marked loaded, no bundle request', grid(p).dataset.loaded === '1' && catBtns(p) === 3 && p.bundles.length === 0, JSON.stringify(p.bundles));
    const q = page({ loader: 'none' });
    let threw = null;
    try { q.open('appearance'); } catch (err) { threw = err; }
    ok('no ScriptLoader and no engine: no throw, legacy grid drawn', !threw && /applyTheme/.test(grid(q).innerHTML), threw && threw.message);
    ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"st-f27-2026-11-08.test.js"') >= 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
