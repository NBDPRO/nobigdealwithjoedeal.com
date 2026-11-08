/**
 * tests/st-f14-f31-2026-11-08.test.js — Settings stops calling three functions
 * that exist nowhere (CRM audit ST-F14 + ST-F31, 2026-11-08).
 *
 * ST-F14 switchSettingsTab('daily') called dsInitEditor() and dsLoadThemeGrid()
 *        behind typeof guards. Neither is defined anywhere, so both were
 *        no-ops; the Daily Program tab really loads through the goTo wrapper
 *        in dashboard-actions.js (setTimeout(dsLoadConfig, 80)).
 * ST-F31 switchSettingsTab('appearance') called window.ThemeBuilder.renderBuilder
 *        ('te-builder-panel'). ThemeBuilder is defined nowhere and no bundle
 *        ships one; #te-builder-panel is static markup.
 *
 * Runs the real switchSettingsTab lifted from ui.js in a vm whose global holds
 * spies under those three names, so a call is seen, not grepped.
 * Zero deps. Run: node tests/st-f14-f31-2026-11-08.test.js
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
const ACTIONS = read('docs/pro/js/dashboard-actions.js');
const HTML = read('docs/pro/dashboard.html');

const START = 'function switchSettingsTab(tab) {';
const END = '\n}\nwindow.switchSettingsTab = switchSettingsTab;';
const s = UI.indexOf(START);
const e = s >= 0 ? UI.indexOf(END, s) : -1;
const FN = s >= 0 && e > s ? UI.slice(s, e + 2) : '';
ok('control: switchSettingsTab is found in ui.js', /if \(tab === 'appearance'\)/.test(FN) && /if \(tab === 'estimates'\)/.test(FN), FN.length);

function makeEl() {
  return { style: {}, dataset: {}, innerHTML: '', checked: false, classList: { add() {}, remove() {}, contains() { return false; } } };
}
function run(tab) {
  const els = {};
  ['te-theme-grid', 'te-cat-bar', 'stab-panel-' + tab, 'stab-' + tab].forEach((id) => { els[id] = makeEl(); });
  const calls = { dsInitEditor: 0, dsLoadThemeGrid: 0, renderBuilder: 0, renderAchievementPanel: [] };
  const ctx = {
    console, setTimeout: () => 0,
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => [],
      documentElement: { getAttribute: () => 'nbd-original' },
      body: { classList: { contains: () => false } },
    },
    dsInitEditor() { calls.dsInitEditor++; },
    dsLoadThemeGrid() { calls.dsLoadThemeGrid++; },
    ThemeBuilder: { renderBuilder() { calls.renderBuilder++; } },
    ThemeAchievements: { renderAchievementPanel(id) { calls.renderAchievementPanel.push(id); } },
    ThemeEngine: { getCurrent: () => 'nbd-original', getAll: () => ({}), getCategories: () => [] },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(FN + '\nglobalThis.__sst = switchSettingsTab;', ctx);
  ctx.__sst(tab);
  return { calls, els };
}

console.log('\nST-F14: the Daily Program tab calls nothing that does not exist');
{
  const r = run('daily');
  ok('opening Daily does not call dsInitEditor', r.calls.dsInitEditor === 0, r.calls.dsInitEditor);
  ok('opening Daily does not call dsLoadThemeGrid', r.calls.dsLoadThemeGrid === 0, r.calls.dsLoadThemeGrid);
  ok('control: the Daily panel is still shown', r.els['stab-panel-daily'].style.display === 'block');
  const defs = /function\s+(dsInitEditor|dsLoadThemeGrid)\b|(dsInitEditor|dsLoadThemeGrid)\s*=(?!=)/;
  const jsDir = path.join(ROOT, 'docs', 'pro', 'js');
  const definers = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js') && defs.test(fs.readFileSync(path.join(jsDir, f), 'utf8')));
  ok('neither name is defined anywhere in docs/pro/js (nothing real was dropped)', definers.length === 0, definers.join(','));
  ok('the real Daily Program load is the goTo(\'settings\') wrapper calling dsLoadConfig', /if \(view === 'settings'\) \{\n\s*setTimeout\(dsLoadConfig, 80\);/.test(ACTIONS));
}

console.log('\nST-F31: the Appearance tab calls no ThemeBuilder');
{
  const r = run('appearance');
  ok('opening Appearance does not call ThemeBuilder.renderBuilder', r.calls.renderBuilder === 0, r.calls.renderBuilder);
  ok('control: the achievements panel is still rendered', r.calls.renderAchievementPanel.length === 1 && r.calls.renderAchievementPanel[0] === 'te-achievements-panel', JSON.stringify(r.calls.renderAchievementPanel));
  ok('no file in docs/pro/js defines ThemeBuilder', !fs.readdirSync(path.join(ROOT, 'docs', 'pro', 'js')).some((f) => f.endsWith('.js') && /ThemeBuilder\s*=(?!=)/.test(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', f), 'utf8'))));
  ok('#te-builder-panel is static markup in dashboard.html (needs no renderer)', /<div id="te-builder-panel">\s*\n\s*<\w/.test(HTML));
  ok('ui.js no longer names ThemeBuilder, dsInitEditor or dsLoadThemeGrid', !/ThemeBuilder|dsInitEditor|dsLoadThemeGrid/.test(UI));
}

console.log('\nWIRING');
ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"st-f14-f31-2026-11-08.test.js"') >= 0);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
