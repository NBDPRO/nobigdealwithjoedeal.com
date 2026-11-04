/**
 * tests/ds-dash-week-strip-2026-11-04.test.js
 *
 * The "This week at a glance" strip at the top of the Daily Success dashboard (js/weekstrip-ui.js): it wraps renderDash, puts the strip
 * app.js already draws on the day page above the dashboard, once, and never breaks the dashboard if the strip fails. Runs the real
 * script against a minimal fake page, and pins the wiring (script order, version, stylesheet) and that it uses no inline style/handler.
 *
 * Run: node tests/ds-dash-week-strip-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const SRC = fs.readFileSync(path.join(DS, 'js', 'weekstrip-ui.js'), 'utf8');
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// A tiny page: #main with insertBefore/firstChild, getElementById that finds what was inserted, and the globals app.js provides.
function page(opts) {
  const o = opts || {};
  const inserted = [];
  const main = { firstChild: { tag: 'first' }, insertBefore(node, ref) { node.ref = ref; inserted.unshift(node); if (node.id) byId[node.id] = node; } };
  const byId = { main };
  if (o.fitPb) byId['fit-pb'] = {};
  const document = {
    readyState: 'complete',
    getElementById: (id) => byId[id] || null,
    createElement: () => ({ className: '', id: '', innerHTML: '' }),
    addEventListener() {},
  };
  const calls = { dash: 0 };
  const window = { document };
  window.renderDash = function renderDash() { calls.dash++; return 'dash-result'; };
  window.renderDash.extra = 'kept';
  if (o.glance !== null) window.buildWeekGlance = o.glance || (() => '<div>STRIP</div>');
  vm.runInNewContext(SRC, { window, document, console }, { filename: 'weekstrip-ui.js' });
  return { window, inserted, byId, calls, main };
}

console.log('\n1. what it does to the dashboard');
{
  const p = page();
  ok('boot draws the dashboard once and inserts one strip card at the top', p.calls.dash === 1 && p.inserted.length === 1 && p.inserted[0].ref === p.main.firstChild, JSON.stringify(p.inserted.map((n) => n.id)));
  const n = p.inserted[0];
  ok('the card is wsDash with the title and the strip inside a panel', n.id === 'wsDash' && n.className === 'ws-dash' && n.innerHTML === '<div class="ws-panel"><div class="ws-h">This week at a glance</div><div>STRIP</div></div>', n.innerHTML);
  ok('renderDash still returns what it returned and keeps its own properties', p.window.renderDash() === 'dash-result' && p.window.renderDash.extra === 'kept');
  ok('a second render does not add a second strip', (p.window.renderDash(), p.inserted.length === 1));
  // Run the script again on the same window (a second include): it must not wrap renderDash a second time.
  const again = page();
  const wrappedOnce = again.window.renderDash;
  again.window.NBDWeekStripUI = undefined;
  vm.runInNewContext(SRC, { window: again.window, document: again.window.document, console }, { filename: 'weekstrip-ui.js' });
  ok('a second include does not wrap renderDash twice', again.window.renderDash === wrappedOnce && again.inserted.length === 1);
  ok('exposes stripHtml', typeof p.window.NBDWeekStripUI.stripHtml === 'function' && p.window.NBDWeekStripUI.stripHtml() === '<div>STRIP</div>');
}

console.log('\n2. it never breaks the dashboard');
{
  const noFn = page({ glance: null });
  ok('no buildWeekGlance: no strip, dashboard still renders', noFn.inserted.length === 0 && noFn.calls.dash === 1);
  ok('...and stripHtml() itself says nothing rather than throwing', noFn.window.NBDWeekStripUI.stripHtml() === '');
  const throwing = page({ glance: () => { throw new Error('boom'); } });
  let threw = false, again = null;
  try { again = throwing.window.renderDash(); } catch (_) { threw = true; }   // a later render, outside boot's own guard
  ok('buildWeekGlance throwing: no strip, no throw, dashboard still renders', throwing.inserted.length === 0 && throwing.calls.dash === 2 && !threw && again === 'dash-result');
  const empty = page({ glance: () => '' });
  ok('an empty strip adds no empty card', empty.inserted.length === 0);
  const dayPage = page({ fitPb: true });
  ok('on a day page (fit-pb present) boot does not redraw the dashboard', dayPage.calls.dash === 0 && dayPage.inserted.length === 0);
}

console.log('\n3. wired in, CSP-safe');
{
  const html = read('index.html'), css = read('css/week-strip.css');
  const at = (s) => html.indexOf(s);
  ok('no inline style or handler in the script', !/style=|\son[a-z]+=/i.test(SRC));
  ok('loaded once, deferred, versioned, after app.js and the Progress card script', (html.match(/<script src="\/pro\/daily-success\/js\/weekstrip-ui\.js\?v=\d+" defer><\/script>/g) || []).length === 1 && at('weekstrip-ui.js') > at('progress-charts-ui.js') && at('weekstrip-ui.js') > at('js/app.js'));
  ok('the stylesheet it uses was version-bumped (phones refetch)', /css\/week-strip\.css\?v=([2-9]|\d\d)/.test(html));
  ok('the panel has the dark day-page background and an 11px+ title', /\.ws-panel \{[^}]*#0a1018/.test(css) && !/\.ws-h \{[^}]*font-size:\s*(\d|10)px/.test(css));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
