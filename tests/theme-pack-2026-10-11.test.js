/**
 * tests/theme-pack-2026-10-11.test.js
 *
 * Roadmap A3: the twelve new CRM themes from the My Skin spec (section 17).
 * Jo, 2026-10-11: all twelve ship to everyone - none locked, none Pro-only.
 *
 *   1. every id is registered in ThemeEngine THEMES, unlocked, with a real
 *      category and the native mode the spec names; ids and names are unique
 *      across the whole registry (no duplicate of a live theme)
 *   2. each has a :root[data-theme] token line in theme-system.css that the
 *      engine entry mirrors, plus --glow/--glow2 and an --accent-fg line
 *   3. WCAG floors (the spec's own claims, measured with the shipping
 *      engine math): text on --s2 >= 10.9, muted on --s2 >= 6.2, accent on
 *      --bg >= 4.5, label on the accent fill >= 4.5
 *   4. --glow/--glow2 have :where(:root) defaults so var(--glow) always
 *      resolves in the other 195 themes
 *   5. art: original tiles only for the non-franchise themes
 *
 * Run: node tests/theme-pack-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const PACK = {
  'gameboy-dmg':      { name: 'Game Boy DMG',     category: 'popculture',   mode: 'dark' },
  'virtual-boy':      { name: 'Virtual Boy',      category: 'scifi',        mode: 'dark' },
  'ds-lite':          { name: 'DS Lite',          category: 'scifi',        mode: 'dark' },
  'pallet-town':      { name: 'Pallet Town',      category: 'popculture',   mode: 'dark' },
  'poke-center':      { name: 'Poké Center', category: 'popculture',   mode: 'light' },
  'mystery-dungeon':  { name: 'Mystery Dungeon',  category: 'anime',        mode: 'dark' },
  'hoenn-tides':      { name: 'Hoenn Tides',      category: 'nature',       mode: 'dark' },
  'mecha-hangar':     { name: 'Mecha Hangar',     category: 'anime',        mode: 'dark' },
  'saturday-morning': { name: 'Saturday Morning', category: 'cartoon',      mode: 'dark' },
  'shingle-crew':     { name: 'Shingle Crew',     category: 'construction', mode: 'dark' },
  'chalk-line':       { name: 'Chalk Line',       category: 'construction', mode: 'light' },
  'tar-paper':        { name: 'Tar Paper',        category: 'construction', mode: 'dark' },
};
const IDS = Object.keys(PACK);

const ENGINE = read('docs/pro/js/theme-engine.js');
const CSS = read('docs/pro/css/theme-system.css');

// shipping WCAG math
const { contrastRatio } = (() => {
  const start = ENGINE.indexOf('function parseHex');
  const crStart = ENGINE.indexOf('function contrastRatio', start);
  const end = ENGINE.indexOf('\n  }', crStart) + 4;
  const sb = { Math, __exp: null };
  vm.runInNewContext(ENGINE.slice(start, end) + '\nthis.__exp = { contrastRatio };', sb);
  return sb.__exp;
})();

// the shipping registry (pure data)
const tStart = ENGINE.indexOf('const THEMES = {');
const tEnd = ENGINE.indexOf('\n  };', tStart) + '\n  };'.length;
const sb = { __t: null };
vm.runInNewContext(ENGINE.slice(tStart, tEnd) + '\nthis.__t = THEMES;', sb);
const THEMES = sb.__t;
const CATS = [...ENGINE.matchAll(/\{ key: '([a-z]+)', label:/g)].map((m) => m[1]);

(async () => {
  console.log('1. registry');
  ok('all twelve ids are registered', IDS.every((id) => THEMES[id]), IDS.filter((id) => !THEMES[id]).join(','));
  for (const id of IDS) {
    const t = THEMES[id] || {};
    const p = PACK[id];
    ok(`${id}: "${p.name}", ${p.mode}-native, ${p.category}, unlocked for everyone`,
      t.name === p.name && t.mode === p.mode && t.category === p.category && t.locked === false && t.unlockCondition === null && CATS.includes(t.category));
  }
  const names = Object.values(THEMES).map((t) => t.name);
  ok('no duplicate theme names across the registry', new Set(names).size === names.length,
    names.filter((n, i) => names.indexOf(n) !== i).join(','));
  ok('ids appear exactly once in the file (no accidental double registration)',
    IDS.every((id) => ENGINE.split(`    '${id}': {`).length === 2));

  console.log('\n2. CSS token lines mirror the engine');
  for (const id of IDS) {
    const m = CSS.match(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
    const tok = {};
    if (m) m[1].replace(/--([\w-]+)\s*:\s*([^;]+);/g, (_, k, v) => { tok[k] = v.trim(); });
    const C = (THEMES[id] || {}).colors || {};
    const pairs = [['outerBg', 'bg'], ['bg', 's'], ['surface', 's2'], ['surface2', 's3'], ['text', 't'], ['muted', 'm'],
      ['accent', 'orange'], ['accentHover', 'ob'], ['accentBg', 'og'], ['green', 'green'], ['red', 'red'], ['gold', 'gold'], ['blue', 'blue'], ['rule', 'rule'], ['border', 'br']];
    const mismatch = pairs.filter(([a, b]) => String(C[a]).toLowerCase() !== String(tok[b]).toLowerCase());
    ok(`${id}: token line exists and the engine entry mirrors it`, !!m && mismatch.length === 0, JSON.stringify(mismatch));
    ok(`${id}: carries --glow and --glow2`, !!tok.glow && !!tok.glow2);
  }

  console.log('\n3. contrast floors (spec claims, measured)');
  for (const id of IDS) {
    const m = CSS.match(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
    const tok = {};
    if (m) m[1].replace(/--([\w-]+)\s*:\s*([^;]+);/g, (_, k, v) => { tok[k] = v.trim(); });
    const fg = (CSS.match(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{\\s*--accent-fg:\\s*(#[0-9a-f]{6})`, 'i')) || [])[1];
    const a = contrastRatio(tok.t, tok.s2), b = contrastRatio(tok.m, tok.s2), c = contrastRatio(tok.orange, tok.bg);
    ok(`${id}: text on --s2 ${a.toFixed(1)}:1 (>=10.9), muted ${b.toFixed(1)}:1 (>=6.2), accent on --bg ${c.toFixed(1)}:1 (>=4.5)`,
      a >= 10.9 && b >= 6.2 && c >= 4.5);
    ok(`${id}: --accent-fg declared and the label clears AA on the accent fill`, !!fg && contrastRatio(fg, tok.orange) >= 4.5,
      fg ? contrastRatio(fg, tok.orange).toFixed(2) : 'no --accent-fg line');
  }
  // self-test: the floor can fail
  ok('self-test: a mid-grey on white is caught', contrastRatio('#999999', '#ffffff') < 4.5);

  console.log('\n4. optional tokens always resolve');
  const where = CSS.match(/:where\(:root\)\s*\{([^}]*)\}/);
  ok(':where(:root) defines --glow and --glow2 (zero specificity, so a theme line wins)',
    !!where && /--glow\s*:/.test(where[1]) && /--glow2\s*:/.test(where[1]));
  ok('the glow hover rule is scoped to the twelve new themes only', (() => {
    const i = CSS.lastIndexOf('/*', CSS.indexOf('New theme pack: card glow'));
    const j = CSS.indexOf('/* ══', i + 10);
    const block = CSS.slice(i, j === -1 ? CSS.length : j);
    return IDS.every((id) => block.includes(`[data-theme="${id}"]`)) && !/animation|transition|@keyframes/.test(block.replace(/\/\*[\s\S]*?\*\//g, ''));
  })());

  console.log('\n5. art');
  const gen = await import(pathToFileURL(path.join(ROOT, 'scripts/build-theme-art.mjs')).href);
  const tiles = Object.keys(gen.TILES);
  ok('original construction-yard tiles exist for shingle-crew, chalk-line, tar-paper, mecha-hangar',
    ['shingle-crew', 'chalk-line', 'tar-paper', 'mecha-hangar'].every((id) => tiles.includes(id)));
  ok('franchise-named themes stay colour-only (private My Skin art is the route)',
    ['gameboy-dmg', 'virtual-boy', 'ds-lite', 'pallet-town', 'poke-center', 'mystery-dungeon', 'hoenn-tides'].every((id) => !tiles.includes(id)));

  console.log('\n' + '─'.repeat(50));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
