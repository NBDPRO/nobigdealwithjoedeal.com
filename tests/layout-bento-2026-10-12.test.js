/**
 * tests/layout-bento-2026-10-12.test.js — L01 Bento Board (D5): the board
 * logic (pure, require()'d) and the contracts the E2E can't see.
 *
 *   1. registered lazily for every surface; needs the shared kit; Classic and
 *      the other layouts are untouched
 *   2. catalogue: every wrapped widget id exists in widgets.js; money tiles are
 *      labelled honestly (revenue = collected, pipeline = projected) and the
 *      wrapped revenue widget really reads collected payments
 *   3. board math: sanitize (unknown / duplicate / over-cap / out-of-range),
 *      no overlaps ever, gravity, move / resize / reading-order swap, add /
 *      remove, round trip through the stored shape
 *   4. company default board: normalizeCompany carries defaultWidgets bounded
 *      like the rules, and saveCompany re-writes it (a picker save that omits
 *      it must not wipe the board)
 *   5. CSS has a class for every position the board can emit; scoped, tokens
 *      only, no inline styles; glass only behind the wallpaper / Surface style
 *   6. the browser half writes nothing but the layout settings and sends
 *      nothing; every user string goes through esc()
 *
 * Run: node tests/layout-bento-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const B = require(path.join(ROOT, 'docs/pro/js/layouts/bento.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const SRC = read('docs/pro/js/layouts/bento.js');
const CSS = read('docs/pro/css/layouts/bento.css');
const WIDGETS = read('docs/pro/js/widgets.js');
const SYS = read('docs/pro/js/layout-system.js');
const RULES = read('firestore.rules');

function overlaps(board) {
  for (let i = 0; i < board.length; i++) for (let j = i + 1; j < board.length; j++) {
    const a = board[i], b = board[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return [a.widgetId, b.widgetId];
  }
  return null;
}
function inBounds(board) {
  return board.every((t) => t.x >= 0 && t.y >= 0 && t.w >= 1 && t.h >= 1 && t.x + t.w <= B.COLS);
}
const t = (board, id) => board.find((x) => x.widgetId === id);

// ── 1. registry ────────────────────────────────────────────────────────
console.log('registry');
const def = R.get('bento');
ok('bento is registered', !!def);
ok('...for every surface (phone gets two columns)', def && ['phone', 'tablet', 'desktop'].every((s) => def.surfaces.indexOf(s) !== -1));
ok('...lazy: own script + stylesheet, the kit as a need', def && def.script === 'js/layouts/bento.js' && def.css === 'css/layouts/bento.css'
  && def.needs.script.join() === 'js/layouts/kit.js' && def.needs.css.join() === 'css/layouts/kit.css');
ok('...wallpaper + glass supported', def && def.supports.wallpaper === true && def.supports.glass === true);
ok('Classic is still the fallback and unchanged', R.get('classic') && !R.get('classic').script && R.FALLBACK === 'classic');
ok('precedence still resolves a bento choice', R.resolve({ surface: 'desktop', user: { id: 'bento' } }).id === 'bento');
ok('a company lock to bento wins over the user\'s choice', R.resolve({ surface: 'desktop', user: { id: 'focus' }, company: { defaultLayout: 'bento', locked: true } }).id === 'bento');
ok('no new <script> tag was added to dashboard.html for it', !/layouts\/bento/.test(read('docs/pro/dashboard.html')));

// ── 2. catalogue ───────────────────────────────────────────────────────
console.log('catalogue');
const widgetIds = new Set((WIDGETS.match(/\{id:'[a-z0-9-]+'/g) || []).map((m) => m.slice(5, -1)));
const wrapped = B.CATALOG.filter((c) => c.kind === 'widget');
ok('there are wrapped widget tiles', wrapped.length >= 10);
ok('every wrapped widget id exists in widgets.js', wrapped.every((c) => widgetIds.has(c.widget)),
  wrapped.filter((c) => !widgetIds.has(c.widget)).map((c) => c.widget).join());
ok('catalogue ids are unique and layout-id safe', new Set(B.CATALOG.map((c) => c.id)).size === B.CATALOG.length && B.CATALOG.every((c) => /^[a-z][a-z0-9]*$/.test(c.id)));
ok('every default size sits inside min..max and the grid', B.CATALOG.every((c) => c.def[0] >= c.min[0] && c.def[1] >= c.min[1] && c.def[0] <= c.max[0] && c.def[1] <= c.max[1] && c.max[0] <= B.COLS && c.min[0] >= 1));
// A tile that shows money must say which kind. The predicate is exercised on a
// known-bad catalogue first (positive control) so "passes" can mean something.
function moneyLabelProblems(cat) {
  return cat.filter((c) => /revenue|pipeline|booked|closed value/i.test(c.title))
    .filter((c) => !(/revenue/i.test(c.title) ? /collected/i : /projected/i).test(c.title)).map((c) => c.id);
}
ok('control: the label check flags an unlabelled revenue / pipeline tile',
  moneyLabelProblems([{ id: 'a', title: 'Revenue' }, { id: 'b', title: 'Pipeline value' }, { id: 'c', title: 'Revenue · collected' }]).join() === 'a,b');
ok('revenue tile says collected; pipeline tile says projected', moneyLabelProblems(B.CATALOG).length === 0
  && /collected/i.test(B.BY_ID.revenue.title) && /projected/i.test(B.BY_ID.pipeline.title));
ok('the wrapped revenue widget sums collected payments by date (NBDRevenue.collectedBetween)',
  /id:'revenue-month'[\s\S]{0,4000}collectedBetween/.test(WIDGETS) && B.BY_ID.revenue.widget === 'revenue-month');
ok('the wrapped close rate is the shared NBDNumbers.closeRate', /id:'win-rate'[\s\S]{0,600}NBDNumbers\.closeRate/.test(WIDGETS) && B.BY_ID.closerate.widget === 'win-rate');
ok('the default board is valid, packed and shows revenue + pipeline + today', (() => {
  const d = B.defaultBoard();
  return !overlaps(d) && inBounds(d) && ['revenue', 'pipeline', 'today', 'hail'].every((id) => t(d, id));
})());

// ── 3. board math ──────────────────────────────────────────────────────
console.log('board math');
const dirty = B.sanitize([
  { widgetId: 'revenue', x: 9, y: -3, w: 7, h: 0 },          // out of range
  { widgetId: 'revenue', x: 0, y: 0, w: 1, h: 1 },           // duplicate
  { widgetId: 'not-a-tile', x: 0, y: 0, w: 1, h: 1 },        // unknown
  { widgetId: 'pipeline', x: 'a', y: null, w: 2, h: 1 },     // junk numbers
  null, 'x', 5,
]);
ok('sanitize drops unknown + duplicate tiles, keeps the rest', dirty.length === 2 && t(dirty, 'revenue') && t(dirty, 'pipeline'));
ok('...clamps size to the tile\'s min..max and x into the grid', t(dirty, 'revenue').w === B.BY_ID.revenue.max[0] && t(dirty, 'revenue').h === B.BY_ID.revenue.min[1] && inBounds(dirty));
ok('...junk numbers fall back, no NaN anywhere', dirty.every((x) => Number.isInteger(x.x) && Number.isInteger(x.y)));
ok('sanitize(non-list) is null (so "no saved board" is distinguishable)', B.sanitize(null) === null && B.sanitize({}) === null && B.sanitize('x') === null);
ok('sanitize([]) is an empty board, not null (a rep can clear it)', Array.isArray(B.sanitize([])) && B.sanitize([]).length === 0);
const flood = B.sanitize(B.CATALOG.concat(B.CATALOG).map((c) => ({ widgetId: c.id, x: 0, y: 0, w: 1, h: 1 })));
ok('a board never exceeds the tile cap and never overlaps', flood.length <= B.MAX_TILES && !overlaps(flood) && inBounds(flood));
const stacked = B.sanitize([{ widgetId: 'revenue', x: 0, y: 0, w: 1, h: 1 }, { widgetId: 'closerate', x: 0, y: 0, w: 1, h: 1 }, { widgetId: 'hail', x: 0, y: 0, w: 2, h: 1 }]);
ok('tiles stacked on one cell are pushed apart', !overlaps(stacked));
const gap = B.sanitize([{ widgetId: 'revenue', x: 0, y: 7, w: 1, h: 1 }]);
ok('gravity: a lone tile floats to the top row', t(gap, 'revenue').y === 0);

// deterministic random walk: whatever the sequence, the board stays valid
let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
let walk = B.defaultBoard(), walkOk = true, walkWhy = '';
const ids = B.CATALOG.map((c) => c.id);
for (let i = 0; i < 400 && walkOk; i++) {
  const id = ids[rnd(ids.length)], op = rnd(8), here = walk.filter((x) => x.widgetId === id).length;
  if (op === 0) walk = B.add(walk, id);
  else if (op === 1) walk = B.remove(walk, id);
  else if (!here) continue;
  else if (op === 2) walk = B.moveBy(walk, id, rnd(3) - 1, rnd(3) - 1);
  else if (op === 3) walk = B.moveTo(walk, id, rnd(6) - 1, rnd(9) - 2);
  else if (op === 4) walk = B.resizeBy(walk, id, rnd(3) - 1, rnd(3) - 1);
  else if (op === 5) walk = B.swapOrder(walk, id, rnd(2) ? 1 : -1);
  else walk = B.sanitize(JSON.parse(JSON.stringify(walk)));
  const bad = overlaps(walk);
  if (bad || !inBounds(walk) || walk.length > B.MAX_TILES || new Set(walk.map((x) => x.widgetId)).size !== walk.length) {
    walkOk = false; walkWhy = 'step ' + i + ' op ' + op + ' on ' + id + (bad ? ' overlap ' + bad : '');
  }
}
ok('400 random add / remove / move / resize / swap steps never break the board', walkOk, walkWhy);

const base = B.sanitize([
  { widgetId: 'revenue', x: 0, y: 0, w: 1, h: 1 },
  { widgetId: 'closerate', x: 1, y: 0, w: 1, h: 1 },
  { widgetId: 'hail', x: 0, y: 1, w: 2, h: 1 },
]);
ok('moveBy right moves one column', t(B.moveBy(base, 'revenue', 1, 0), 'closerate') && t(B.moveBy(base, 'closerate', 1, 0), 'closerate').x === 2);
ok('moving past the right edge stops at the edge', t(B.moveTo(base, 'closerate', 99, 0), 'closerate').x === B.COLS - 1);
ok('moving a tile onto another pushes the other down, not under', (() => {
  const m = B.moveTo(base, 'closerate', 0, 0);
  return t(m, 'closerate').x === 0 && t(m, 'closerate').y === 0 && !overlaps(m) && t(m, 'revenue').y >= 1;
})());
ok('resizeBy respects the tile\'s max and min', B.resizeBy(base, 'revenue', 9, 9) !== base && t(B.resizeBy(base, 'revenue', 9, 9), 'revenue').w === B.BY_ID.revenue.max[0]
  && t(B.resizeBy(base, 'revenue', -9, -9), 'revenue').w === B.BY_ID.revenue.min[0]);
ok('growing a tile at the right edge shifts it left instead of off-grid', (() => {
  const m = B.resizeTo(B.moveTo(base, 'closerate', 3, 0), 'closerate', 2, 1);
  return t(m, 'closerate').w === 2 && t(m, 'closerate').x === 2 && inBounds(m);
})());
ok('swapOrder changes the reading order by one place', (() => {
  const order = (b) => b.slice().sort((a, c) => a.y - c.y || a.x - c.x).map((x) => x.widgetId).join();
  const after = B.swapOrder(base, 'revenue', 1);
  return order(base) === 'revenue,closerate,hail' && order(after) === 'closerate,revenue,hail';
})());
ok('swapOrder at either end is a no-op', B.swapOrder(base, 'revenue', -1) === base && B.swapOrder(base, 'hail', 1) === base);
ok('add puts a tile at the bottom at its default size; a second add is a no-op', (() => {
  const a = B.add(base, 'map');
  return t(a, 'map') && t(a, 'map').y >= 2 && t(a, 'map').w === B.BY_ID.map.def[0] && B.add(a, 'map') === a && B.add(base, 'nope') === base;
})());
ok('remove then available lists the tile again', (() => {
  const r = B.remove(base, 'hail');
  return !B.has(r, 'hail') && B.available(r).some((c) => c.id === 'hail') && !B.available(base).some((c) => c.id === 'hail');
})());
ok('the stored shape round-trips through JSON unchanged', JSON.stringify(B.sanitize(JSON.parse(JSON.stringify(base)))) === JSON.stringify(base));
ok('a stored board fits the layoutState size cap', JSON.stringify(flood).length <= R.MAX_STATE_JSON, String(JSON.stringify(flood).length));
ok('the registry keeps a bento board in layoutState and drops an oversize one', (() => {
  const keep = R.normalizeUser({ layoutState: { bento: base } }).layoutState.bento;
  const huge = R.normalizeUser({ layoutState: { bento: new Array(2000).fill({ widgetId: 'revenue', x: 0, y: 0, w: 1, h: 1 }) } }).layoutState.bento;
  return Array.isArray(keep) && keep.length === 3 && huge === undefined;
})());
ok('cellFromPoint maps a point to a cell and clamps to the grid', (() => {
  const geo = { left: 100, top: 50, width: 4 * 100 + 3 * 12, rowH: 160, gap: 12 };
  const a = B.cellFromPoint(geo, 100 + 5, 50 + 5), b = B.cellFromPoint(geo, 100 + 112 * 3 + 5, 50 + 172 + 5), c = B.cellFromPoint(geo, 9999, -50);
  return a.x === 0 && a.y === 0 && b.x === 3 && b.y === 1 && c.x === 3 && c.y === 0;
})());
ok('describe gives a spoken position (desktop) and order (phone)', /column 1, row 1, 1 by 1/.test(B.describe(base, 'revenue', false)) && /position 1 of 3/.test(B.describe(base, 'revenue', true)));

// ── 4. company default board ───────────────────────────────────────────
console.log('company default');
const co = R.normalizeCompany({ defaultLayout: 'bento', defaultWidgets: { bento: base, focus: [], 'Bad Id': [], toobig: new Array(25).fill({}), notlist: 'x' } });
ok('normalizeCompany carries a bento default and drops junk keys / over-cap / non-lists',
  Array.isArray(co.defaultWidgets.bento) && co.defaultWidgets.bento.length === 3 && Object.keys(co.defaultWidgets).sort().join() === 'bento,focus');
ok('...no defaultWidgets reads as {}', Object.keys(R.normalizeCompany({}).defaultWidgets).length === 0 && Object.keys(R.normalizeCompany(null).defaultWidgets).length === 0);
ok('...more than 8 layouts is clipped to 8', Object.keys(R.normalizeCompany({ defaultWidgets: { a: [], b: [], c: [], d: [], e: [], f: [], g: [], h: [], i: [], j: [] } }).defaultWidgets).length === 8);
const sc = strip(SYS).match(/function saveCompany[\s\S]*?\n  \}\n/);
ok('saveCompany carries defaultWidgets forward when a patch omits it, and writes it', !!sc
  && /defaultWidgets: 'defaultWidgets' in p \? p\.defaultWidgets : company\.defaultWidgets/.test(sc[0])
  && /data\.defaultWidgets = next\.defaultWidgets/.test(sc[0]));
ok('the rules bound defaultWidgets (map, <= 8 layouts, bento a list <= 24)',
  /d\.defaultWidgets is map && d\.defaultWidgets\.size\(\) <= 8/.test(RULES) && /d\.defaultWidgets\.bento is list && d\.defaultWidgets\.bento\.size\(\) <= 24/.test(RULES));
ok('the rules suite has the positive + negative controls for the default board', (() => {
  const rt = read('tests/firestore-rules.test.js');
  return /company_admin writes a default Bento board', 'allow'/.test(rt) && /a rep cannot set the default board', 'deny'/.test(rt)
    && /a board of 25 tiles is refused', 'deny'/.test(rt) && /a board of 24 tiles is accepted/.test(rt);
})());
ok('only an owner / company_admin sees the company-default button', /function canAdmin[\s\S]{0,400}viewer[\s\S]{0,200}sales_rep[\s\S]{0,200}manager/.test(SRC)
  && /if \(admin\) \{[\s\S]{0,200}company-save/.test(SRC));

// ── 5. CSS ─────────────────────────────────────────────────────────────
console.log('css');
const emitted = new Set();
(function collect() {
  // every class cellClasses() can emit for any legal tile
  for (let x = 0; x < B.COLS; x++) for (let y = 0; y <= B.MAX_Y; y++) for (let w = 1; w <= B.COLS; w++) for (let h = 1; h <= 3; h++) {
    emitted.add('bn-c' + (x + 1)); emitted.add('bn-r' + (y + 1)); emitted.add('bn-w' + w); emitted.add('bn-h' + h);
  }
})();
const cssHas = (c) => new RegExp('\\.' + c + '\\b').test(CSS);
const missing = Array.from(emitted).filter((c) => !cssHas(c));
ok('control: the class probe fails for a class that does not exist', cssHas('bn-r99') === false && cssHas('bn-r1') === true);
ok('CSS has a class for every position and size the board can emit', missing.length === 0, missing.slice(0, 5).join());
const css = strip(CSS);
// split a selector list on top-level commas only (:is(a, b) stays whole)
function topSplit(sel) {
  const out = []; let d = 0, cur = '';
  for (const ch of sel) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out;
}
const unscoped = css.split('}').map((b) => b.split('{')[0].trim()).filter((x) => x && !/^@/.test(x))
  .reduce((acc, x) => acc.concat(topSplit(x)), []).map((x) => x.trim()).filter((x) => !x.startsWith('html[data-layout="bento"]'));
ok('control: an unscoped selector would be caught', topSplit('.a, :is(.b, .c)').map((x) => x.trim()).filter((x) => !x.startsWith('html[data-layout="bento"]')).length === 2);
ok('every selector is scoped under html[data-layout="bento"]', unscoped.length === 0, unscoped.slice(0, 3).join(' | '));
ok('no hard-coded colours (tokens only) and no inline style hooks', !/#[0-9a-f]{3,8}\b/i.test(css.replace(/var\([^)]*#[0-9a-f]+[^)]*\)/gi, '')) && !/\brgba?\(/.test(css));
ok('glass only behind the wallpaper class or Surface style: Glass',
  /my-skin-wallpaper \.bn-cell > \.lk-widget,\s*html\[data-layout="bento"\]\[data-surface="glass"\]/.test(css) && !/backdrop-filter/.test(css.replace(/my-skin-wallpaper[\s\S]*?\}/g, '').replace(/@media \(prefers-contrast[\s\S]*?\}\s*\}/g, '')));
// 2026-10-15: every tap target in the layouts is at least 44px (was 40px here).
ok('phone is two columns and edit buttons are >= 44px', /max-width: 768px[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/.test(css) && /\.bn-tbtn \{[^}]*min-width: 44px; min-height: 44px/.test(css));
ok('drag cursors only where there is a hover pointer and room', /@media \(hover: hover\) and \(min-width: 769px\)[\s\S]*touch-action: none/.test(css));

// ── 6. the browser half ────────────────────────────────────────────────
console.log('browser half');
const code = strip(SRC);
ok('no inline style attributes, inline handlers, or script tags in the markup it builds', !/style\s*=\s*["']/.test(code) && !/\bon[a-z]+\s*=\s*["']/.test(code) && !/<script/i.test(code));
ok('control: the markup probe would catch an inline style', /style\s*=\s*["']/.test('<div style="x:1">'));
ok('writes only through LayoutEngine (saveUser / saveCompany); no lead, task, doc or network writes',
  !/\b(setDoc|updateDoc|addDoc|deleteDoc|_saveLead|fetch|XMLHttpRequest|sendBeacon|httpsCallable)\b/.test(code)
  && /E\.saveUser\(/.test(code) && /E\.saveCompany\(/.test(code));
ok('nothing is sent: no sms:/tel:/mailto: links built', !/sms:|tel:|mailto:/.test(code));
ok('a lead\'s name reaches markup only through esc()', /esc\(K0\.leadName\(l\)\)/.test(code) && !/innerHTML\s*=[^;]*leadName\((?!l\))/.test(code));
ok('every catalogue title / about string is escaped where it is placed', /esc\(c\.title\)/.test(code) && /esc\(c\.about\)/.test(code));
ok('keyboard path: arrows move, Shift+arrows resize, Delete removes', /ArrowLeft'\) act = ev\.shiftKey \? 'narrower' : 'left'/.test(code) && /ArrowUp'\) act = ev\.shiftKey \? 'shorter' : 'up'/.test(code) && /Delete/.test(code));
ok('moves are announced in a polite live region', /aria-live="polite"/.test(code) && /say\(describe\(/.test(code));
ok('the shared Widget wrapper builds every tile', /k\.widget\(\{/.test(code));
ok('the adopted Today list is put back on unmount and before each rebuild', /function releaseToday/.test(code) && (code.match(/releaseToday\(\)/g) || []).length >= 3);
ok('unmount hands the classic widget grid back (NBDWidgets.render)', /W\.NBDWidgets\.render\(\)/.test(code));
ok('registers with the engine', /E\.implement\('bento', \{ mount: mount, unmount: unmount \}\)/.test(code));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
