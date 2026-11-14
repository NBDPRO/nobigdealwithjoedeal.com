/**
 * tests/src-kit-2026-11-14.test.js — behaviour of tests/lib/src-kit.js, the
 * shared helpers for suites that look at shipped files (fragile-test plan,
 * PR 0). Every helper is run on small inputs whose right answer is known,
 * including the inputs that broke the per-suite copies it replaces: a '}'
 * inside a string or regex, CRLF line ends, single-quoted or bare attribute
 * values, a selector repeated in a comma list, a rule inside @media.
 *
 * Zero deps. Run: node tests/src-kit-2026-11-14.test.js
 */
'use strict';
const K = require('./lib/src-kit');
const T = K.suite('SRC-KIT — the shared source helpers do what they say');
const { ok, section } = T;

section('read');
{
  const s = K.read('tests/lib/src-kit.js');
  ok('reads a repo file relative to the root', s.includes('module.exports'));
  ok('the text never carries a CR (CRLF and CR fold to LF)', !s.includes('\r') && K.lf('a\r\nb\rc') === 'a\nb\nc');
  let threw = null; try { K.read('no/such/file.js'); } catch (e) { threw = e.message; }
  ok('a missing file throws, naming it (a typo cannot read as empty and pass an absence check)', /no\/such\/file\.js/.test(threw || ''));
  ok('exists() answers without throwing', K.exists('CLAUDE.md') === true && K.exists('nope.nope') === false);
}

section('stripJsComments / stripCssComments');
{
  ok('the shared string-aware JS stripper is the one in tests/lib', K.stripJsComments === require('./lib/strip-js-comments').stripJsComments);
  ok('JS: comments go, a URL in a string stays', K.stripJsComments("a('https://x'); // bad()\n/* bad() */b();").replace(/\s+/g, '') === "a('https://x');b();");
  const css = '.a{color:red}/* .b{\ncolor:blue} */.c{x:1}';
  ok('CSS: comments go and line count is kept', K.stripCssComments(css) === '.a{color:red}\n.c{x:1}');
}

section('sliceFn');
{
  const src = [
    'function before() { return 1; }',
    'function target(a, b = {}) {',
    "  const s = '}'; const t = \"{\"; const u = `${a ? '}' : `${'{'}`}`;",
    '  const r = /[}]/g; // a } in a comment',
    '  /* and { here */',
    '  if (a) { return { b }; }',
    '  return s + t + u + r;',
    '}',
    'function after() {}',
  ].join('\n');
  const got = K.sliceFn(src, 'target');
  ok('slices from the declaration to its own closing brace', got && got.startsWith('function target(') && got.endsWith('return s + t + u + r;\n}'), got);
  ok('a } inside a string, template, regex or comment does not end it early', got && got.includes('if (a) { return { b }; }'));
  ok('the default parameter `= {}` is not taken for the body', got && got.includes("const s = '}'"));
  const crlf = src.replace(/\n/g, '\r\n');
  ok('a CRLF checkout slices to the same text (LF)', K.sliceFn(crlf, 'target') === got);
  ok('an unknown name is null, not the empty string', K.sliceFn(src, 'nope') === null);
  ok('a name that is only a prefix of another does not match it', K.sliceFn('function targetX() { return 1; }', 'target') === null);
  ok('window.x = async function', K.sliceFn('window.progressStage = async function (o) { if (o) { go(); } };\nnext();', 'progressStage') === 'window.progressStage = async function (o) { if (o) { go(); } }');
  ok('object property `name: function`', K.sliceFn('var o = { name: function (x) { return { x }; }, b: 1 };', 'name') === 'name: function (x) { return { x }; }');
  ok('const arrow with a block body', K.sliceFn('const go = async (a) => { return a; };', 'go') === 'go = async (a) => { return a; }');
  ok('a class/object method', K.sliceFn('class A {\n  render(x) {\n    return x;\n  }\n}', 'render') === 'render(x) {\n    return x;\n  }');
  ok('async function, and a regex after `return`', K.sliceFn('async function f() { return /}/.test(x); }', 'f') === 'async function f() { return /}/.test(x); }');
  ok('division is not mistaken for a regex', K.sliceFn('function d(a, b) { return a / b / 2; }', 'd') === 'function d(a, b) { return a / b / 2; }');
}

