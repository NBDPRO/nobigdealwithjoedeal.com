/**
 * tests/trophy-case-2026-10-11.test.js — achievement unlock toasts + the
 * Trophy Case drawer (CRM style integration C3).
 *
 * Checks:
 *   - PURE: progress %, the "what is left" wording per achievement, the
 *     "almost there" nudge (only for locked rows at/after 60%), the drawer's
 *     order (closest first, earned last) and summary, confetti determinism;
 *   - DOM (a tiny fake document): the toast shows name + swatches + Try theme,
 *     is built with textContent (a hostile theme name is inert), carries no
 *     confetti under Reduce Motion, has ~56 pieces without it, and Try theme
 *     unlocks then applies; the drawer lists all 10 with progressbar
 *     semantics;
 *   - wiring: ThemeAchievements.unlock fires `themeunlock` and keeps the old
 *     banner only when the Trophy Case is absent; the script rides the `theme`
 *     bundle; the css paints from tokens and honours Reduce Motion.
 *
 * Zero deps. Run: node tests/trophy-case-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// ── a tiny DOM, enough for the module's createElement/appendChild/classList ──
function makeDoc() {
  const listeners = {};
  function node(tag) {
    const n = {
      tag, className: '', textContent: '', children: [], parentNode: null, attrs: {}, style: {
        props: {}, setProperty(k, v) { this.props[k] = v; },
      }, _l: {},
      get classList() {
        const self = this;
        return {
          add(c) { if (!self.className.split(' ').includes(c)) self.className = (self.className + ' ' + c).trim(); },
          remove(c) { self.className = self.className.split(' ').filter((x) => x && x !== c).join(' '); },
          contains(c) { return self.className.split(' ').includes(c); },
        };
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      addEventListener(t, f) { this._l[t] = f; },
      focus() {},
      closest(sel) {
        // only the selectors the module uses
        let cur = this;
        while (cur) {
          if (sel === '.tc-toast' && cur.className.split(' ').includes('tc-toast')) return cur;
          if (sel.includes('[data-tc-') && Object.keys(cur.attrs).some((k) => /^data-tc-/.test(k))) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
    };
    return n;
  }
  const body = node('body');
  const head = node('head');
  const html = node('html');
  const d = {
    body, head, documentElement: html, activeElement: null,
    createElement: node,
    addEventListener(t, f) { listeners[t] = f; },
    _fire(t, ev) { return listeners[t] && listeners[t](ev); },
  };
  return d;
}
function walk(n, fn) { fn(n); (n.children || []).forEach((c) => walk(c, fn)); }
const find = (n, pred) => { const out = []; walk(n, (x) => { if (pred(x)) out.push(x); }); return out; };

function load(opts) {
  opts = opts || {};
  delete require.cache[require.resolve('../docs/pro/js/trophy-case.js')];
  const doc = makeDoc();
  if (opts.reduce) doc.documentElement.attrs['data-motion'] = 'reduce';
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.requestAnimationFrame = (f) => f();
  globalThis.matchMedia = () => ({ matches: false });
  const applied = [];
  globalThis.ThemeEngine = {
    previewResolvedColors: () => ({ bg: '#111', surface: '#222', accent: '#eab308', text: '#fff' }),
    apply: (k) => applied.push('apply:' + k),
    unlock: (k) => applied.push('unlock:' + k),
    isUnlocked: (k) => k === 'gold-rush',
  };
  const chimes = [];
  globalThis.ThemeSounds = { isEnabled: () => opts.soundOff ? false : true, playNotification: (t) => chimes.push(t) };
  const M = require('../docs/pro/js/trophy-case.js');
  return { M, doc, applied, chimes };
}

console.log('TROPHY CASE — pure');
{
  const { M } = load();
  const P = M._pure;
  ok('pct clamps and rounds', P.pct(0.456) === 46 && P.pct(2) === 100 && P.pct(-1) === 0 && P.pct('x') === 0);
  ok('what is left, in the achievement\'s own unit',
    P.remainingText({ themeKey: 'road-warrior', current: 97, target: 100 }) === '3 more inspections'
    && P.remainingText({ themeKey: 'gold-rush', current: 9, target: 10 }) === '1 more closed deal'
    && P.remainingText({ themeKey: 'diamond', current: 92, target: 100 }) === '$8K more collected'
    && P.remainingText({ themeKey: 'iron-door', current: 450, target: 500 }) === '50 more doors');
  ok('Dragon Ball Super with no DBZ yet says so', P.remainingText({ themeKey: 'dragon-ball-super', progress: 0, current: 30, target: 50 }) === 'Earn Dragon Ball Z first');
  ok('a nudge only for locked rows at/after 60% and below 100%',
    /Almost there: 3 more inspections to Road Warrior/.test(P.nudgeFor({ themeKey: 'road-warrior', name: 'Road Warrior', current: 97, target: 100, progress: 0.97 }))
    && P.nudgeFor({ themeKey: 'road-warrior', name: 'Road Warrior', current: 10, target: 100, progress: 0.1 }) === ''
    && P.nudgeFor({ themeKey: 'gold-rush', name: 'Gold Rush', progress: 1, unlocked: true }) === ''
    && P.nudgeFor({ themeKey: 'night-owl', name: 'Night Owl', current: 6, target: 10, progress: 0.6 }) !== '');
  const rows = [
    { name: 'A', progress: 0.2 }, { name: 'B', progress: 1, unlocked: true }, { name: 'C', progress: 0.9 }, { name: 'D', progress: 0.2 },
  ];
  const sorted = P.sortRows(rows).map((r) => r.name).join('');
  ok('closest first, ties keep order, earned last', sorted === 'CADB', sorted);
  ok('summary names the closest locked theme', P.summaryText(rows) === '1 of 4 unlocked · closest: C (90%)');
  ok('summary with nothing started stays plain', P.summaryText([{ name: 'A', progress: 0 }]) === '0 of 1 unlocked');
  const seq = [0.1, 0.5, 0.9]; let i = 0; const rng = () => seq[i++ % 3];
  const a = P.confettiSpecs(5, rng); i = 0; const b = P.confettiSpecs(5, rng);
  ok('confetti is deterministic for a given rng and has the requested count', a.length === 5 && JSON.stringify(a) === JSON.stringify(b));
}

console.log('\nTROPHY CASE — toast');
{
  const { M, doc, applied, chimes } = load();
  M.toast({ themeKey: 'gold-rush', name: '<img src=x onerror=alert(1)>', icon: '💰', description: 'Close 10 deals' });
  const toast = find(doc.body, (n) => n.className.split(' ').includes('tc-toast'))[0];
  ok('a toast is on the page', !!toast);
  const name = find(toast, (n) => n.className === 'tc-toast-name')[0];
  ok('the theme name is set as text (a hostile name is inert)', name && name.textContent === '<img src=x onerror=alert(1)>');
  ok('it is a polite live region', toast.attrs.role === 'status' && toast.attrs['aria-live'] === 'polite');
  ok('it shows the theme\'s four swatches', find(toast, (n) => n.className === 'tc-sw').length === 4);
  const conf = find(toast, (n) => /\btc-conf\b/.test(n.className));
  ok('confetti: ~56 CSS pieces, no library', conf.length === 56);
  ok('the chime plays through theme-sounds', chimes.length === 1);
  const tryBtn = find(toast, (n) => n.attrs['data-tc-try'])[0];
  doc._fire('click', { target: tryBtn, preventDefault() {} });
  ok('Try theme unlocks then applies the theme', applied.join() === 'unlock:gold-rush,apply:gold-rush', applied.join());
}
{
  const { M, doc } = load({ reduce: true });
  M.toast({ themeKey: 'gold-rush', name: 'Gold Rush', icon: '💰' });
  const toast = find(doc.body, (n) => n.className.split(' ').includes('tc-toast'))[0];
  ok('Reduce Motion: calm toast, no confetti pieces', toast.className.includes('tc-calm') && find(toast, (n) => /\btc-conf\b/.test(n.className)).length === 0);
}
{
  const { M, chimes } = load({ soundOff: true });
  M.toast({ themeKey: 'gold-rush', name: 'Gold Rush', icon: '💰' });
  ok('sounds off in theme-sounds: no chime', chimes.length === 0);
}

console.log('\nTROPHY CASE — drawer');
(async () => {
  const { M, doc } = load();
  const defs = [
    ['gold-rush', 'Gold Rush', 0.9], ['eternal-flame', 'Eternal Flame', 0.1], ['iron-door', 'Iron Door', 0.65], ['diamond', 'Diamond', 0],
    ['completionist', 'Completionist', 0.3], ['night-owl', 'Night Owl', 0.5], ['road-warrior', 'Road Warrior', 0.97],
    ['legend', 'Legend', 0.2], ['dragon-ball-super', 'Dragon Ball Super', 0], ['hologram', 'Hologram', 0.4],
  ];
  globalThis.ThemeAchievements = {
    getAll: async () => defs.map(([themeKey, name, p]) => ({ themeKey, name, icon: '🏆', description: 'd', currentProgress: p, unlocked: false })),
    getProgress: async (k) => ({ current: 5, target: 10 }),
  };
  await M.open();
  await new Promise((r) => setTimeout(r, 20));
  const drawer = find(doc.body, (n) => n.className.split(' ').includes('tc-drawer'))[0];
  ok('the drawer is a modal dialog with a label', drawer && drawer.attrs.role === 'dialog' && drawer.attrs['aria-modal'] === 'true' && !!drawer.attrs['aria-label']);
  const rows = find(drawer, (n) => /\btc-row\b/.test(n.className) && n.tag === 'li');
  ok('it lists all 10 achievement themes', rows.length === 10, String(rows.length));
  const names = rows.map((r) => find(r, (n) => n.className === 'tc-row-name')[0].textContent);
  ok('gold-rush is earned (isUnlocked) and sorts last; the closest locked one is first', names[0] === 'Road Warrior' && names[9] === 'Gold Rush', names.join('|'));
  const bars = find(drawer, (n) => n.attrs.role === 'progressbar');
  ok('every row has a progressbar with a value', bars.length === 10 && bars.every((b) => /^\d+$/.test(b.attrs['aria-valuenow'])));
  const nudges = find(drawer, (n) => /\btc-near\b/.test(n.className));
  ok('"almost there" nudges appear for the rows at 60%+ (Road Warrior, Iron Door)', nudges.length === 2, String(nudges.length));
  const sum = find(drawer, (n) => n.className === 'tc-sum')[0];
  ok('the summary line counts the earned one', /^1 of 10 unlocked/.test(sum.textContent), sum.textContent);
  M.close();

  console.log('\nTROPHY CASE — wiring');
  const ach = read('docs/pro/js/theme-achievements.js');
  ok('ThemeAchievements.unlock fires themeunlock', /new CustomEvent\('themeunlock'/.test(ach));
  ok('the old banner only shows when the Trophy Case is absent', /!\(window\.NBDTrophyCase && window\.NBDTrophyCase\.handlesToasts\)\)\s*\{\s*this\._showUnlockToast/.test(ach));
  ok('the panel offers Open Trophy Case', /data-tc-open="1">Open Trophy Case/.test(ach));
  const loader = read('docs/pro/js/script-loader.js');
  const themeBundle = (loader.match(/theme: \[[\s\S]*?\]/) || [''])[0];
  ok('trophy-case.js rides the theme bundle after theme-achievements.js',
    /theme-achievements\.js[^\n]*\n\s*'js\/trophy-case\.js\?v=\d+'/.test(themeBundle), themeBundle);
  const src = strip(read('docs/pro/js/trophy-case.js'));
  ok('no inline handler, no innerHTML in the module', !/\.innerHTML\s*=/.test(src) && !/\son[a-z]+\s*=\s*["']/i.test(src));
  const css = strip(read('docs/pro/css/trophy-case.css'));
  ok('css: no hex literal outside the medal shading (#fff / #000 mixes)', (css.match(/#[0-9a-f]{3,8}\b/gi) || []).every((h) => /^#(fff|000)$/i.test(h)));
  ok('css: Reduce Motion drops the shine, the pop and the confetti', /prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none/.test(css) && /\.tc-calm/.test(css));
  const used = [...new Set((css.match(/var\(\s*(--[a-z0-9-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')))];
  const local = ['--tc-p', '--tc-sw', '--tx', '--ty', '--rot', '--d', '--t'];
  const defined = (name) => ['docs/pro/css/theme-system.css', 'docs/pro/css/dashboard-app.css', 'docs/pro/css/ui-primitives.css', 'docs/pro/css/theme-bridge.css']
    .some((f) => new RegExp(name.replace(/-/g, '\\-') + '\\s*:').test(read(f)));
  const undef = used.filter((t) => !local.includes(t) && !defined(t));
  ok('css: every theme token it reads exists (' + used.length + ')', used.length >= 8 && undef.length === 0, undef.join(', '));

  console.log('\n' + (failed ? 'FAILED ' + failed : 'PASSED ' + passed) + ' (' + passed + ' ok)');
  process.exit(failed ? 1 : 0);
})();
