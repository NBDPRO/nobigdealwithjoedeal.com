/**
 * tests/daily-success-notebook-2026-10-25.test.js
 *
 * Jo (2026-10-25): "treat the Daily Success pages more like a notebook ... sorting and filing, not a forever expanding
 * horizontal slider." The tab row used to render one tab per page, so a year of daily pages became a 365-tab strip.
 * Now the row shows only Dash, Today, the open page and a Notebook button; the notebook files every page by month,
 * newest first. The pure half (grouping, ordering, the compact tab set, the filter) is notebook-logic.js; this drives it
 * and pins the wiring in app.js / index.html.
 *
 * Run: node tests/daily-success-notebook-2026-10-25.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'pro', 'daily-success');
const N = require(path.join(DIR, 'js', 'notebook-logic.js'));
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const mk = (dk, extra) => Object.assign({ id: dk + (extra && extra.suf || 1), dk, suf: 1, name: '', data: {}, kpi: { doors: 0, closes: 0 } }, extra || {});
// Insertion order on purpose: an old page added late, two entries on one day, a named page, a page in another year.
const pages = [
  mk('2026-10-20'),
  mk('2026-10-25'),
  mk('2026-09-03', { name: 'Comeback day' }),
  mk('2026-10-25', { suf: 2 }),
  mk('2025-12-31'),
  mk('2026-10-01'),
];
const TODAY = '2026-10-25';
const label = (p) => (p.name || p.dk) + (p.suf > 1 ? ' (' + p.suf + ')' : '');

console.log('\n1. filing: pages grouped by month, newest month first, newest day first inside a month');
{
  const g = N.groupByMonth(pages, TODAY);
  ok('three months come back', g.length === 3, JSON.stringify(g.map((s) => s.key)));
  ok('months run newest first', g.map((s) => s.key).join(',') === '2026-10,2026-09,2025-12', g.map((s) => s.key).join(','));
  ok('a month label reads like a notebook divider', g[0].label === 'October 2026' && g[2].label === 'December 2025', g[0].label + ' / ' + g[2].label);
  const oct = g[0].entries;
  ok('inside October the days run newest first', oct.map((e) => e.dk).join(',') === '2026-10-25,2026-10-25,2026-10-20,2026-10-01', oct.map((e) => e.dk).join(','));
  ok('two entries on one day: the later entry (suf 2) sits above the first', oct[0].suf === 2 && oct[1].suf === 1);
  ok('every entry keeps its index into the real pages array (switchTo needs it)', oct.every((e) => pages[e.idx] && pages[e.idx].dk === e.dk && pages[e.idx].suf === e.suf));
  ok('today is flagged', oct[0].isToday && oct[1].isToday && !oct[2].isToday);
  ok('the current month is open, older months start folded', g[0].open === true && g[1].open === false && g[2].open === false);
  ok('each entry carries a weekday for the row', oct[2].weekday === 'Tue' && g[1].entries[0].weekday === 'Thu', oct[2].weekday + ' ' + g[1].entries[0].weekday);
  ok('a section counts its entries', g[0].count === 4 && g[1].count === 1);
}

console.log('\n2. the compact tab row');
{
  const tabs = N.tabSet(pages, 1, TODAY);
  ok('opens with Dash', tabs[0].kind === 'dash');
  ok('then Today (the first page for today), then nothing else for pages when today is open', tabs[1].kind === 'today' && tabs[1].idx === 1 && !tabs.some((t) => t.kind === 'page'));
  const t2 = N.tabSet(pages, 2, TODAY);
  ok('an older open page shows beside Today', t2.some((t) => t.kind === 'today' && t.idx === 1) && t2.some((t) => t.kind === 'page' && t.idx === 2));
  const t3 = N.tabSet(pages, 3, TODAY);
  ok('a second entry for today is a page of its own beside Today', t3.some((t) => t.kind === 'today' && t.idx === 1) && t3.some((t) => t.kind === 'page' && t.idx === 3));
  const noToday = N.tabSet(pages.filter((p) => p.dk !== TODAY), -1, TODAY);
  ok('no page for today yet: no Today tab, the + makes one', !noToday.some((t) => t.kind === 'today') && noToday.some((t) => t.kind === 'new'));
  ok('the Notebook button carries the page count', tabs.find((t) => t.kind === 'notebook').count === 6);
  ok('never more than five tabs however many pages exist', N.tabSet(pages.concat(Array.from({ length: 400 }, (_, i) => mk('2024-01-01', { suf: i + 2 }))), 5, TODAY).length <= 5);
  ok('the dash tab is marked active when cur is -1', N.tabSet(pages, -1, TODAY)[0].active === true && tabs[0].active === false);
}

console.log('\n3. the notebook filter');
{
  const f = (q) => N.filterEntries(N.groupByMonth(pages, TODAY), q, label);
  ok('an empty filter leaves every section as it is', f('').length === 3 && f('   ').length === 3);
  const sep = f('comeback');
  ok('a name match keeps just its month and entry', sep.length === 1 && sep[0].entries.length === 1 && sep[0].entries[0].dk === '2026-09-03');
  ok('matching by month name', f('dec').length === 1 && f('dec')[0].key === '2025-12');
  ok('matching by date digits', f('10-01').length === 1 && f('10-01')[0].entries.length === 1);
  ok('a filtered section is open so the hits are visible', sep[0].open === true);
  ok('no hits: an empty list, not a throw', f('zzz').length === 0);
}

console.log('\n4. wiring in app.js and index.html');
{
  const app = fs.readFileSync(path.join(DIR, 'js', 'app.js'), 'utf8');
  const html = read('index.html');
  const rt = (app.match(/function renderTabs\(\)\{[^]*?\n\}/) || [''])[0];
  ok('renderTabs builds from NBDNotebook.tabSet, not one tab per page', /NBDNotebook\.tabSet\(pages,cur,todayKey\(\)\)/.test(rt) && !/pages\.forEach\(\(p,i\)=>\{\s*const t=document\.createElement\('div'\);t\.className='tab'/.test(rt), rt.slice(0, 300));
  ok('the Notebook tab opens the drawer', /data-action="notebook-open"|dataset\.action='notebook-open'/.test(rt));
  ok('the dashboard "All Pages" list files pages by month too', /NBDNotebook\.groupByMonth\(pages,todayKey\(\)\)/.test(app));
  ok('notebook-logic loads before app.js, notebook-ui after it', (() => { const a = html.indexOf('notebook-logic.js'), b = html.indexOf('js/app.js'), c = html.indexOf('notebook-ui.js'); return a > 0 && a < b && b < c; })());
  ok('the notebook stylesheet is linked', /<link rel="stylesheet" href="\/pro\/daily-success\/css\/notebook\.css\?v=\d+">/.test(html));
  const ui = read('js/notebook-ui.js');
  ok('the drawer is a dialog: role, aria-modal, labelled, Escape closes, focus returns', /role="dialog"|'role', ?'dialog'/.test(ui) && /aria-modal/.test(ui) && /aria-labelledby/.test(ui) && /Escape/.test(ui) && /_opener|returnFocus|lastFocus/.test(ui));
  ok('every row the drawer renders escapes the page name', /esc\(/.test(ui) && !/innerHTML\s*=\s*[^;]*\bp\.name\b/.test(ui));
  ok('a month is a native <details>, folded or open from the logic', /<details/.test(ui) && /s\.open \? ' open' : ''|\(s\.open\?' open':''\)|open=/.test(ui));
  ok('no inline style attributes in the drawer markup (CSP / readability tests)', !/style="/.test(ui));
  const css = read('css/notebook.css');
  ok('rows and buttons meet the 44 px phone floor', /min-height:\s*44px/.test(css));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
