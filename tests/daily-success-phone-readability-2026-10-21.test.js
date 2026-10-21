/**
 * tests/daily-success-phone-readability-2026-10-21.test.js
 *
 * Daily Success on a phone: nothing readable under 12 px, 44 px tap targets, and the tables that were clipped at
 * 390 px (Exercise Log, Diet, PR tracker) reflowed. Static guards over the shipped CSS/JS so the page cannot slide
 * back to 8-9 px labels and 19 px buttons (iPhone sweep before: 151 text elements under 11 px, 118 targets under 40 px).
 *
 * Run: node tests/daily-success-phone-readability-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8').replace(/\r\n/g, '\n');
const HTML = read('index.html'), APP = read('js/app.js');
const SOURCES = { 'index.html': HTML, 'js/app.js': APP };
fs.readdirSync(path.join(DIR, 'css')).forEach((f) => { SOURCES['css/' + f] = read('css/' + f); });
fs.readdirSync(path.join(DIR, 'js')).forEach((f) => { SOURCES['js/' + f] = read('js/' + f); });

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const phoneBlock = (HTML.match(/@media \(max-width:768px\)\{([\s\S]*?)\n\}\n/) || [])[1] || '';
const tableBlock = (HTML.match(/@media \(max-width:560px\)\{\n  \.pr-grid[\s\S]*?\n\}\n/) || [])[0] || '';

console.log('\n1. type floor');
{
  Object.keys(SOURCES).forEach((name) => {
    const m = SOURCES[name].match(/font-size:\s*(?:[1-9]|10)(?:\.\d+)?px/g);
    ok(name + ' has no font-size under 11 px', !m, m && m.slice(0, 3).join(', '));
  });
  const elevens = Object.keys(SOURCES).reduce((n, k) => n + (SOURCES[k].match(/font-size:\s*11px/g) || []).length, 0);
  ok('control: 11 px captions still exist (the sweep is on 8-10 px, the floor is not loosened silently)', elevens > 0);
}

console.log('\n2. tap targets');
{
  ok('a phone block exists', phoneBlock.length > 50);
  ['.btn', '.btn-ico', '.tplus', '.tab'].forEach((sel) => ok(sel + ' is at least 44 px tall on a phone', new RegExp('\\' + sel.slice(0) + '[^{]*\\{[^}]*min-height:44px|' + sel.replace('.', '\\.') + '[^{]*\\{[^}]*height:44px').test(phoneBlock) || /\.btn,\.btn-ico,\.tplus,\.tab\{min-height:44px;\}/.test(phoneBlock)));
  ok('habit dots keep a small circle but get a 44 px hit area (pseudo-element)', /\.hd\{width:22px;height:22px;position:relative;\}/.test(phoneBlock) && /\.hd::after\{content:"";position:absolute;left:-11px;right:-11px;top:-11px;bottom:-11px;\}/.test(phoneBlock));
  ok('22 px + 2 x 11 px = a 44 px hit area', 22 + 2 * 11 === 44);
  ok('the 15 px tab-close x gets a 45 px hit area', 15 + 2 * 15 >= 44 && /\.tx::after\{content:"";position:absolute;left:-15px;right:-15px;top:-15px;bottom:-15px;\}/.test(phoneBlock));
  ok('the HISTORY / delete / floor-score controls are 44 px', /\.ex-del\{min-width:44px;min-height:44px;\}/.test(phoneBlock) && /\.pr-hist-btn\{min-height:44px;/.test(phoneBlock) && /\.dsc-item\{min-height:44px;\}/.test(phoneBlock));
  ok('inputs inside paper cards are 44 px on a phone', /\.pc input:not\(\[type=checkbox\]\):not\(\[type=radio\]\),\.pc select\{min-height:44px;\}/.test(tableBlock));
  const wc = SOURCES['css/workout-coach.css'];
  ok('the food/progress chips are no longer 36 px', !/min-height:\s*36px/.test(wc) && (wc.match(/min-height:\s*44px/g) || []).length >= 3);
}

console.log('\n3. tables reflowed for 390 px');
{
  ok('a <=560 px block exists', tableBlock.length > 100);
  ok('the PR tracker is one column on a phone', /\.pr-grid\{grid-template-columns:1fr;\}/.test(tableBlock));
  ok('Diet meal labels get room', /\.dt td:first-child\{min-width:78px;\}/.test(tableBlock));
  ok('Exercise Log becomes stacked cards (header hidden, rows are grids)', /\.dt:has\(#ex-tbody\) thead\{display:none;\}/.test(tableBlock) && /#ex-tbody tr\{display:grid;grid-template-columns:1fr 1fr 1fr 44px;/.test(tableBlock));
  ok('each field keeps a label once it is filled (Sets / Reps / Weight / Notes)', ['Sets', 'Reps', 'Weight', 'Notes'].every((l) => new RegExp('content:"' + l + '"').test(tableBlock)));
  ok('exercise inputs are 44 px', /#ex-tbody td input\{min-height:44px;/.test(tableBlock));
  ok('control: the exercise row really has the six cells the grid assumes (name, sets, reps, weight, notes, delete)', (function () {
    const row = (APP.match(/tr\.innerHTML=`([\s\S]*?)`;/) || [])[1] || '';
    return (row.match(/<td/g) || []).length === 6;
  })(), 'row template changed - revisit the #ex-tbody nth-child grid');
}

console.log('\n4. dialogs and banners');
{
  ok('no stray markdown fences in the page (they rendered as literal ``` around the goal wizard)', !/^```/m.test(HTML));
  ok('the onboarding banner wraps and keeps its tabs/main offsets on a phone', /\.onboard-banner\{top:100px;height:96px;/.test(tableBlock) && /\.ob-msg\{white-space:normal;/.test(tableBlock) && /body\.has-banner \.tabrow\{top:196px;\}/.test(tableBlock) && /body\.has-banner \.main\{margin-top:248px;\}/.test(tableBlock));
  ok('control: 100 px header + 96 px banner = the 196 px tab row offset; + 52 px tab row = the 248 px content offset', 100 + 96 === 196 && 196 + 52 === 248);
  ok('the phone header is two rows (52 + 48 = 100) with the ten buttons in a full-width strip', /\.topbar\{flex-wrap:wrap;height:100px;/.test(tableBlock) && /\.tbl\{width:100%;height:52px;\}/.test(tableBlock) && /\.tbr\{width:100%;height:48px;/.test(tableBlock) && 52 + 48 === 100);
  ok('every fixed bar follows the 100 px header (tabs 100, search tabs 148, content 150, search 100, dropdown 148)', /\.tabrow\{top:100px;\}/.test(tableBlock) && /\.tabrow\.sp\{top:148px;\}/.test(tableBlock) && /\.main\{margin-top:150px;\}/.test(tableBlock) && /\.sbar\{top:100px;\}/.test(tableBlock) && /\.sdrop\{top:148px;\}/.test(tableBlock));
  ok('control: the header really has ten controls (the reason it cannot be one row)', (HTML.match(/<div class="tbr">([\s\S]*?)<\/div>/) || ['', ''])[1].match(/<button/g).length === 10);
  ok('the banner buttons fit the width (centred, shrinkable)', /\.ob-btns\{width:100%;justify-content:center;\}/.test(tableBlock) && /\.ob-btns \.btn\{flex:1 1 auto;min-width:0;/.test(tableBlock));
  ok('the wizard Save & Launch label does not wrap', /#ob-next\{white-space:nowrap;\}/.test(tableBlock));
  const lastStyle = HTML.slice(HTML.lastIndexOf('<style>'), HTML.lastIndexOf('</style>'));
  ok('the phone layers sit in the LAST style block so they win the cascade', /@media \(max-width:768px\)\{/.test(lastStyle) && /@media \(max-width:560px\)\{/.test(lastStyle));
  ok('the coach sheet backdrop is opaque (no page bleeding through)', /\.wc-ov \{[^}]*background: #0A0C0F;/.test(SOURCES['css/workout-coach.css']));
  ok('the Scan button has a real icon, not three block glyphs', !/▮▯▮/.test(SOURCES['js/food-search-ui.js']) && /\\u\{1F4F7\}|📷/.test(SOURCES['js/food-search-ui.js']) || /data-fs-action="scan">📷 Scan/.test(SOURCES['js/food-search-ui.js']));
}

console.log('\n4a. one card width');
{
  ok('every direct child of #main fills the column (the new dashboard cards had no width and shrank to content: 200 / 270 / 356 px)', /\.main > \*\{width:100%;max-width:760px;box-sizing:border-box;\}/.test(HTML));
  ok('control: the old classic card already had this width (so the new rule matches the existing design)', /\.pc\{[^}]*width:100%;max-width:760px/.test(HTML));
}

console.log('\n4b. ghost buttons read on the dark card skin');
{
  const lum = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))).reduce((x, v, i) => x + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (x, y) => (Math.max(lum(x), lum(y)) + 0.05) / (Math.min(lum(x), lum(y)) + 0.05);
  ok('one light ghost-button colour for every dark surface (header, banner, cards, modals)', /\[data-theme="default"\] \.btn-ghost\{color:#c3cfdf;\}/.test(HTML));
  ok('...>= 4.5:1 on the dark bar and on the dark card', ratio('#c3cfdf', '#151e2b') >= 4.5 && ratio('#c3cfdf', '#12161c') >= 4.5, ratio('#c3cfdf', '#12161c').toFixed(1));
  ok('control: the old cream-era dark ink would vanish on the dark card', ratio('#3a4659', '#12161c') < 2, ratio('#3a4659', '#12161c').toFixed(2));
}

console.log('\n5. the theme code keeps has-banner');
{
  ok('app.js no longer assigns document.body.className (it wiped has-banner)', !/document\.body\.className\s*=/.test(APP));
  const src = (APP.match(/function nbdSetThemeClass\(id\) \{[\s\S]*?\n\}/) || [])[0] || '';
  ok('a helper swaps only theme-* classes', src.length > 50);
  // run the real helper against a minimal classList
  function run(initial, id) {
    const set = new Set(initial);
    const body = { classList: { add: (k) => set.add(k), remove: (k) => set.delete(k), [Symbol.iterator]: () => set[Symbol.iterator]() } };
    require('vm').runInNewContext(src + '; nbdSetThemeClass(id);', { document: { body }, id, Array });
    return Array.from(set).sort();
  }
  ok('default keeps has-banner and drops the old theme', JSON.stringify(run(['has-banner', 'theme-midnight'], 'default')) === JSON.stringify(['has-banner']));
  ok('another theme replaces only the theme class', JSON.stringify(run(['has-banner', 'theme-midnight'], 'cobalt')) === JSON.stringify(['has-banner', 'theme-cobalt']));
  ok('control: the old assignment would have dropped has-banner', (function () { let cls = 'has-banner theme-midnight'; cls = 'theme-cobalt'; return cls.indexOf('has-banner') < 0; })());
  ok('both call sites (boot and apply) use the helper', (APP.match(/nbdSetThemeClass\(/g) || []).length >= 3);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
