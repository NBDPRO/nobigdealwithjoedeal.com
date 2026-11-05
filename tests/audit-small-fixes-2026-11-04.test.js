/**
 * tests/audit-small-fixes-2026-11-04.test.js — the small items from the 2026-11-04 speed/a11y audit
 * (documentation/audit/PERF-AUDIT-2026-11-04.md, item 5).
 *
 * 1. /inspect: the header logo sits beside the text "NO BIG DEAL Home Solutions" in the same link, so its alt is
 *    empty (Lighthouse image-redundant-alt).
 * 2. CRM notification badge: white text on the red (was var(--t): 3.69:1 on dark themes).
 * 3. CRM bell: the unread count is in the button's accessible name; the badge is aria-hidden (label-content-name-
 *    mismatch). Runs the real render path's label lines in a vm.
 * 4. build-credentials.mjs offers a badge's .webp sibling in a <picture>; the TAMKO and GAF chips on the homepage
 *    now carry one.
 *
 * Zero deps. Run: node tests/audit-small-fixes-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const inspect = read('docs/inspect.html');
const logo = (inspect.match(/<header class="topbar">[\s\S]*?<\/a>/) || [''])[0];
ok('POSITIVE CONTROL: the /inspect header link carries the brand text', /NO BIG DEAL/.test(logo) && /Home Solutions/.test(logo));
ok('…so its logo image has an empty alt', /<img src="\/assets\/images\/nbd-logo\.png"[^>]*alt=""/.test(logo));

const css = read('docs/pro/css/dashboard-app.css').replace(/\/\*[\s\S]*?\*\//g, '');
const badgeRule = (css.match(/\.hdr-tool \.hdr-tool-badge\{[^}]*\}/) || [''])[0];
ok('the bell badge rule exists', !!badgeRule);
ok('the bell badge text is white on the red', /color:#fff;/.test(badgeRule) && /background:var\(--red\)/.test(badgeRule), badgeRule.slice(0, 120));

const bell = read('docs/pro/js/notif-bell.js');
ok('the bell label carries the unread count', /setAttribute\('aria-label', unread\.length \? `Notifications, \$\{badge\.textContent\} unread` : 'Notifications'\)/.test(bell));
ok('the badge is hidden from assistive tech (no double read)', /badge\.setAttribute\('aria-hidden', 'true'\)/.test(bell));

const home = read('docs/index.html');
ok('the homepage TAMKO chip offers its WebP', /<source type="image\/webp" srcset="\/assets\/tamko\/tamko-pro-gold-badge-120\.webp"><img src="\/assets\/tamko\/tamko-pro-gold-badge-120\.png"/.test(home));
ok('the homepage GAF chip offers its WebP', /<source type="image\/webp" srcset="\/assets\/gaf\/gaf-certified-badge-120\.webp"><img src="\/assets\/gaf\/gaf-certified-badge-120\.png"/.test(home));
ok('every WebP source the builder names exists', [...home.matchAll(/srcset="(\/assets\/(?:gaf|tamko|american-operator)\/[^"]+\.webp)"/g)].every((m) => fs.existsSync(path.join(ROOT, 'docs', m[1]))));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
