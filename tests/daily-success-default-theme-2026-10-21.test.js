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
  ['--tabbar', '--tt', '--tb', '--bg', '--bar'].forEach((v) => ok('token ' + v + ' is defined for the default theme', !!base[v], v));
  ['--paper', '--ink', '--rule', '--muted', '--mbg', '--sbg', '--stxt'].forEach((v) => ok('the dark card skin defines ' + v, !!def[v], v));
  ok('control: the boot code really does land on "default"', /let saved = localStorage\.getItem\('nbd_pro_theme'\);\s*if \(saved === 'nbd-original'\) saved = 'default';/.test(APP));
}

console.log('\n2. the dark card skin (the CRM look) and its readability');
{
  const paper = def['--paper'] || '#ffffff';
  ok('a default-theme override block exists', !!defRule);
  ok('cards are a dark surface like the CRM (#12161c, close to its --s #111418)', /^#1[0-3][0-9a-f]{2}[0-9a-f]{2}$/i.test(paper) && lum(paper) < 0.02, paper);
  ok('ink on the card is >= 7:1', ratio(def['--ink'] || '#000000', paper) >= 7, ratio(def['--ink'] || '#000000', paper).toFixed(1));
  ok('muted text on the card is >= 4.5:1', ratio(def['--muted'] || '#000000', paper) >= AA, ratio(def['--muted'] || '#000000', paper).toFixed(2));
  ok('control: the old cream-era muted (#566070) was NOT readable on the dark card', ratio('#566070', paper) < AA, ratio('#566070', paper).toFixed(2));
  ok('orange TEXT (--ac-text) on the card is >= 4.5:1', ratio(def['--ac-text'] || '#000000', paper) >= AA, ratio(def['--ac-text'] || '#000000', paper).toFixed(2));
  ok('control: the brand orange as small text on the card was NOT (that is why --ac-text exists)', ratio('#BD5728', paper) < AA, ratio('#BD5728', paper).toFixed(2));
  ok('white text on the brand-orange fill (buttons) is >= 4.5:1', ratio('#ffffff', '#BD5728') >= AA, ratio('#ffffff', '#BD5728').toFixed(2));
  ok('control: white on the LIGHT text orange would not be (so fills must keep the brand colour)', ratio('#ffffff', def['--ac-text'] || '#000000') < AA);
  ok('light-grey text on the dark page (--on-dark) is >= 4.5:1', ratio(def['--on-dark'] || '#000000', '#0A0C0F') >= AA);
  ok('orange on the dark page (--ac-on-dark) is >= 4.5:1, also on the dark intel cards (#0a1018)', ratio(def['--ac-on-dark'] || '#000000', '#0A0C0F') >= AA && ratio(def['--ac-on-dark'] || '#000000', '#0a1018') >= AA);
  ok('orange text is token-driven in the page, app.js and the card css (no bare color:var(--ac) left)', !/(?<![-\w])color:\s*var\(--ac(?:, #BD5728)?\)/.test(HTML.replace(/<style id="ds-theme-system">[\s\S]*?<\/style>/, '')) && !/(?<![-\w])color:var\(--ac\)/.test(APP));
  const allCss = [HTML, APP, ...['export', 'money', 'review', 'workout-coach'].map((n) => fs.readFileSync(path.join(DIR, 'css', n + '.css'), 'utf8'))].join('\n');
  ok('--ac-text is only ever used as a text colour, never a fill or border (white button text needs the brand orange)', !/(?:background(?:-color)?|border(?:-[a-z]+)?-color|border|fill|stroke):\s*var\(--ac-text/.test(allCss));
  ok('control: fills still use the brand orange', /background:\s*var\(--ac(?:,\s*#BD5728)?\)/.test(allCss));
  const badges = [...HTML.matchAll(/\[data-theme="default"\] \.b-([a-z, .\[\]="-]*?)\{background:(#[0-9a-f]{6});\}/g)];
  ok('the recoloured section badges carry white text at >= 4.5:1', badges.length >= 2 && badges.every((m) => ratio(m[2], '#ffffff') >= AA), badges.map((m) => m[2] + ' ' + ratio(m[2], '#ffffff').toFixed(1)).join(', '));
  ok('placeholders are readable on the card (>= 4.5:1)', ratio('#8793a4', paper) >= AA, ratio('#8793a4', paper).toFixed(2));
  ok('ghost buttons are light text on the dark card (>= 4.5:1)', /\[data-theme="default"\] \.btn-ghost\{color:#c3cfdf;\}/.test(HTML) && ratio('#c3cfdf', paper) >= AA);
  ok('inputs get dark backgrounds and the dark colour scheme (no white boxes)', /\.fl-in,\[data-theme="default"\] \.sinp,\[data-theme="default"\] \.minp\{background:#0d1015;/.test(HTML) && /color-scheme:dark;/.test(HTML));
  ok('the old cream-card rules are gone (.pc darker orange, ghost-on-cream)', !/\.pc\{--ac:var\(--ac-ink\);\}/.test(HTML) && !/--ac-ink/.test(HTML));
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
