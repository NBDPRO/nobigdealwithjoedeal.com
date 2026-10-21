/**
 * tests/daily-success-default-theme-2026-10-21.test.js
 *
 * Daily Success boots into the legacy theme id "default" (app.js nbdBoot maps the CRM's nbd-original back to it),
 * but the colour tokens were only defined for "dark" / "nbd-original": under "default" --paper, --ink, --muted,
 * --tabbar, --stxt, --rule and --sbg were all empty, so paper cards were transparent and text was black on
 * near-black (217 of 249 text elements failed contrast on an iPhone-size page). This pins the fix and the colour
 * maths so it cannot drift back.
 *
 * Run: node tests/daily-success-default-theme-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const APP = fs.readFileSync(path.join(DIR, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// --- tiny colour maths (WCAG 2.x relative luminance) ---
function rgb(hex) { const h = hex.replace('#', ''); const f = h.length === 3 ? h.replace(/./g, (c) => c + c) : h; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); }
function lum(hex) { return rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0); }
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const AA = 4.5;

// --- pull the token blocks out of the stylesheet ---
const tokenBlock = (HTML.match(/\n(\[data-theme="dark"\][^{]*)\{([^}]*)\}/) || [])[0] || '';
const readVars = (css) => { const o = {}; css.replace(/(--[a-z-]+)\s*:\s*([^;}]+)/g, (_, k, v) => { o[k] = v.trim(); return ''; }); return o; };
const base = readVars(tokenBlock);
const defRule = (HTML.match(/\n\[data-theme="default"\]\{([^}]*)\}/) || [])[1] || '';
const def = readVars(defRule);

console.log('\n1. "default" is a real theme');
{
  ok('the main token block lists "default" in its selector', /\[data-theme="dark"\], \[data-theme="nbd-original"\], \[data-theme="default"\]\{/.test(HTML));
  ['--paper', '--ink', '--rule', '--tabbar', '--stxt', '--sbg', '--tt', '--tb', '--mbg', '--bg', '--bar'].forEach((v) => ok('token ' + v + ' is defined for the default theme', !!base[v], v));
  ok('control: the boot code really does land on "default"', /let saved = localStorage\.getItem\('nbd_pro_theme'\);\s*if \(saved === 'nbd-original'\) saved = 'default';/.test(APP));
}

console.log('\n2. the readability layer');
{
  ok('a default-theme override block exists', !!defRule);
  ok('muted text is >= 4.5:1 on the cream paper', ratio(def['--muted'] || '#000000', base['--paper']) >= AA, ratio(def['--muted'] || '#000000', base['--paper']).toFixed(2));
  ok('control: the old muted (#8a9ab0) was NOT', ratio('#8a9ab0', base['--paper']) < AA, ratio('#8a9ab0', base['--paper']).toFixed(2));
  ok('orange text on paper (--ac-ink) is >= 4.5:1', ratio(def['--ac-ink'] || '#000000', base['--paper']) >= AA, ratio(def['--ac-ink'] || '#000000', base['--paper']).toFixed(2));
  ok('control: the brand orange on paper was NOT', ratio('#BD5728', base['--paper']) < AA, ratio('#BD5728', base['--paper']).toFixed(2));
  ok('light-grey text on the dark page (--on-dark) is >= 4.5:1', ratio(def['--on-dark'] || '#000000', '#0A0C0F') >= AA);
  ok('orange on the dark page (--ac-on-dark) is >= 4.5:1', ratio(def['--ac-on-dark'] || '#000000', '#0A0C0F') >= AA);
  ok('...and on the dark intel cards (#0a1018)', ratio(def['--ac-on-dark'] || '#000000', '#0a1018') >= AA);
  ok('paper cards use the darker orange', /\[data-theme="default"\] \.pc\{--ac:var\(--ac-ink\);\}/.test(HTML));
  const badges = [...HTML.matchAll(/\[data-theme="default"\] \.b-([a-z, .\[\]="-]*?)\{background:(#[0-9a-f]{6});\}/g)];
  ok('the recoloured section badges carry white text at >= 4.5:1', badges.length >= 2 && badges.every((m) => ratio(m[2], '#ffffff') >= AA), badges.map((m) => m[2] + ' ' + ratio(m[2], '#ffffff').toFixed(1)).join(', '));
  ok('placeholders are readable on paper', ratio('#667080', base['--paper']) >= AA);
}

console.log('\n3. no dim-on-dark hard-codes left');
{
  const styles = (HTML.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n');
  ok('no `color:#445566` / `color:#556677` in the page CSS', !/color:\s*#(445566|556677)/i.test(styles));
  ok('none in app.js templates either (they sit on dark cards)', !/#(445566|556677)/i.test(APP));
  ok('control: those two greys really were unreadable on the dark card', ratio('#445566', '#0a1018') < 3 && ratio('#556677', '#0a1018') < 3.5);
  ok('the lifted grey is readable on the dark card', ratio('#8fa1b8', '#0a1018') >= AA);
  ok('the wordmark link no longer inherits the page ink', !/class="nbd-logo"[^>]*color:inherit/.test(HTML));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
