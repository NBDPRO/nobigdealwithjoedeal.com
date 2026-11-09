/**
 * tests/st-f48-2026-11-08.test.js — the Billing tab's plan cards never leave
 * one card alone on a second line (CRM audit 2026-11-06, ST-F48).
 *
 * THE BUG: #billingPlanCards (dashboard.html) was grid-template-columns:
 * repeat(4,1fr), but renderBillingTab (dashboard-billing-tab.js) always paints
 * FIVE cards (free / starter / team / growth / enterprise; the foundation and
 * professional alias rows only swap in for their canonical twin). So the
 * fifth card sat alone on a second row at every width, and on a phone the four
 * columns could not shrink below the cards' content and ran out of the panel.
 *
 * THE FIX: markup only (the held billing tab script is untouched). The grid
 * puts all five on one row when five fit at 124px each (the widest card, the
 * Enterprise one, measured 121px min-content in headless Chrome), otherwise
 * three columns (3 + 2), and two on a phone. Never 4 + 1.
 *
 * Runs the REAL renderBillingTab in a vm with the real PLANS to count the
 * cards, then evaluates the real grid template from dashboard.html across the
 * settings panel widths (derived from dashboard-app.css). Zero deps.
 * Run: node tests/st-f48-2026-11-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const HTML = read('docs/pro/dashboard.html');
const TAB = read('docs/pro/js/dashboard-billing-tab.js');
const GATE = read('docs/pro/js/billing-gate.js');
const CSS = read('docs/pro/css/dashboard-app.css');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}

// ── 1. How many cards the real renderer paints ─────────────────────────────
console.log('\nST-F48 — the renderer always paints five plan cards');
const s = TAB.indexOf('      function renderBillingTab() {');
const FN = s >= 0 ? TAB.slice(s, TAB.indexOf('\n      }\n', s) + 8) : '';
const plansSrc = (GATE.match(/const PLANS = (\{[\s\S]*?\n  \});/) || [])[1] || '';
const PLANS = plansSrc ? vm.runInNewContext('(' + plansSrc + ')') : {};
ok('control: renderBillingTab and PLANS are found', FN.length > 2000 && Object.keys(PLANS).length >= 5, FN.length + ' / ' + Object.keys(PLANS).join());
function cardCount(plan, status) {
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || { textContent: '', innerHTML: '', style: {} }) };
  const info = { loaded: true, plan, status, isActive: status === 'active', isTrialing: false, isPastDue: false, isCancelled: false, label: (PLANS[plan] || {}).label, usage: {}, limits: PLANS[plan] || {} };
  const sb = { window: { NBDBilling: { PLANS, getPlan: () => info, usagePct: () => 0 }, _userClaims: {} }, document };
  vm.createContext(sb);
  vm.runInContext(FN + '\nrenderBillingTab();', sb);
  return (els.billingPlanCards.innerHTML.match(/border-radius:8px;padding:14px;text-align:center;/g) || []).length;
}
const counts = Object.keys(PLANS).map((p) => [p, cardCount(p, p === 'free' ? 'none' : 'active')]);
ok('every plan (canonical or legacy alias) paints exactly 5 cards', counts.length >= 5 && counts.every((c) => c[1] === 5), JSON.stringify(counts));
const N = 5;

// ── 2. The grid template in the real markup ────────────────────────────────
console.log('\nST-F48 — the grid never leaves one card alone');
const tag = (HTML.match(/<div style="([^"]*)" id="billingPlanCards">/) || [])[1] || '';
const tpl = ((tag.match(/grid-template-columns:([^;]+)/) || [])[1] || '').trim();
const gap = Number(((tag.match(/(?:^|;)gap:(\d+)px/) || [])[1]));
ok('control: #billingPlanCards and its grid template / gap are found', !!tpl && gap > 0, tag);

// Column count for a container W px wide, for the two template shapes in play:
// repeat(<n>,1fr) and repeat(auto-fit|auto-fill, minmax(<css-math min>, 1fr)).
// auto-fit: the most tracks of the minimum size that fit; empty ones collapse.
function evalCssLen(expr, W) {
  const js = expr.replace(/\bmax\(/g, 'Math.max(').replace(/\bmin\(/g, 'Math.min(')
    .replace(/(\d+(?:\.\d+)?)%/g, (_, p) => '(' + (W * p / 100) + ')').replace(/(\d+(?:\.\d+)?)px/g, '$1');
  if (/[^\d\s.+\-*/(),]/.test(js.replace(/Math\.m(?:ax|in)\(/g, '('))) throw new Error('unexpected css: ' + expr);
  return vm.runInNewContext(js, { Math });
}
function layout(W) {
  let cols, track;
  const fixed = tpl.match(/^repeat\(\s*(\d+)\s*,\s*1fr\s*\)$/);
  const auto = tpl.match(/^repeat\(\s*auto-fi(?:t|ll)\s*,\s*minmax\(([\s\S]+),\s*1fr\s*\)\s*\)$/);
  if (fixed) { cols = +fixed[1]; track = (W - (cols - 1) * gap) / cols; }
  else if (auto) {
    const min = evalCssLen(auto[1], W);
    cols = Math.max(1, Math.floor((W + gap) / (min + gap)));
    cols = Math.min(cols, N);                       // auto-fit collapses the empty tracks
    track = Math.max(min, (W - (cols - 1) * gap) / cols);
  } else return null;
  const rows = Math.ceil(N / cols);
  const last = N - (rows - 1) * Math.min(cols, N);
  return { cols, track, rows, last, width: cols * track + (cols - 1) * gap };
}
ok('control: the template is one the model can read', !!layout(600), tpl);

