/**
 * touch-targets-2026-11-14.test.js — 44px tap targets on the customer page, readable phone nav labels.
 *
 * Wave-1 field #13 (Joe 2026-11-14): customer.html's coarse-pointer block set
 * 32-40px floors for the controls a rep hits over and over, and the phone
 * bottom-nav labels were 8.5px (badges 8px) in css/dashboard-app.css.
 *
 * Parses the real CSS (rule by rule, inside its media block) and checks every
 * listed control's floor is at least 44px, and the nav label at least 11px.
 * The jump-nav chips are deliberately left out (see the comment in
 * customer.html: the pinned 48px bar is what the scroll offsets use).
 *
 * Run: node tests/touch-targets-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
// The body of the first @media block whose prelude matches `re`.
function mediaBody(css, re) {
  const m = re.exec(css);
  if (!m) return '';
  let i = css.indexOf('{', m.index), depth = 0;
  for (let j = i; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') { depth--; if (depth === 0) return css.slice(i + 1, j); }
  }
  return '';
}
function rules(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')).filter((p) => p.length === 2)
    .map(([sel, decl]) => ({ sel: sel.trim(), decl }));
}
const px = (decl, prop) => { const m = new RegExp('(?:^|;|\\s)' + prop + '\\s*:\\s*([\\d.]+)px').exec(decl); return m ? Number(m[1]) : null; };

console.log('\ntouch-targets — 44px on the customer page, 11px phone nav labels\n');

const html = fs.readFileSync(path.join(ROOT, 'docs/pro/customer.html'), 'utf8');
const coarse = rules(mediaBody(html, /@media \(max-width:768px\) and \(pointer:coarse\)/));
ok('(the coarse-pointer block was found)', coarse.length > 5, coarse.length);
const want = ['.tl-pill', '.photo-filter-btn, #nbdPhotoSelectToggle', '.panel-head-actions .btn, .panel-head > .btn, #quickNoteSend',
  '[data-action="openNotesModal"]', '.nbd-photo-bulk-bar select, .nbd-photo-bulk-bar button', '.doc-actions .doc-btn, .doc-actions .btn',
  '.nbd-est-primary', '#emailUnsubMarkBtn', '.modal-header > button[data-action^="close"]'];
want.forEach((sel) => {
  const r = coarse.find((x) => x.sel === sel);
  const h = r ? px(r.decl, 'min-height') : null;
  ok(sel + ': at least 44px tall', h != null && h >= 44, String(h));
});
const close = coarse.find((x) => x.sel === '.modal-header > button[data-action^="close"]');
ok('modal close button: at least 44px wide too', close && px(close.decl, 'min-width') >= 44);

const app = fs.readFileSync(path.join(ROOT, 'docs/pro/css/dashboard-app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// The rule that sets the size (an earlier light-mode .mn-lbl rule only sets colour).
const lbl = [...app.matchAll(/\.mn-lbl\{([^}]*)\}/g)].find((m) => /font-size/.test(m[1]));
ok('phone nav labels are at least 11px', lbl && px(lbl[1], 'font-size') >= 11, lbl && lbl[1].slice(0, 40));
const badge = [...app.matchAll(/\.mn-badge\{([^}]*)\}/g)].find((m) => /font-size/.test(m[1]));
ok('phone nav badges are at least 10px', badge && px(badge[1], 'font-size') >= 10, badge && badge[1].slice(0, 60));

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
