/**
 * tests/visit-recorder-home-clearance-2026-10-21.test.js
 *
 * On a phone, Home's last card ("More on Home") sat UNDER the fixed Record visit bar and could not be
 * tapped (caught by tests/e2e/phone-home-nav.spec.js + phone-no-next-step.spec.js, which had not run to
 * completion in CI before the shard split). Cause: dashboard-app.css forces
 *   .view-scroll { padding-bottom: calc(80px + safe-area) !important }   (max-width:768px)
 * which beat visit-recorder.css's plain `html.nbd-vr-bar-on #view-home .view-scroll { padding-bottom: 74px }`,
 * so Home reserved room for the nav only. The old unit test only checked that the rule's TEXT existed, which
 * is true while the bug is live. This one models the cascade for the two competing declarations.
 *
 * Run: node tests/visit-recorder-home-clearance-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { decls }` with the @media condition it sits in ('' = unconditional). Flat, one level of @media. */
function rules(css) {
  const out = [];
  const src = strip(css);
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    if (head.startsWith('@media')) {
      let depth = 1, j = open + 1;
      while (j < src.length && depth > 0) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      const inner = src.slice(open + 1, j - 1);
      for (const r of rules(inner)) out.push(Object.assign({}, r, { media: head.replace(/\s+/g, '') }));
      i = j;
    } else if (head.startsWith('@')) {            // @font-face / @keyframes: skip the block
      let depth = 1, j = open + 1;
      while (j < src.length && depth > 0) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      i = j;
    } else {
      const close = src.indexOf('}', open);
      out.push({ selector: head.replace(/\s+/g, ' '), body: src.slice(open + 1, close), media: '' });
      i = close + 1;
    }
  }
  return out;
}
/** (ids, classes+attrs+pseudo-classes, elements) for a simple descendant selector. */
function specificity(sel) {
  const s = sel.replace(/:not\(([^)]*)\)/g, ' $1 ');
  return [(s.match(/#[\w-]+/g) || []).length, (s.match(/\.[\w-]+|\[[^\]]+\]/g) || []).length, (s.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length];
}
const cmp = (a, b) => { for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] - b[k]; return 0; };
const padBottom = (r) => { const m = /padding-bottom\s*:\s*([^;]+?)(\s*!important)?\s*(;|$)/.exec(r.body); return m ? { value: m[1].trim(), important: !!m[2] } : null; };
/** px total of calc(80px + 74px + env(...)) style values. */
const pxSum = (v) => (v.match(/(\d+)px/g) || []).reduce((n, x) => n + parseInt(x, 10), 0);

/**
 * Who wins `padding-bottom` for #view-home .view-scroll at a 390px-wide phone, with the Record visit bar on?
 * Both !important => higher specificity wins; one !important => it wins; none => specificity.
 */
function winner(candidates) {
  const live = candidates.map((r) => Object.assign({ pb: padBottom(r), spec: specificity(r.selector) }, r)).filter((r) => r.pb);
  live.sort((a, b) => (Number(a.pb.important) - Number(b.pb.important)) || cmp(a.spec, b.spec));
  return live[live.length - 1];
}

const vr = read('docs/pro/css/visit-recorder.css');
const dash = read('docs/pro/css/dashboard-app.css');
const PHONE = (m) => /max-width:768px/.test(m);

// What applies to #view-home .view-scroll on a phone with the bar on:
const applies = (r) => /(^|[\s,])\.view-scroll$/.test(r.selector) || /^html\.nbd-vr-bar-on #view-home \.view-scroll$/.test(r.selector);
const competing = (css, onlyPhoneOrBase) => rules(css).filter((r) => applies(r) && (r.media === '' || PHONE(r.media)) && onlyPhoneOrBase(r));

console.log('\n1. the competing rules exist (why the old rule lost)');
const generic = rules(dash).filter((r) => PHONE(r.media) && /^\.view-scroll$/.test(r.selector) && padBottom(r));
ok('dashboard-app.css still forces .view-scroll padding-bottom with !important on phones (the nav room)',
  generic.length >= 1 && generic.some((r) => padBottom(r).important && pxSum(padBottom(r).value) === 80), JSON.stringify(generic.map((r) => padBottom(r))));

console.log('\n2. the old state loses; the fixed state wins');
const nowRules = competing(vr, () => true).concat(generic);
const win = winner(nowRules);
ok('with the fix, the winning declaration is the recorder\'s own Home rule', win && /nbd-vr-bar-on #view-home \.view-scroll/.test(win.selector), win && win.selector);
ok('...and it is !important, so it beats the generic nav-room rule', win && win.pb.important);
ok('...and it reserves the nav\'s 80px PLUS the bar\'s 74px (154px + safe-area), not just the nav', win && pxSum(win.pb.value) >= 154 && /safe-area-inset-bottom/.test(win.pb.value), win && win.pb.value);

// Negative control: reconstruct the pre-fix stylesheet (the phone-only !important block removed) and show the bug.
const preFix = vr.replace(/\/\* Phone \(2026-10-21\)[\s\S]*?\*\/\n@media \(max-width:768px\)\{\n[\s\S]*?\n\}\n/, '');
ok('(control) the pre-fix stylesheet really is different from the fixed one: it has no phone-only Home rule',
  preFix !== vr && !rules(preFix).some((r) => PHONE(r.media) && /nbd-vr-bar-on #view-home \.view-scroll/.test(r.selector)));
const oldWin = winner(competing(preFix, () => true).concat(generic));
ok('(control) BEFORE the fix the generic !important rule won: Home reserved only the nav\'s 80px, so the last card sat under the bar',
  oldWin && /^\.view-scroll$/.test(oldWin.selector) && pxSum(oldWin.pb.value) === 80, oldWin && oldWin.selector + ' ' + oldWin.pb.value);

console.log('\n3. scope: phone only, only while the bar is on, other widths and layouts untouched');
const phoneRule = rules(vr).filter((r) => PHONE(r.media) && /nbd-vr-bar-on #view-home \.view-scroll/.test(r.selector));
ok('the new rule lives only inside @media (max-width:768px)', phoneRule.length === 1);
ok('it is keyed on html.nbd-vr-bar-on, which the launcher toggles only while the bar shows',
  /classList\.toggle\('nbd-vr-bar-on', show\)/.test(read('docs/pro/js/visit-recorder-launcher.js')));
ok('the desktop rule (min-width:769px, 96px) and the base rule are unchanged',
  /min-width:769px\)\{[\s\S]*?html\.nbd-vr-bar-on #view-home \.view-scroll\{ padding-bottom:96px; \}/.test(vr) && /html\.nbd-vr-bar-on #view-home \.view-scroll\{ padding-bottom:calc\(74px \+ env\(safe-area-inset-bottom, 0px\)\); \}/.test(vr));

console.log('\n4. phones refetch the stylesheet');
const launcher = read('docs/pro/js/visit-recorder-launcher.js');
ok('the launcher asks for visit-recorder.css?v=4 in both places', (launcher.match(/visit-recorder\.css\?v=4/g) || []).length === 2 && !/visit-recorder\.css\?v=3/.test(launcher));
ok('dashboard.html and customer.html load the bumped launcher (?v=3)', /visit-recorder-launcher\.js\?v=3/.test(read('docs/pro/dashboard.html')) && /visit-recorder-launcher\.js\?v=3/.test(read('docs/pro/customer.html')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