// The settings panel-body widths, from the real CSS (default density):
// view-scroll padding, the settings column max-widths, the desktop tab rail,
// the panel border and the panel-body padding.
const vsPad = Number((CSS.match(/\.view-scroll\{flex:1;overflow-y:auto;padding:\d+px (\d+)px;/) || [])[1]);
const phonePad = Number((CSS.match(/\.view-scroll\{padding:\d+px (\d+)px \d+px;\}/) || [])[1]);
const narrow = Number((CSS.match(/\.settings-scroll\{max-width:(\d+)px;/) || [])[1]);
const rail = CSS.match(/\.settings-scroll\{max-width:(\d+)px;display:grid;grid-template-columns:(\d+)px minmax\(0,1fr\);column-gap:(\d+)px;/);
const border = Number((CSS.match(/\.panel\{background:var\(--s\);border:(\d+)px solid/) || [])[1]);
const pbPad = Number((CSS.match(/\.panel-body\{padding:\d+px (\d+)px;\}/) || [])[1]);
ok('control: the settings layout widths are read from dashboard-app.css', [vsPad, phonePad, narrow, border, pbPad].every((n) => n > 0) && !!rail, [vsPad, phonePad, narrow, border, pbPad, !!rail].join());
const inner = (outer) => outer - 2 * border - 2 * pbPad;
const W_NARROW = inner(narrow - 2 * vsPad);                                   // 901-1099px screens, tablets
const W_RAIL = rail ? inner(+rail[1] - 2 * vsPad - +rail[2] - +rail[3]) : 0;   // ≥1200px desktops (tab rail)
const W_PHONE = 360 - 2 * phonePad - 2 * border - 2 * pbPad;                  // a 360px phone
const MIN_CARD = 121;   // the Enterprise card's min-content width, headless Chrome (2026-11-08)

const desk = layout(W_RAIL);
ok('a desktop with the tab rail (' + W_RAIL + 'px) shows all five on one row', !!desk && desk.rows === 1, JSON.stringify(desk));
const mid = layout(W_NARROW);
ok('the narrow settings column (' + W_NARROW + 'px) has no card alone on a row', !!mid && (mid.rows === 1 || mid.last > 1), JSON.stringify(mid));
const lone = [];
for (let W = 388; W <= 900; W++) { const l = layout(W); if (!l || (l.rows > 1 && l.last === 1)) lone.push(W); }
ok('no width from 388px to 900px leaves one card alone (5, or 3 + 2)', lone.length === 0, lone.length + ' widths, first ' + lone.slice(0, 5).join());
const squeezed = [];
for (let W = 256; W <= 900; W++) { const l = layout(W); if (!l || l.track < MIN_CARD || l.width > W + 0.5) squeezed.push(W); }
ok('no card is squeezed below its content, and the row never runs out of the panel (256-900px)', squeezed.length === 0, squeezed.length + ' widths, first ' + squeezed.slice(0, 5).join());
const phone = layout(W_PHONE);
ok('a 360px phone (' + W_PHONE + 'px) fits its columns inside the panel', !!phone && phone.width <= W_PHONE && phone.track >= MIN_CARD, JSON.stringify(phone));

ok('control: the loading / failed placeholder still spans the whole grid', /grid-column:1\/-1;/.test(TAB));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
