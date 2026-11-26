/**
 * ios-user-select-2026-11-25.test.js — long-press must not select text on older iOS.
 *
 * Safari before 18 reads only -webkit-user-select. Nineteen stylesheet rules,
 * seven inline <style> blocks and five JS-built style strings shipped a bare
 * `user-select: none`, so on Joe's iPhone a long-press on a nav item, a list
 * header, an OS bar button or a photo still selected text. The kanban card,
 * the main long-press target (kanban-context-menu.js, 500 ms), had no rule at
 * all, so the same press also raised the Copy / Look Up callout.
 *
 * Run: node tests/ios-user-select-2026-11-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const K = require('./lib/src-kit');
const t = K.suite();

const ROOT = K.ROOT;
const walk = (dir, ext, out) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/vendor|node_modules/.test(e.name)) walk(p, ext, out); } else if (ext.test(e.name) && !/\.min\./.test(e.name)) out.push(p);
  }
  return out;
};
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

t.section('every stylesheet rule that turns selection off also says so to older Safari');
const css = walk(path.join(ROOT, 'docs'), /\.css$/, []);
const bareRules = [];
let noneRules = 0;
for (const f of css) {
  for (const r of K.cssRules(K.read(f))) {
    if (!/none/.test(r.decls['user-select'] || '')) continue;
    noneRules++;
    if (!/none/.test(r.decls['-webkit-user-select'] || '')) bareRules.push(rel(f) + ':' + r.line + ' ' + r.selectors.join(',').slice(0, 50));
  }
}
t.ok('control: the scan finds the rules it checks (' + noneRules + ')', noneRules > 20);
t.ok('no rule ships a bare user-select:none', bareRules.length === 0, bareRules.join('\n      '));
const probe = K.cssRules('.a { user-select: none; } .b { -webkit-user-select: none; user-select: none; }');
t.ok('control: a bare rule is told apart from a prefixed one', !probe[0].decls['-webkit-user-select'] && probe[1].decls['-webkit-user-select'] === 'none');

t.section('inline <style> blocks and JS-built style strings');
const BARE = /(^|[^-\w])user-select:\s*none/;
const files = walk(path.join(ROOT, 'docs'), /\.(html|js)$/, []);
const bareLines = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!BARE.test(line)) return;
    const near = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
    if (!/-webkit-user-select/.test(near)) bareLines.push(rel(f) + ':' + (i + 1));
  });
}
t.ok('no inline style or JS style string ships a bare user-select:none', bareLines.length === 0, bareLines.join(', '));

t.section('the kanban card long-press on touch');
const polish = K.cssRules(K.read('docs/pro/css/mobile-polish.css'));
const card = K.cssRule(polish, '.k-card', { media: '(pointer: coarse)' });
t.ok('a kanban card turns off selection and the callout on touch screens', !!card && card['-webkit-touch-callout'] === 'none' && card['-webkit-user-select'] === 'none' && card['user-select'] === 'none', JSON.stringify(card));
t.ok('…and only on touch (desktop can still select card text)', K.cssRule(polish, '.k-card') === null);
const field = K.cssRule(polish, 'textarea', { media: '(pointer: coarse)' });
t.ok('text fields stay selectable inside a no-select container', !!field && field['-webkit-user-select'] === 'text' && field['user-select'] === 'text');

t.done();
