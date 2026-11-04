/**
 * tests/daily-success-theme-sweep-2026-10-22.test.js
 *
 * The all-theme sweep (ten skins x 360/390/412 px, every text node measured against what is really behind it) found
 * text that kept one hard-coded colour while the surface or the skin changed: ghost buttons on the dashboard hero band
 * and the Workout Coach / Money / Review overlays (dark in every skin) used Light's dark ink (1.4:1), the tab x and
 * DASH label, week-glance letters, row numbers, weight deltas, the delete x, orange date rows. This pins the fixes
 * with real WCAG maths over the skin tokens, plus the rules and the inline colours that were changed.
 * Findings note: documentation/qa/daily-success-theme-sweep-2026-10-22.md
 *
 * Run: node tests/daily-success-theme-sweep-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
// Pins read the source with comments removed: a commented-out line must not satisfy a pin.
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const read = (p) => stripComments(fs.readFileSync(path.join(DIR, p), 'utf8').replace(/\r\n/g, '\n'));
const HTML = read('index.html'), APP = read('js/app.js'), SYNC = read('ds-firebase-sync.js');
const LAST_STYLE = HTML.split('<style').pop();   // the phone layers live in the LAST <style> block

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const parse = (hex) => { const h = hex.replace('#', ''); const f = h.length === 3 ? h.replace(/./g, (c) => c + c) : h; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
const lum = (hex) => parse(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const readVars = (css) => { const o = {}; css.replace(/(--[a-z-]+)\s*:\s*([^;}]+)/g, (_, k, v) => { o[k] = v.trim(); return ''; }); return o; };

const skins = {};
const baseRow = (HTML.match(/\n\[data-theme="dark"\][^{]*\{([^}]*)\}/) || [])[1] || '';
skins.default = Object.assign({}, readVars(baseRow), readVars((HTML.match(/\n\[data-theme="default"\]\{([^}]*)\}/) || [])[1] || ''));
for (const m of HTML.matchAll(/\n:root\[data-theme="([a-z-]+)"\]\{([^}]*)\}/g)) skins[m[1]] = readVars(m[2]);
const IDS = Object.keys(skins);

console.log('\n1. the maths');
{
  ok('control: Light\'s ghost ink on the dark hero band is the miss that was reported (1.4:1 as rendered over the band tint, under 2 plain)', ratio('#3a4659', '#12223D') < 2);
  ok('control: its on-dark ink clears 4.5:1 on the same band', ratio('#c3cfdf', '#12223D') >= 4.5);
  ok('all ten skins are read', IDS.length === 10, IDS.join(','));
}

console.log('\n2. fixed-dark surfaces: on-dark ink, per skin');
{
  // surfaces that stay dark in every skin (workout-coach.css .wc-ov, the week-glance panel's inline background) or follow --bar
  const WC = fs.readFileSync(path.join(DIR, 'css', 'workout-coach.css'), 'utf8');
  const overlay = ((WC.match(/\.wc-ov\s*\{[^}]*?background:\s*(#[0-9a-fA-F]{3,6})/) || [])[1]) || '';
  const glance = ((APP.match(/id="week-glance-wrap" style="background:(#[0-9a-fA-F]{3,6})/) || [])[1]) || '';
  ok('the overlay and week-glance surfaces are read from source', /^#/.test(overlay) && /^#/.test(glance), overlay + ' ' + glance);
  IDS.forEach((id) => {
    const s = skins[id];
    const surfaces = { 'overlay': overlay, 'week-glance': glance, '--bar (hero band)': s['--bar'] };
    Object.keys(surfaces).forEach((name) => {
      const bg = surfaces[name];
      if (!/^#/.test(bg || '')) { ok(id + ': ' + name + ' surface is a plain hex', false, String(bg)); return; }
      ok(id + ': --on-dark on ' + name + ' >= 4.5:1', ratio(s['--on-dark'] || '#c3cfdf', bg) >= 4.5, ratio(s['--on-dark'] || '#c3cfdf', bg).toFixed(2));
      ok(id + ': --ac-on-dark on ' + name + ' >= 4.5:1', ratio(s['--ac-on-dark'] || '#E4783F', bg) >= 4.5, ratio(s['--ac-on-dark'] || '#E4783F', bg).toFixed(2));
    });
  });
}

console.log('\n3. paper surfaces: muted, accent text and green, per skin');
{
  IDS.forEach((id) => {
    const s = skins[id], paper = s['--paper'];
    ok(id + ': --muted on --paper >= 4.5:1 (row numbers, delete x, captions)', ratio(s['--muted'], paper) >= 4.5, ratio(s['--muted'], paper).toFixed(2));
    ok(id + ': --ac-text on --paper >= 4.5:1 (date rows, floors met, weight rise)', ratio(s['--ac-text'] || s['--ac'], paper) >= 4.5, ratio(s['--ac-text'] || s['--ac'], paper).toFixed(2));
    if (s['--grn']) ok(id + ': --grn on --paper >= 4.5:1 (weight fall)', ratio(s['--grn'], paper) >= 4.5, ratio(s['--grn'], paper).toFixed(2));
  });
  ok('the default skin has no --grn, so the weight-fall rule falls back to a green that clears the dark paper', ratio('#16a34a', skins.default['--paper']) >= 4.5, ratio('#16a34a', skins.default['--paper']).toFixed(2));
}

console.log('\n4. the rules, in the last <style> block');
{
  const rule = (re, label) => ok(label, re.test(LAST_STYLE));
  rule(/:root \.dhero \.btn-ghost,:root \.wc-ov \.btn-ghost\{color:var\(--on-dark,#c3cfdf\);\}/, 'ghost buttons on the hero band and the coach overlays take the on-dark ink');
  rule(/:root \.dhero \.btn-gold\{color:var\(--ac-on-dark,var\(--gold\)\);\}/, 'the PDF button on the hero band takes the on-dark accent');
  rule(/:root \.prd-d\{color:var\(--ac-text,var\(--gold\)\);\}/, 'program-dashboard date rows use the accent text token');
  rule(/:root \.tab \.tx\{color:var\(--on-dark,#a9b8cc\);\}/, 'the tab x is on-dark on a dark tab');
  rule(/:root \.tab\.active:not\(\.dtab\) \.tx\{color:var\(--muted\);\}/, 'the tab x on a light active tab is muted ink');
  rule(/:root \.dtab \.tlbl\{color:var\(--ac-on-dark\);\}/, 'the DASH tab label sits on the dark bar');
  rule(/:root \.ex-del\{color:var\(--muted\);\}/, 'the exercise delete x is muted ink, not #bbb');
  rule(/:root \.ex-del:hover\{color:#c04040;\}/, 'the delete x still turns red on hover');
  rule(/:root \.rn\{color:var\(--muted\);\}/, 'row numbers are muted ink, not the hairline colour');
  rule(/:root \.qcard \.ql\{color:#fff;\}/, 'the quote-card label is white on the orange card');
  rule(/:root \.wc-card \.wc-lbl\{color:var\(--muted\);\}/, 'card captions are muted ink');
  rule(/:root \.wc-card \.wt-up\{color:var\(--ac-text,#b45309\);\}/, 'the weight rise uses the accent text token');
  rule(/:root \.wc-card \.wt-down\{color:var\(--grn,#16a34a\);\}/, 'the weight fall uses the skin green');
  rule(/@media \(max-width:768px\)\{[^@]*:root \.prd\{min-height:44px;\}[^@]*:root textarea\.ed\{min-height:44px;\}[^@]*:root details>summary\{padding-block:13px;\}/, 'the day row, Notes box and disclosure reach 44 px on a phone');
  ok('control: a rule that only exists in an earlier <style> block would not count', HTML.split('<style').length > 3 && !/:root \.rn\{color:var\(--muted\);\}/.test(HTML.split('<style').slice(0, -1).join('<style')));
}

console.log('\n5. inline colours that were fixed colours on theme surfaces');
{
  ok('the floor-row target (≥7 hrs) is muted ink, not #334455', /color:var\(--muted\);">≥\$\{E\(f\.targetValue\)\}/.test(APP) && !/color:#334455;">≥/.test(APP));
  ok('"FLOORS MET" uses the accent text token', /'#4caf82':'var\(--ac-text,var\(--gold\)\)'\};margin-bottom:8px/.test(APP));
  ok('"No previous day" sits on the dark comparison panel with the on-dark accent', /color:var\(--ac-on-dark,var\(--gold\)\);letter-spacing:\.08em;">\$\{prev\?'vs '/.test(APP));
  ok('the week-glance letters use on-dark inks', /color:\$\{isToday\?'var\(--ac-on-dark,var\(--ac-text\)\)':'var\(--on-dark,var\(--muted\)\)'\};letter-spacing:\.1em/.test(APP));
  ok('the streak numbers fall back to muted ink, not #8fa1b8, on their light cards', /: 'var\(--muted\)'};line-height:1;">\$\{workoutStreak\}/.test(APP) && /: 'var\(--muted\)'};line-height:1;">\$\{habitPct\}%/.test(APP) && /streak >= 1 \? 'var\(--ac\)' : 'var\(--muted\)'/.test(APP));
  ok('the → on a day row is muted ink, not the hairline colour', /<span style="color:var\(--muted\);flex-shr/.test(APP));
  ok('the sync pill is 11 px (the type floor) and follows the skin\'s accent text', /font-size:11px;font-weight:700;[^']*color:var\(--ac-text,#E4783F\);/.test(SYNC) && /color \|\| 'var\(--ac-text,#E4783F\)'/.test(SYNC) && !/font-size:10px/.test(SYNC));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
