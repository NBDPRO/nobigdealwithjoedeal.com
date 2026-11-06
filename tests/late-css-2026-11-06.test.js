/* tests/late-css-2026-11-06.test.js
 *
 * Boot CSS (2026-11-06): 41 of the dashboard's stylesheets style nothing on the
 * first screen, measured on every role (owner, manager, sales rep, viewer) and
 * the sample account, on all 8 layouts at phone and desktop width
 * (documentation/audit/BOOT-CSS-2026-11-06.md). They ship as
 *   <link rel="stylesheet" media="print" data-late-css href="css/x.css?v=N">
 * (downloaded and parsed, outside every screen restyle) and js/late-css.js
 * removes the media attribute, in place, on the first
 * tap/key, a non-Home goTo(), a query-string deep link, or idle after load.
 *
 *   A. dashboard.html: exactly the measured list is late, each a local
 *      media="print" stylesheet; the sheets that style boot-time state are never late
 *      (theme, shape, sunlight, density/rich cards, text size, offline badge,
 *      install nudge); late-css.js is loaded once, deferred
 *   B. goTo() flips before it shows the view, and not for Home
 *   C. late-css.js run in a vm: each trigger flips every late link exactly once
 *
 * A sheet moving onto or off the list is a conscious edit here: re-measure first
 * (the note says how). Run: node tests/late-css-2026-11-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 600) : '')); }
}

const LATE = [
  'storm-center', 'invoice-pipeline', 'close-board', 'product-library', 'google-calendar', 'rep-os', 'expenses',
  'supplement', 'money-dashboard', 'voice-intelligence', 'follow-up-board', 'estimate-follow-board',
  'data-import-view', 'reputation', 'lead-source-fixer', 'templates-library-view', 'agent-bots',
  'stale-leads-cleanup', 'triage-deck', 'yard-signs-view', 'agent-inbox', 'quick-capture-view',
  'dashboard-widgets-view', 'dashboard-bootstrap-view', 'speed-to-lead', 'ai-texting-persona-view',
  'job-templates-view', 'claim-core-view', 'quick-capture-inbox-view', 'estimate-send', 'admin-manager-view',
  'crm-pipeline-view', 'voicemail-view', 'prod-flags', 'materials-list', 'estimate-preview-view',
  'lead-snooze-view', 'dol-fill', 'ask-joe-actions', 'reports-trends-view', 'd2d-storm',
];
// Unused by the measured runs, but they style state a real account can have at boot:
// a saved theme / shape / sunlight mode / density / text size, starting offline, the install prompt.
const NEVER_LATE = ['theme-art', 'shape-styles', 'field-sunlight', 'pipeline-rich-cards', 'd2d-tracker', 'offline-sync', 'pwa-install-nudge'];
// Used at boot in the measurement: a few that must stay plain stylesheets.
const BOOT_USED = ['dashboard-app', 'ui-primitives', 'today-home', 'widgets-home', 'layout-system', 'my-skin', 'game-card', 'theme-system'];

// ── A. the page ──────────────────────────────────────────────────────────
console.log('A. dashboard.html');
const html = read('docs/pro/dashboard.html');
const links = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
const lateLinks = links.filter((l) => /\bdata-late-css\b/.test(l));
const nameOf = (l) => ((l.match(/\bhref="css\/([\w-]+)\.css\?v=\d+"/) || [])[1] || '');
const lateNames = lateLinks.map(nameOf);
ok('control: the page parses into links (' + links.length + ')', links.length > 60);
ok('exactly the measured ' + LATE.length + ' sheets are late (' + lateNames.length + ')',
  lateNames.length === LATE.length && LATE.every((n) => lateNames.includes(n)),
  'extra: ' + lateNames.filter((n) => !LATE.includes(n)).join(', ') + ' missing: ' + LATE.filter((n) => !lateNames.includes(n)).join(', '));
ok('every late link is a local css stylesheet with media="print" (no onload)',
  lateLinks.every((l) => /^<link rel="stylesheet" media="print" data-late-css href="css\/[\w-]+\.css\?v=\d+">$/.test(l)),
  lateLinks.filter((l) => !/^<link rel="stylesheet" media="print" data-late-css href="css\/[\w-]+\.css\?v=\d+">$/.test(l)).join('\n'));
const plain = (n) => links.some((l) => new RegExp('^<link rel="stylesheet" href="css/' + n + '\\.css\\?').test(l));
for (const n of NEVER_LATE.concat(BOOT_USED)) ok(n + '.css stays a plain stylesheet', plain(n) && !lateNames.includes(n));
const tags = [...html.matchAll(/<script\b[^>]*\bsrc="js\/late-css\.js[^"]*"[^>]*>/g)].map((m) => m[0]);
ok('late-css.js is loaded once, deferred', tags.length === 1 && /\bdefer\b/.test(tags[0]), tags.join(' | '));
ok('customer.html has no late sheets (the measurement covered the dashboard only)', !/data-late-css/.test(read('docs/pro/customer.html')));

// ── B. goTo ──────────────────────────────────────────────────────────────
console.log('B. goTo() flips before the view is shown');
const actions = read('docs/pro/js/dashboard-actions.js');
const goStart = actions.indexOf('function goTo(name, params = {}) {');
const goBody = actions.slice(goStart, actions.indexOf('\nfunction ', goStart + 10));
const flipAt = goBody.indexOf("if (name !== 'home' && window.NBDLateCss) window.NBDLateCss.flip();");
const showAt = goBody.indexOf("if(view) view.classList.add('active');");
ok('control: goTo found and it shows the view', goStart > 0 && showAt > 0);
ok('goTo calls NBDLateCss.flip() for every view but Home', flipAt > 0);
ok('... before it adds .active to the view', flipAt > 0 && flipAt < showAt);
ok('... after the Lite gate (a blocked view flips nothing)', flipAt > goBody.indexOf("PRO_ONLY_VIEWS.includes(name)"));

// ── C. late-css.js in a vm ───────────────────────────────────────────────
console.log('C. late-css.js triggers');
const SRC = read('docs/pro/js/late-css.js');
function rig(opts) {
  const o = opts || {};
  const docListeners = {};
  const winListeners = {};
  const idle = [];
  const el = (href) => { const a = { media: 'print', href }; return { attrs: a, getAttribute: (k) => (k in a ? a[k] : null), removeAttribute: (k) => { delete a[k]; } }; };
  const els = [0, 1, 2].map((i) => el('css/x' + i + '.css'));
  const other = el('css/print-only.css');
  const document = {
    readyState: o.readyState || 'interactive',
    querySelectorAll: (sel) => (sel === 'link[data-late-css]' ? els : []),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn); },
  };
  const window = {
    location: { search: o.search || '' },
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    requestIdleCallback: (fn, opt) => { idle.push({ fn, opt }); },
  };
  vm.runInNewContext(SRC, { window, document, setTimeout: (fn) => idle.push({ fn }) });
  return { window, document, els, other, docListeners, winListeners, idle, fire: (t) => (docListeners[t] || []).slice().forEach((f) => f()) };
}
const allSheets = (r) => r.els.every((e) => !('media' in e.attrs));
{
  const r = rig();
  ok('nothing flips at boot on a plain URL', r.els.every((e) => e.attrs.media === 'print') && !r.window.NBDLateCss.isDone());
  ok('it listens for pointerdown, touchstart and keydown', ['pointerdown', 'touchstart', 'keydown'].every((t) => (r.docListeners[t] || []).length === 1));
  r.fire('pointerdown');
  ok('the first pointerdown removes media="print" from every late link', allSheets(r) && r.window.NBDLateCss.isDone());
  ok('... and removes the input listeners', ['pointerdown', 'touchstart', 'keydown'].every((t) => (r.docListeners[t] || []).length === 0));
  ok('... and leaves a print sheet that is not late alone', r.other.attrs.media === 'print');
}
{
  const r = rig();
  r.fire('keydown');
  ok('a key press flips them', allSheets(r));
}
{
  const r = rig();
  r.window.NBDLateCss.flip();
  ok('NBDLateCss.flip() (the goTo hook) flips them', allSheets(r));
  r.els[0].attrs.media = 'print';
  r.window.NBDLateCss.flip();
  ok('flip() runs once (a second call changes nothing)', r.els[0].attrs.media === 'print');
}
{
  const r = rig({ search: '?agentInbox=1' });
  ok('a query-string deep link flips them at once', allSheets(r));
}
{
  const r = rig();
  ok('it waits for load before going idle', (r.winListeners.load || []).length === 1 && r.idle.length === 0);
  r.winListeners.load[0]();
  ok('after load it asks for idle time with a 2 s cap', r.idle.length === 1 && r.idle[0].opt && r.idle[0].opt.timeout === 2000);
  r.idle[0].fn();
  ok('idle flips them', allSheets(r));
}
{
  const r = rig({ readyState: 'complete' });
  ok('already loaded: it goes straight to idle', r.idle.length === 1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
