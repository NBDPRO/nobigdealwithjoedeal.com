/**
 * tests/command-palette-scopes-2026-10-11.test.js — Command palette 2.0
 * (CRM style integration C4).
 *
 * Checks:
 *   - scope prefixes (@ # > t: =);
 *   - the safe expression parser: roofing units and money in cents, percent,
 *     conversions, error wording, and that hostile input is inert (the module
 *     never calls eval / Function; deep nesting and long input are capped);
 *   - plain-scope math detection does not fire on phone numbers;
 *   - usage ranking (boost cap, pruning, top-used);
 *   - theme rows (current first, locked last, query filters);
 *   - scoped results through a stubbed palette context: @ people, # jobs only
 *     job stages, > actions ranked by usage with pinned-lead actions first,
 *     t: themes with locked rows marked, = math rows that copy;
 *   - wiring in command-palette.js (loads the layer on open, passes the
 *     pinned lead to run(), keeps the classic list as the fallback) and css.
 *
 * Zero deps. Run: node tests/command-palette-scopes-2026-10-11.test.js
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

globalThis.window = globalThis;
const X = require('../docs/pro/js/command-palette-scopes.js');
const P = X._pure;
const m = (s) => X.evalMath(s);
const text = (s) => { const r = m(s); return r.ok ? r.text : 'ERR:' + r.error; };

console.log('PALETTE 2.0 — scope prefixes');
{
  const p = X.parseScope;
  ok('@ people', p('@maya').scope === 'people' && p('@maya').q === 'maya');
  ok('# jobs', p('#  4106').scope === 'jobs' && p('#  4106').q === '4106');
  ok('> actions', p('> new').scope === 'actions' && p('> new').q === 'new');
  ok('= math', p('= 32 sq x $485').scope === 'math' && p('= 32 sq x $485').q === '32 sq x $485');
  ok('t: / theme: themes, any case', p('t:gold').scope === 'themes' && p('T: gold').q === 'gold' && p('theme: paper').scope === 'themes');
  ok('no prefix, and a word that merely starts with t', p('tom').scope === 'all' && p('tom').q === 'tom' && p('team').scope === 'all');
  ok('leading space is ignored', p('  @x').scope === 'people');
}

console.log('\nPALETTE 2.0 — safe math');
{
  ok('32.4 sq x $485 = $15,714', text('32.4 sq x $485') === '$15,714', text('32.4 sq x $485'));
  ok('× and * work too', text('32.4 sq × $485') === '$15,714' && text('32.4 sq * $485') === '$15,714');
  ok('an explicit rate: $485/sq', text('32.4 sq x $485/sq') === '$15,714' && text('$485 per sq x 32.4 sq') === '$15,714', text('$485 per sq x 32.4 sq'));
  ok('a rate from a total: $15,714 / 32.4 sq', text('$15714 / 32.4 sq') === '$485/sq', text('$15714 / 32.4 sq'));
  ok('sqft <-> sq', text('2400 sqft in sq') === '24 sq' && text('24 sq to sqft') === '2,400 sqft');
  ok('sqft x $/sqft', text('2400 sqft x $4.85') === '$11,640', text('2400 sqft x $4.85'));
  ok('"sq ft" as two words is sqft', text('100 sq ft in sq') === '1 sq', text('100 sq ft in sq'));
  ok('brackets then a unit', text('(32.4 + 8) sq x $485') === '$19,594', text('(32.4 + 8) sq x $485'));
  ok('money is held in cents: $19.99 x 3', text('$19.99 * 3') === '$59.97' && text('$0.1 + $0.2') === '$0.30', text('$0.1 + $0.2'));
  ok('cents are kept as floats and rounded once: $0.005 x 1000 = $5 (not $10)', text('$0.005 * 1000') === '$5', text('$0.005 * 1000'));
  ok('percent: add, subtract, of', text('$15,000 + 10%') === '$16,500' && text('$15000 - 15%') === '$12,750' && text('200 * 15%') === '30');
  ok('k suffix and thousands commas', text('$15k + $1,250') === '$16,250');
  ok('powers and plain numbers', text('2 ^ 10') === '1,024' && text('1/3') === '0.3333');
  ok('a bare unit is one of it', text('sq') === '1 sq');
  ok('lf', text('120 lf x $8.5') === '$1,020', text('120 lf x $8.5'));
  ok('mixing units says so', /different units/.test(text('$100 + 5')) && /different units/.test(text('3 sq + 2 lf')));
  ok('division by zero is an error, not Infinity', /zero/.test(text('10 / 0')));
  ok('empty input prompts', /calculation/.test(text('')));
  const hostile = ['constructor', 'process.exit()', 'alert(1)', '__proto__', '1;2', 'this', 'Function("return 1")()', '`1`', '1 + (', ') 1', '$', '5 %% 2'];
  ok('hostile / malformed input is inert (never ok, never throws)', hostile.every((h) => { let r; try { r = m(h); } catch (_) { return false; } return r.ok === false; }), hostile.filter((h) => m(h).ok).join(' | '));
  ok('over-long input is refused', /long/.test(text('1+'.repeat(100) + '1')));
  ok('deep nesting is capped, no stack overflow', /bracket/i.test(text('('.repeat(20) + '1' + ')'.repeat(20))));
  const src = strip(read('docs/pro/js/command-palette-scopes.js'));
  ok('the module never calls eval or Function (positive control: the regex sees them)',
    !/\beval\s*\(/.test(src) && !/\bnew\s+Function\b/.test(src) && !/\bFunction\s*\(/.test(src)
    && /\beval\s*\(/.test('eval(x)') && /\bnew\s+Function\b/.test('new Function("x")'));
}

console.log('\nPALETTE 2.0 — plain-scope math detection');
{
  const L = P.looksLikeMath;
  ok('a calculation is detected', L('32.4 sq x $485') && L('$15,000 * 1.1') && L('2400 sqft / 100'));
  ok('phone numbers are not, even with an extension', !L('513-555-0100 x12') && !L('(513) 555-0100 ext 4') && !L('513-555-0100') && !L('(513) 555-0100') && !L('5135550100') && !L('513 555 0100'));
  ok('words and house numbers are not', !L('maya') && !L('214 sample ridge') && !L('4106'));
}

console.log('\nPALETTE 2.0 — usage ranking');
{
  ok('boost is 3 per use, capped at 20', P.usageBoostFor(1) === 3 && P.usageBoostFor(4) === 12 && P.usageBoostFor(50) === 20 && P.usageBoostFor(undefined) === 0);
  const big = {}; for (let i = 0; i < 200; i++) big['a' + i] = i + 1;
  const pr = P.prunedUsage(big);
  ok('the map is pruned, keeping the most used', Object.keys(pr).length <= 120 && pr.a199 === 200 && !('a0' in pr));
  ok('top used skips excluded ids', P.topUsed({ x: 5, y: 9, z: 2 }, 2, ['y']).join() === 'x,z');
}

console.log('\nPALETTE 2.0 — themes');
{
  const all = {
    paper: { name: 'Paper', category: 'professional', mode: 'light' },
    'gold-rush': { name: 'Gold Rush', category: 'achievement', mode: 'dark', locked: true, unlockCondition: 'Close 10 deals' },
    midnight: { name: 'Midnight', category: 'professional', mode: 'dark' },
    'gold-leaf': { name: 'Gold Leaf', category: 'luxury', mode: 'dark' },
  };
  const rows = P.themeRows(all, '', { current: 'midnight', isUnlocked: () => false });
  ok('current first, locked last', rows[0].key === 'midnight' && rows[rows.length - 1].key === 'gold-rush', rows.map((r) => r.key).join());
  const g = P.themeRows(all, 'gold', { isUnlocked: () => false });
  ok('a query filters by name; a prefix beats a substring', g.length === 2 && g.every((r) => /gold/.test(r.key)));
  ok('a locked theme says what unlocks it', g.find((r) => r.key === 'gold-rush').locked && g.find((r) => r.key === 'gold-rush').condition === 'Close 10 deals');
  ok('an earned theme is no longer locked', !P.themeRows(all, 'rush', { isUnlocked: () => true })[0].locked);
  ok('category words match', P.themeRows(all, 'luxury', {}).map((r) => r.key).join() === 'gold-leaf');
}

console.log('\nPALETTE 2.0 — scoped results through a stubbed palette');
{
  const score = (q, label, kw) => {
    if (!q) return 1;
    const l = String(label).toLowerCase(), k = String(kw || '').toLowerCase(), s = q.toLowerCase();
    return l.startsWith(s) ? 100 : l.includes(s) ? 60 : k.includes(s) ? 40 : 0;
  };
  const leadCalls = [];
  const ctx = {
    score,
    buildLeadResults: (q, pool) => { leadCalls.push({ q, pool }); return [{ id: 'lead:1', label: 'Maya', group: 'Leads', run() {} }]; },
    allActions: () => [
      { id: 'go-crm', label: 'CRM Kanban', icon: '📋', group: 'Navigation', keywords: 'pipeline', run() {} },
      { id: 'action-new-lead', label: 'New Lead', icon: '➕', group: 'Actions', keywords: 'create', run() {} },
    ],
    rerender() {},
  };
  globalThis._leads = [
    { id: 'a', firstName: 'A', stage: 'new' },
    { id: 'b', firstName: 'B', stage: 'install_in_progress' },
    { id: 'c', firstName: 'C', stage: 'closed' },
    { id: 'd', firstName: 'D', stage: 'inspected', deleted: true },
  ];
  X.compute('@may', ctx);
  ok('@ asks for people with the typed text', leadCalls[0].q === 'may' && leadCalls[0].pool === undefined);
  X.compute('# ', ctx);
  ok('# narrows to leads in job stages (not new, not deleted)', leadCalls[1].pool.map((l) => l.id).sort().join() === 'b,c', leadCalls[1].pool.map((l) => l.id).join());
  const act = X.compute('>', ctx);
  ok('> lists actions', act.length === 2 && act.every((a) => a.run));
  X.bump('action-new-lead'); X.bump('action-new-lead');
  const act2 = X.compute('>', ctx);
  ok('usage ranks the more-used action first', act2[0].id === 'action-new-lead', act2.map((a) => a.id).join());
  const mathRes = X.compute('= 32.4 sq x $485', ctx);
  ok('= returns one math row with the answer and a copy action', mathRes.length === 1 && mathRes[0].label === '$15,714' && mathRes[0].copyText === '$15,714' && typeof mathRes[0].run === 'function');
  const bad = X.compute('= 5 +', ctx);
  ok('a bad calculation is a calm error row, not a throw', bad.length === 1 && bad[0].error === true);
  ok('plain input is left to the classic list (null)', X.compute('maya', ctx) === null);
  ok('augment puts a math answer first for a clear calculation', X.augment([{ id: 'x' }], '32.4 sq x $485', ctx)[0].id === 'math:result');
  ok('augment leaves a phone number alone', X.augment([{ id: 'x' }], '513-555-0100', ctx).length === 1);

  globalThis.ThemeEngine = {
    getAll: () => ({ paper: { name: 'Paper', category: 'professional', mode: 'light' }, 'gold-rush': { name: 'Gold Rush', category: 'achievement', locked: true, unlockCondition: 'Close 10 deals' } }),
    getCurrent: () => 'paper', isUnlocked: (k) => k === 'paper', apply(k) { this.applied = k; },
  };
  const th = X.compute('t:', ctx);
  ok('t: lists themes, the current one first and tagged', th.length === 2 && th[0].themeKey === 'paper' && th[0].current === true);
  const locked = th.find((r) => r.themeKey === 'gold-rush');
  ok('a locked theme row is marked and its sublabel names the condition', locked.locked && /locked: Close 10 deals/.test(locked.sublabel));
  globalThis.ThemeEngine.applied = null;
  th[0].run();
  ok('applying calls ThemeEngine.apply with the key', globalThis.ThemeEngine.applied === 'paper');
  globalThis.ThemeEngine.applied = null;
  th.find((r) => r.themeKey === 'gold-rush').run();
  ok('running a LOCKED theme never applies it', globalThis.ThemeEngine.applied === null);

  // pinned lead actions: one lead, with and without a phone
  const ran = [];
  X.registerLeadAction({ id: 'x-note', label: 'Add a note', icon: '📝', keywords: 'write', run: (l) => ran.push(l.id) });
  globalThis.editLead = () => {}; globalThis.openTaskModal = () => {};
  const names = (r) => r.map((x) => x.label);
  X.onKey({ key: 'Tab', preventDefault() {} }, { results: [{ id: 'lead:b' }], index: 0, input: { value: 'x' }, rerender() {} });
  ok('Tab on a lead row pins it', X.contextLead() && X.contextLead().id === 'b');
  const la = X.compute('', ctx);
  ok('a pinned lead gets its own actions, including registered ones', la.length >= 3 && names(la).includes('Add a note') && /^Actions for/.test(la[0].group), names(la).join('|'));
  ok('lead actions that need a phone are hidden when there is none', !names(la).includes('Call'));
  la.find((r) => r.label === 'Add a note').run();
  ok('run(lead) gets the pinned lead', ran.join() === 'b');
  X.onKey({ key: 'Backspace', preventDefault() {} }, { results: [], index: 0, input: { value: '' }, rerender() {} });
  ok('Backspace on an empty box un-pins', X.contextLead() === null);
}

console.log('\nPALETTE 2.0 — wiring');
{
  const cp = read('docs/pro/js/command-palette.js');
  ok('the layer is injected on open (no boot script)', /_ensureScopes\(\);\s*const wrap = _buildModal\(\)/.test(cp) && /command-palette-scopes\.js\?v=\d+/.test(cp));
  ok('run() receives the pinned lead', /item\.run\(pinned \|\| undefined\)/.test(cp));
  ok('the classic list is the fallback when the layer fails', /catch \(e\) \{ console\.warn\('\[NBDCommand\] scopes failed/.test(cp));
  ok('usage boost feeds the classic ranking', /score: s \+ _usageBoost\(a\.id\)/.test(cp));
  ok('closing drops the theme preview', /_X\(\)\.onClose\(\)/.test(cp));
  const html = read('docs/pro/dashboard.html');
  ok('dashboard.html did not gain a script tag for it', !/command-palette-scopes/.test(html));
  const css = strip(read('docs/pro/css/command-palette-scopes.css'));
  ok('css: no hex literal', (css.match(/#[0-9a-f]{3,8}\b/gi) || []).length === 0);
  const used = [...new Set((css.match(/var\(\s*(--[a-z0-9-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')))];
  const defined = (n) => ['docs/pro/css/theme-system.css', 'docs/pro/css/dashboard-app.css'].some((f) => new RegExp(n.replace(/-/g, '\\-') + '\\s*:').test(read(f)));
  const undef = used.filter((t) => t !== '--cmdx-sw' && !defined(t));
  ok('css: every theme token it reads exists (' + used.length + ')', used.length >= 5 && undef.length === 0, undef.join(', '));
  const jsSrc = strip(read('docs/pro/js/command-palette-scopes.js'));
  ok('no style attributes and no inline handlers in the module', !/\bstyle\s*=\s*\\?["'`]/.test(jsSrc) && !/\son[a-z]+\s*=\s*["']/i.test(jsSrc));
}

console.log('\n' + (failed ? 'FAILED ' + failed : 'PASSED ' + passed) + ' (' + passed + ' ok)');
process.exit(failed ? 1 : 0);
