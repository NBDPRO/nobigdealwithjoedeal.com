/**
 * tests/settings-ui-2026-11-06.test.js — CRM audit 2026-11-06, Settings UI.
 *
 * ST-F09 dashboard-bootstrap.module.js _testNotif: "Test Notification" said
 *        "your alerts work!" though it tested no channel, and fell back to a
 *        native alert().
 * ST-F22 theme-gx.js clearAccentOverride / dashboard-actions.js clearAccentTheme:
 *        GX "Reset to Default" left the inline --orange/--og and reset a picker
 *        id that does not exist.
 * ST-F23 ui.js switchSettingsTab('appearance'): Professional Mode and Show tool
 *        names opened on the markup default.
 * Zero deps. Run: node tests/settings-ui-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');

console.log('PREVIEW AN ALERT (ST-F09)');
{
  const SRC = read('dashboard-bootstrap.module.js');
  const s = SRC.indexOf('  const _testNotif = function() {');
  const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n  };\n', s) + 5) : '';
  ok('_testNotif found (positive control)', fn.length > 50);
  const toasts = []; let alerts = 0;
  const run = (withToast) => {
    const sb = { alert: () => { alerts++; } };
    if (withToast) sb.showToast = (m, k) => toasts.push([m, k]);
    vm.createContext(sb);
    vm.runInContext(fn + '\n_testNotif();', sb);
  };
  run(true);
  ok('it no longer claims "your alerts work"', toasts.length === 1 && !/alerts work/i.test(toasts[0][0]), toasts[0] && toasts[0][0]);
  ok('it says email and text are not sent from here', toasts.length === 1 && /not sent/i.test(toasts[0][0]));
  run(false);
  ok('no native alert() when the toast is missing', alerts === 0);
  const html = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  ok('the button is labelled for what it does', /data-fn="_testNotif">🔔 Preview an alert</.test(html) && !/Test Notification</.test(html));
}

console.log('GX RESET TO DEFAULT (ST-F22)');
{
  const GX = read('theme-gx.js');
  const s = GX.indexOf('    clearAccentOverride: function() {');
  const body = s >= 0 ? GX.slice(s + '    clearAccentOverride: '.length, GX.indexOf('\n    },\n', s) + 6) : '';
  ok('clearAccentOverride found (positive control)', body.length > 50);
  const props = { '--orange': '#123456', '--og': '#1234561f' };
  const state = { accentOverride: '#123456' };
  const sb = { state, saveState() {}, update() {},
    document: { documentElement: { style: { removeProperty: (k) => { delete props[k]; }, setProperty: (k, v) => { props[k] = v; } } } },
    window: {} };
  vm.createContext(sb);
  vm.runInContext('(' + body.replace(/,\s*$/, '') + ')();', sb);
  ok('the override is cleared (positive control)', state.accentOverride === null);
  ok('the inline --orange and --og are removed', !('--orange' in props) && !('--og' in props), JSON.stringify(props));

  const A = read('dashboard-actions.js');
  const a0 = A.indexOf('function clearAccentTheme() {');
  const fn = a0 >= 0 ? A.slice(a0, A.indexOf('\n};\n', a0) + 3) : '';
  const picker = { value: '#123456' };
  const sb2 = { window: {}, document: { getElementById: (id) => (id === 'gxAccentPicker' ? picker : null) } };
  vm.createContext(sb2);
  vm.runInContext(fn + '\nclearAccentTheme();', sb2);
  ok('the real accent picker (#gxAccentPicker) is reset', picker.value === '#BD5728', picker.value);
}

console.log('APPEARANCE CHECKBOXES (ST-F23)');
{
  const UI = read('ui.js');
  const s = UI.indexOf("  if (tab === 'appearance') {");
  const branch = s >= 0 ? UI.slice(s, s + 4000) : '';
  ok('the appearance branch is found (positive control)', /nbdSyncShapeStyleBtns/.test(branch));
  ok('Professional Mode is read from <body> when the tab opens',
    /getElementById\('professionalModeToggle'\)[\s\S]{0,120}\.checked = document\.body\.classList\.contains\('professional-mode'\)/.test(branch));
  ok('Show tool names is read from <body> when the tab opens',
    /getElementById\('sidebarLabelsToggle'\)[\s\S]{0,120}\.checked = !document\.body\.classList\.contains\('sidebar-collapsed'\)/.test(branch));
}

console.log('DAILY FOCUS CATEGORY (ST-F12)');
{
  const A = read('dashboard-actions.js');
  const s = A.indexOf('function dsLoadConfig() {');
  const fn = s >= 0 ? A.slice(s, A.indexOf('\n}\n', s) + 3) : '';
  ok('dsLoadConfig found (positive control)', fn.length > 200);
  function mkSelect(values) {
    const sel = { _v: '', options: values.map((v) => ({ value: v })),
      appendChild(o) { this.options.push(o); },
      get value() { return this._v; },
      set value(v) { this._v = this.options.some((o) => o.value === v) ? v : ''; } };
    return sel;
  }
  const run = (category) => {
    const sel = mkSelect(['Roofing Sales', 'Storm Restoration', 'Other']);
    const sb = {
      document: { getElementById: (id) => (id === 'ds-cat' ? sel : null), createElement: () => ({ value: '', textContent: '' }) },
      dsGetConfig: () => ({ northStar: { category } }),
      Array,
    };
    vm.createContext(sb);
    try { vm.runInContext(fn + '\ndsLoadConfig();', sb); } catch (e) { /* later fields need more DOM; the category is set first */ }
    return sel;
  };
  ok('a category from this list is selected (positive control)', run('Storm Restoration').value === 'Storm Restoration');
  const other = run('Grow my business');
  ok('a category set on the Daily Success page is kept, not blank', other.value === 'Grow my business', JSON.stringify(other.value));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
