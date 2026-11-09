/**
 * tests/nbd-os-board-2026-11-09.test.js - NBD OS P1 "Board and drag", step 1
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md, sections 4 and 8 P1).
 *
 * Bento's pure board math (placement, gravity packing, move, resize, reading
 * order, pointer -> cell) is lifted into docs/pro/js/layouts/board-logic.js as
 * a factory. Since NBD OS P2 (2026-11-09) layouts/bento.js builds its math
 * from it (one copy); Bento's math as it shipped is frozen in
 * tests/lib/bento-logic-reference-2026-10-12.js, and parity runs against both. This proves:
 *   1. board-logic is a UMD file (window.NBDBoardLogic, require()-able), pure:
 *      no DOM, clock, storage or network, and no style attribute
 *   2. make() configured with Bento's catalogue gives NBDBentoLogic's outputs
 *      and the frozen reference's, byte for byte (JSON), on a table of inputs
 *      and a 400-step random walk, and require('bento.js')'s surface is unchanged
 *   3. firstFit (the one addition) finds the first gap in reading order
 *   4. carried fields (the OS desk's s / cfg) survive every op as copies
 *   5. it is the OS layout's 6th and last needs.script path (the cap is 6), and
 *      Bento's own needs path (bento.js loads lazily, so no boot tag)
 *
 * Run: node tests/nbd-os-board-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'docs/pro/js/layouts/board-logic.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let BL = null;
try { BL = require(FILE); } catch (e) { BL = null; }
ok('docs/pro/js/layouts/board-logic.js exists and require()s in Node', !!BL && typeof BL.make === 'function', fs.existsSync(FILE) ? 'loaded but no make()' : 'missing');
if (!BL) { console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); }
const SRC = read('docs/pro/js/layouts/board-logic.js');
const BENTO = require(path.join(ROOT, 'docs/pro/js/layouts/bento.js'));
const REF = require('./lib/bento-logic-reference-2026-10-12.js')({ COLS: 4, MAX_TILES: 24, MAX_Y: 40, CATALOG: BENTO.CATALOG, DEFAULT_RAW: BENTO.defaultBoard() });

console.log('\n1. a pure UMD file');
{
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  ok('window.NBDBoardLogic and module.exports', /root\.NBDBoardLogic = api/.test(SRC) && /module\.exports = api/.test(SRC));
  ok('no DOM, clock, storage, network or Firestore', !/document\.|localStorage|Date\.now|new Date|fetch\(|getDoc|setDoc|XMLHttpRequest/.test(code));
  ok('no style attribute and no inline style', !/style\s*=|\.style\.|setProperty/.test(code));
}

const P = BL.make({ cols: BENTO.COLS, maxTiles: BENTO.MAX_TILES, maxY: BENTO.MAX_Y, key: 'widgetId', catalog: BENTO.CATALOG, defaults: BENTO.defaultBoard() });
[['NBDBentoLogic (bento.js)', BENTO], ['Bento as it shipped (the frozen reference)', REF]].forEach(([who, B]) => {
console.log('\n2. Bento parity: make(Bento\'s catalogue) === ' + who);
{
  ok('bento.js still exports the same surface', J(Object.keys(B).sort()) === J(['BY_ID', 'CATALOG', 'COLS', 'MAX_TILES', 'MAX_Y', 'add', 'available', 'bottom', 'cellFromPoint', 'compact', 'defaultBoard',
    'describe', 'find', 'has', 'moveBy', 'moveTo', 'pack', 'remove', 'resizeBy', 'resizeTo', 'sanitize', 'swapOrder'].sort()), J(Object.keys(B).sort()));
  ok('the constants match (4 columns, 24 tiles, row 40)', P.COLS === 4 && P.MAX_TILES === 24 && P.MAX_Y === 40 && B.COLS === 4);
  ok('defaultBoard matches', J(P.defaultBoard()) === J(B.defaultBoard()));
  const raws = [
    null, 'x', 7, [], [{}], [null, 3, 'a'],
    [{ widgetId: 'revenue', x: 9, y: -3, w: 9, h: 9 }],
    [{ widgetId: 'today', x: 0, y: 5 }, { widgetId: 'today', x: 2, y: 0 }, { widgetId: 'nope', x: 0, y: 0, w: 1, h: 1 }],
    [{ widgetId: 'hail', x: '2', y: '1.6', w: 'z', h: null }, { widgetId: 'map', x: 3, y: 0, w: 1, h: 1 }],
    B.CATALOG.map((c, i) => ({ widgetId: c.id, x: i % 4, y: Math.floor(i / 2), w: c.max[0], h: c.max[1] })),
    B.CATALOG.concat(B.CATALOG).map((c, i) => ({ widgetId: c.id, x: 3 - (i % 4), y: 40 - i })),
  ];
  ok('sanitize matches on ' + raws.length + ' raw inputs', raws.every((r) => J(P.sanitize(r)) === J(B.sanitize(r))), raws.map((r) => J(P.sanitize(r)) === J(B.sanitize(r))).join());
  const board = B.defaultBoard();
  const geo = { left: 10, top: 20, width: 600, rowH: 160, gap: 12 };
  const cases = [];
  B.CATALOG.forEach((c) => {
    cases.push(['moveTo', [board, c.id, 3, 0]], ['moveTo', [board, c.id, -2, 99]], ['moveTo', [board, c.id, 'a', null]],
      ['moveBy', [board, c.id, 1, 0]], ['moveBy', [board, c.id, -1, 1]], ['moveBy', [board, c.id, 0, -1]],
      ['swapOrder', [board, c.id, -1]], ['swapOrder', [board, c.id, 1]],
      ['resizeTo', [board, c.id, 4, 3]], ['resizeTo', [board, c.id, 0, 0]], ['resizeBy', [board, c.id, 1, 1]], ['resizeBy', [board, c.id, -1, -1]],
      ['remove', [board, c.id]], ['add', [board, c.id]], ['has', [board, c.id]], ['find', [board, c.id]],
      ['describe', [board, c.id, false]], ['describe', [board, c.id, true]], ['pack', [board, c.id]]);
  });
  cases.push(['compact', [board]], ['bottom', [board]], ['available', [board]], ['available', [[]]],
    ['cellFromPoint', [geo, 0, 0]], ['cellFromPoint', [geo, 333, 400]], ['cellFromPoint', [geo, 9999, 9999]], ['cellFromPoint', [geo, 160, 171]]);
  const bad = cases.filter(([fn, args]) => J(P[fn].apply(null, args)) !== J(B[fn].apply(null, args)));
  ok('every op matches on ' + cases.length + ' table cases', !bad.length, bad.slice(0, 3).map(([fn, a]) => fn + ' ' + a[1]).join('; '));
  // the D5 random walk, run through both and compared at every step
  let seed = 1234567;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let a = B.defaultBoard(), b = P.defaultBoard(), same = true, at = -1;
  const ops = ['moveBy', 'moveTo', 'swapOrder', 'resizeBy', 'resizeTo', 'add', 'remove'];
  for (let i = 0; i < 400 && same; i++) {
    const op = ops[rnd(ops.length)];
    const id = B.CATALOG[rnd(B.CATALOG.length)].id;
    const args = op === 'moveBy' ? [id, rnd(3) - 1, rnd(3) - 1] : op === 'moveTo' ? [id, rnd(5), rnd(8)] : op === 'swapOrder' ? [id, rnd(2) ? 1 : -1]
      : op === 'resizeBy' ? [id, rnd(3) - 1, rnd(3) - 1] : op === 'resizeTo' ? [id, 1 + rnd(4), 1 + rnd(3)] : [id];
    a = B[op].apply(null, [a].concat(args));
    b = P[op].apply(null, [b].concat(args));
    if (J(a) !== J(b)) { same = false; at = i; }
  }
  ok('a 400-step random walk stays identical at every step', same, 'diverged at step ' + at);
}
});

console.log('\n3. firstFit: the first gap, reading order');
{
  const Q = BL.make({ cols: 4, maxTiles: 24, maxY: 48, key: 'k', catalog: [{ id: 'a', title: 'A', def: [1, 1], min: [1, 1], max: [2, 2] }], kind: 'id' });
  ok('an empty board: top left', J(Q.firstFit([], 2, 1)) === J({ x: 0, y: 0 }));
  ok('beside a 2-wide tile on row 1', J(Q.firstFit([{ k: '1', id: 'a', x: 0, y: 0, w: 2, h: 1 }], 2, 1)) === J({ x: 2, y: 0 }));
  ok('a full row: the next row', J(Q.firstFit([{ k: '1', id: 'a', x: 0, y: 0, w: 2, h: 1 }, { k: '2', id: 'a', x: 2, y: 0, w: 2, h: 1 }], 1, 1)) === J({ x: 0, y: 1 }));
  ok('a hole a small tile fits but a wide one does not', J(Q.firstFit([{ k: '1', id: 'a', x: 0, y: 0, w: 2, h: 2 }, { k: '2', id: 'a', x: 3, y: 0, w: 1, h: 1 }], 1, 1)) === J({ x: 2, y: 0 })
    && J(Q.firstFit([{ k: '1', id: 'a', x: 0, y: 0, w: 2, h: 2 }, { k: '2', id: 'a', x: 3, y: 0, w: 1, h: 1 }], 2, 1)) === J({ x: 2, y: 1 }));
  ok('a too-wide request clamps to the column count', J(Q.firstFit([], 9, 1)) === J({ x: 0, y: 0 }));
}

console.log('\n4. carried fields ride along as copies; the key and the catalogue field can differ');
{
  const cat = [{ id: 'coach', title: 'Coach', def: [2, 1], min: [1, 1], max: [2, 2] }];
  const Q = BL.make({ cols: 4, maxTiles: 24, maxY: 48, key: '_b', kind: 'id', carry: ['s', 'cfg', '_k'], catalog: cat });
  const cfg = { show: 'both' };
  const board = [{ _b: 'b0', id: 'coach', s: 'm', cfg, _k: 'coach-1', x: 0, y: 0, w: 2, h: 1 }, { _b: 'b1', id: 'coach', s: 'm', x: 2, y: 0, w: 2, h: 1 }];
  const moved = Q.moveTo(board, 'b1', 0, 0);
  ok('two tiles of one widget are told apart by the key', moved.length === 2 && Q.find(moved, 'b1').y === 0 && Q.find(moved, 'b0').y === 1, J(moved));
  ok('s, cfg and the caller\'s tag survive, and cfg is a copy', Q.find(moved, 'b0').s === 'm' && J(Q.find(moved, 'b0').cfg) === J(cfg) && Q.find(moved, 'b0').cfg !== cfg && Q.find(moved, 'b0')._k === 'coach-1');
  ok('resizeTo bounds come from the catalogue entry the kind field names', J(Q.find(Q.resizeTo(board, 'b0', 9, 9), 'b0')) === J({ _b: 'b0', id: 'coach', x: 0, y: 0, w: 2, h: 2, s: 'm', cfg, _k: 'coach-1' }));
  ok('an unknown catalogue entry or an own-property lookup is refused, never thrown', Q.resizeTo([{ _b: 'x', id: 'toString', x: 0, y: 0, w: 1, h: 1 }], 'x', 2, 2)[0].w === 1
    && J(Q.sanitize([{ _b: 'x', id: '__proto__' }])) === '[]');
}

console.log('\n5. the OS layout loads it: the 6th and last needs.script path');
{
  const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
  const def = R.get('os');
  const sc = def ? def.needs.script : [];
  ok('needs.script ends with js/layouts/board-logic.js, 6 paths (the cap)', sc.length === 6 && sc[5] === 'js/layouts/board-logic.js', J(sc));
  ok('no new <script> tag in dashboard.html', !/board-logic/.test(read('docs/pro/dashboard.html')));
  // NBD OS P2: one copy. bento.js builds its math from board-logic; the reference above pins parity.
  const BS = read('docs/pro/js/layouts/bento.js');
  ok('bento.js builds its board math from NBDBoardLogic.make (no second copy of pack)', /NBDBoardLogic/.test(BS) && /\.make\(/.test(BS) && !/function pack\(/.test(BS));
  const bento = R.get('bento');
  ok('Bento\'s needs.script loads board-logic before bento.js (its own lazy path)', !!bento && J(bento.needs.script) === J(['js/layouts/kit.js', 'js/layouts/board-logic.js']), J(bento && bento.needs.script));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