section('parseTags');
{
  const html = [
    '<!DOCTYPE html>',
    '<html><head>',
    '<script defer src="js/a.js?v=3"></script>',
    "<script>if (a < b) { document.write('<div id=\"fake\">'); }</script>",
    '<style>.x > .y { color: red }</style>',
    '</head><body>',
    '<!-- <div id="commented"></div> -->',
    "<div id=main class='wrap  outer' data-x=\"1 &amp; 2\" hidden>",
    '  <template id="tpl"><p class="in-tpl">Hi <b>there</b></p></template>',
    '  <ul><li class="mm-item" data-target="a">A<li class="mm-item" data-target="b">B</ul>',
    '  <input type="checkbox" id="chk"><label for="chk">L</label>',
    '  <img src=x.png alt="">',
    '  <p>stray close</span> still p</p>',
    '</div>',
    '</body></html>',
  ].join('\r\n');
  const d = K.parseTags(html);
  const main = d.byId('main');
  ok('double-, single-quoted and bare attribute values', main && main.attrs.id === 'main' && main.attrs.class === 'wrap  outer');
  ok('entities in values are decoded; a bare attribute is ""', main && main.attrs['data-x'] === '1 & 2' && main.attrs.hidden === '');
  ok('classes split on any whitespace', main && main.classes.join(',') === 'wrap,outer');
  ok('script bodies are not parsed as HTML (no element from document.write)', !d.byId('fake'));
  ok('comments are skipped', !d.byId('commented'));
  const scripts = d.$$('script');
  ok('script tags with src and their inline body', scripts.length === 2 && scripts[0].attrs.src === 'js/a.js?v=3' && /document\.write/.test(scripts[1].text));
  ok('line numbers are 1-based and survive CRLF', scripts[0].line === 3 && main.line === 8);
  ok('elements inside <template> are found', d.$('#tpl .in-tpl') && d.$('#tpl .in-tpl').text === 'Hi there');
  ok('descendant and child combinators', d.$$('#main li').length === 2 && d.$$('#main > ul > li').length === 2 && d.$$('#main > li').length === 0);
  ok('unclosed <li> tolerated: both items, in order', d.$$('li.mm-item').map((e) => e.attrs['data-target']).join() === 'a,b');
  ok('attribute operators = ^= *= $= ~=', d.$$('[data-target="b"]').length === 1 && d.$$('script[src^="js/"]').length === 1
    && d.$$('script[src*="a.js"]').length === 1 && d.$$('script[src$="v=3"]').length === 1 && d.$$('[class~=outer]').length === 1);
  ok('comma lists', d.$$('input, label').length === 2);
  ok('void elements do not swallow their siblings', d.byId('chk').children.length === 0 && d.$('label[for=chk]').parent === main);
  ok('a stray end tag does not close the wrong element', d.$$('#main p').some((p) => p.text === 'stray close still p'));
  ok('document order by .start', d.byId('tpl').start < d.byId('chk').start);
  ok('contains()', main.contains(d.byId('chk')) && !d.byId('chk').contains(main));
  ok('an empty result is [] / null, never a throw', d.$$('.nope').length === 0 && d.$('.nope') === null);
  let bad = null; try { d.$$(''); } catch (e) { bad = e.message; }
  ok('an unparseable selector throws (a typo cannot silently match nothing)', /cannot parse selector/.test(bad || ''));
}

section('cssRules / cssRule');
{
  const css = [
    '/* .a { display: none } */',
    '.a, .b > .c { display: block; color: var(--x, #fff) }',
    '.a { min-height: 44px }',
    '@media (max-width: 768px) {',
    '  .a { display: none; }',
    '  .d{content:"};{"}',
    '}',
    '@keyframes k { from { opacity: 0 } }',
    '@supports (display:grid) { .g { display: grid } }',
  ].join('\n');
  const a = K.cssRule(css, '.a');
  ok('declarations merge over every top-level rule listing the selector', a && a.display === 'block' && a['min-height'] === '44px' && a.color === 'var(--x, #fff)', JSON.stringify(a));
  ok('a commented-out rule is not a rule', K.cssRules(css).every((r) => r.line !== 1));
  ok('selector whitespace is normalised (`.b>.c` finds `.b > .c`)', K.cssRule(css, '.b>.c') && K.cssRule(css, '.b>.c').display === 'block');
  ok('top level only by default: the phone rule does not leak in', a.display === 'block');
  const ph = K.cssRule(css, '.a', { media: '(max-width:768px)' });
  ok('{ media } selects the rule inside that @media, whitespace-insensitive', ph && ph.display === 'none');
  ok('a ; or } inside a string value does not split it', K.cssRule(css, '.d', { media: 'max-width' }).content === '"};{"');
  ok('@supports is walked, @keyframes is not a rule', K.cssRule(css, '.g') && K.cssRule(css, '.g').display === 'grid' && K.cssRule(css, 'from', { media: '*' }) === null);
  ok('no match is null (so .prop throws on a typo)', K.cssRule(css, '.zzz') === null);
}

