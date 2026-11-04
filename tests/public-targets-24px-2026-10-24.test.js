/**
 * tests/public-targets-24px-2026-10-24.test.js — public-page target floors
 * from the 2026-10-24 sweep (WCAG 2.5.8, 24px): the tool pages' nav home
 * link (19–21px), the compact desktop nav links in the 1025–1440 range
 * (22px), the our-work crumb and back links (15px, 19px) and the blog
 * sidebar links (16px). Run: node tests/public-targets-24px-2026-10-24.test.js
 */
'use strict';
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(n, c, d) { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; fails.push(n); console.log('  ✗ ' + n + (d ? '\n      ' + String(d).slice(0, 600) : '')); } }
const PAGES = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!(d === path.join(ROOT, 'docs') && ['pro', 'sites', 'admin', 'dev', 'assets'].includes(e.name))) walk(p); } else if (e.name.endsWith('.html')) PAGES.push(p); } })(path.join(ROOT, 'docs'));
const read = (f) => fs.readFileSync(f, 'utf8');
const tool = PAGES.filter((f) => /\.tool-nav-home\{/.test(read(f)));
ok('every page with the tool nav floors its home link at 24px (' + tool.length + ' pages)', tool.length >= 16 && tool.every((f) => /\.tool-nav-home\{[^}]*min-height:24px/.test(read(f))), tool.filter((f) => !/\.tool-nav-home\{[^}]*min-height:24px/.test(read(f))).map((f) => path.relative(ROOT, f)).join(', '));
const compact = PAGES.filter((f) => /\.nav-links > li > a\{font-size:\.7rem!important/.test(read(f)));
ok('no page keeps the 22px compact nav link (padding:4px)', compact.every((f) => !/\.nav-links > li > a\{font-size:\.7rem!important;letter-spacing:\.05em!important;padding:4px 0!important\}/.test(read(f))));
ok('nbd-nav-responsive.css: compact nav links padded to 24px', /nav \.nav-links > li > a\{font-size:\.7rem!important;letter-spacing:\.05em!important;padding:5px 0!important\}/.test(read(path.join(ROOT, 'docs/assets/css/nbd-nav-responsive.css'))));
const tpl = read(path.join(ROOT, 'scripts/build-projects.mjs'));
ok('our-work template: crumb and back links carry vertical padding', /\.pd-crumb a\{[^}]*display:inline-block;padding:5px 0;/.test(tpl) && /\.pd-back\{[^}]*padding:4px 0;/.test(tpl));
const blog = PAGES.filter((f) => /\/blog\/[a-z0-9-]+\.html$/.test(f) && /\.sidebar-links li a/.test(read(f)));
ok('every blog page pads its sidebar links (' + blog.length + ' pages)', blog.length >= 20 && blog.every((f) => /\.sidebar-links li a\s*\{[^}]*padding:\s*4px 0/.test(read(f))), blog.filter((f) => !/\.sidebar-links li a\s*\{[^}]*padding:\s*4px 0/.test(read(f))).map((f) => path.relative(ROOT, f)).join(', '));
console.log('\n' + passed + ' passed, ' + failed + ' failed'); if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