section('esmImports');
{
  const im = K.esmImports([
    '// import { fake } from "./nope.js";',
    'import { commitStageChange as _commit, stageMoveNeedsConfirm } from "./stage-write.js";',
    "import Def, * as NS from './a.js';",
    'import {',
    '  x,',
    '  y as z',
    '} from "./multi.js"',
  ].join('\n'));
  ok('named, renamed, default, namespace and multi-line imports; comments ignored',
    im.length === 3 && im[0].from === './stage-write.js' && im[0].names._commit === 'commitStageChange' && im[0].names.stageMoveNeedsConfirm === 'stageMoveNeedsConfirm'
      && im[1].default === 'Def' && im[1].namespace === 'NS' && im[2].names.x === 'x' && im[2].names.z === 'y', JSON.stringify(im));
}

section('loadInVm / fakeClock / spy');
{
  const ctx = K.loadInVm('x.js', {}, { src: { 'x.js': 'function add(a,b){return a+b}\nconst K2 = 7;\nwindow.Y = add(K2, 1);' }, expose: ['K2'] });
  ok('top-level functions land on the context; window defaults to it', typeof ctx.add === 'function' && ctx.add(2, 3) === 5 && ctx.Y === 8);
  ok('expose copies a const out', ctx.__exposed.K2 === 7);
  const esm = K.loadInVm('m.js', {}, { esm: true, src: { 'm.js': 'import { a } from "./a.js";\nexport function f() { return 2; }\nexport const g = 3;' }, expose: ['g'] });
  ok('esm: import lines go, export keywords go', esm.f() === 2 && esm.__exposed.g === 3);
  const dom = K.loadInVm('d.js', {}, { dom: true, src: { 'd.js': 'document.body.innerHTML = \'<button class="go" data-n="1">Go</button>\'; document.addEventListener("click", function (e) { var b = e.target.closest(".go"); if (b) b.textContent = "Gone"; });' } });
  const btn = dom.document.querySelector('.go');
  K.click(dom.__dom, btn);
  ok('dom: the shared fake DOM from nbd-os-home-harness, with delegated clicks', btn && btn.textContent === 'Gone');
  const real = K.loadInVm('tests/lib/strip-js-comments.js', { module: { exports: {} } });
  ok('a real repo file loads by path', typeof real.module.exports.stripJsComments === 'function');
  let err = null; try { K.loadInVm('e.js', {}, { src: { 'e.js': 'throw new Error("boom")' } }); } catch (e) { err = e.message; }
  ok('a script that throws surfaces the error', err === 'boom');

  const c = K.fakeClock(Date.UTC(2026, 10, 14, 12));
  const seen = [];
  c.setTimeout(() => seen.push('t500'), 500);
  const iv = c.setInterval(() => seen.push('iv'), 300);
  ok('the frozen Date', new c.Date().getTime() === Date.UTC(2026, 10, 14, 12) && c.Date.now() === Date.UTC(2026, 10, 14, 12) && new c.Date(0).getTime() === 0);
  c.tick(700);
  ok('timers fire in time order on tick()', seen.join() === 'iv,t500,iv', seen.join());
  c.clearInterval(iv); c.tick(1000);
  ok('cleared timers stay quiet; the clock moved', seen.length === 3 && c.now() === Date.UTC(2026, 10, 14, 12) + 1700);
  const s = K.spy((x) => x * 2);
  ok('spy records calls and returns impl', s(2) === 4 && s.calls.length === 1 && s.calls[0][0] === 2);
}

section('suite()');
{
  const { execFileSync } = require('child_process');
  const code = "const T=require(" + JSON.stringify(require.resolve('./lib/src-kit')) + ").suite('x');T.ok('a',true);T.ok('b',false,'why');T.done();";
  let out = '', status = 0;
  try { out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }); } catch (e) { out = e.stdout; status = e.status; }
  ok('a failing check exits non-zero and names it', status === 1 && /✗ b\n {6}why/.test(out) && /1 passed, 1 failed/.test(out), out);
}

T.done();
