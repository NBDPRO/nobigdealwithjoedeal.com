/**
 * tests/ds-layout-journal-2026-10-25.test.js
 *
 * The Journal layout: the Today bar as a calm paper page (the date written out, an intention, a status line, a note). The
 * intention and the note are page fields (data-k) so they save and sync with the page; app.js reads the live values back
 * before every re-render so a floor toggle never wipes what was typed. Pins the renderer, the app.js branch, the ready
 * flag, the scripts and the scoped CSS.
 *
 * Run: node tests/ds-layout-journal-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const L = require(path.join(DS, 'js', 'layout-logic.js'));
const J = require(path.join(DS, 'js', 'journal-ui.js'));
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('js/app.js'), CSS = read('css/layouts.css'), INDEX = read('index.html');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

console.log('\n1. the page');
{
  ok('the date is written out, local, no timezone shift', J.dateLong('2026-10-25') === 'Sunday, October 25, 2026' && J.dateLong('2026-01-01') === 'Thursday, January 1, 2026');
  ok('a bad date is an empty string, not Invalid Date', J.dateLong('nope') === '' && J.dateLong() === '');
  ok('the status line: floors of total, trained or not', J.statusLine({ floorsMet: 3, floorsTotal: 5, workout: false }) === '3 of 5 floors · no workout yet' && J.statusLine({ floorsMet: 5, floorsTotal: 5, workout: true }) === 'every floor met · trained');
  ok('no floors configured: just the workout', J.statusLine({ floorsMet: 0, floorsTotal: 0, workout: true }) === 'trained');
  const h = J.html({ dk: '2026-10-25', isToday: true, intention: 'Ship the sweep', note: 'Slept well.', floorsMet: 3, floorsTotal: 5, workout: false });
  ok('the intention is a page field with the mark-dirty action and a length cap', /<input class="jn-in" data-k="journal-intention" data-input-action="mark-dirty" maxlength="120"[^>]*value="Ship the sweep">/.test(h));
  ok('the note is a page field too', /<textarea class="jn-note" data-k="journal-note" data-input-action="mark-dirty" maxlength="2000"[^>]*>Slept well\.<\/textarea>/.test(h));
  ok('the date, a "today" mark, the status with a coach link while untrained', /Sunday, October 25, 2026<span class="jn-today">today<\/span>/.test(h) && /3 of 5 floors · no workout yet <button type="button" class="jn-link" data-journal="workout">open the coach<\/button>/.test(h));
  const t = J.html({ dk: '2026-10-24', isToday: false, intention: '', note: '', floorsMet: 5, floorsTotal: 5, workout: true });
  ok('another day: no "today" mark; trained: no coach link, a trained class', !/jn-today/.test(t) && !/data-journal/.test(t) && /jn-status trained/.test(t));
  const evil = J.html({ dk: '2026-10-25', intention: '"><img src=x onerror=1>', note: '</textarea><script>1</script>' });
  ok('typed text is escaped in the value and the textarea', !/<img src=x/.test(evil) && !/<script>/.test(evil) && /&lt;img/.test(evil) && /&lt;\/textarea&gt;/.test(evil));
  ok('no inline style attribute', !/style="/.test(h));
  ok('no input at all does not throw', /jn-page/.test(J.html()) && /jn-page/.test(J.html(null)));
  const pages = [{ dk: '2026-10-25', data: { 'journal-intention': 'today' } }, { dk: '2026-10-23', data: { 'journal-intention': 'Call three leads' } }, { dk: '2026-10-24', data: { 'journal-intention': 'Rest' } }, { dk: '2026-10-22', data: {} }, { dk: 'bad', data: { 'journal-intention': 'x' } }];
  const r = J.recentIntentions(pages, '2026-10-25', 5);
  ok('past intentions: other dated pages that carry one, newest first', r.map((x) => x.dk).join() === '2026-10-24,2026-10-23' && r[0].intention === 'Rest');
  ok('the week view is a folded <details> that lists them with short dates, and is absent with none', /<details class="jn-week"><summary>Past intentions<\/summary><ul class="jn-past"><li><span class="jn-past-d">Sat, Oct 24<\/span><span class="jn-past-t">Rest<\/span><\/li>/.test(J.html({ dk: '2026-10-25', recent: r })) && !/jn-week/.test(J.html({ dk: '2026-10-25', recent: [] })));
  ok('past intentions are escaped', /&lt;b&gt;/.test(J.html({ dk: '2026-10-25', recent: [{ dk: '2026-10-24', intention: '<b>x</b>' }] })));
}

console.log('\n2. wiring');
{
  ok('Journal is ready to pick; Classic still the default', L.byId('journal').ready === true && L.DEFAULT === 'classic' && L.normLayout('journal') === 'journal');
  ok('updateTodayBar renders the page only in the Journal layout and toggles the class', /journal=ui==='journal'/.test(APP) && /bar\.classList\.toggle\('today-journal',journal\)/.test(APP) && /if\(journal&&window\.NBDJournalUI&&p\)/.test(APP));
  ok('it reads the live field values back into the page before re-rendering (a floor toggle never wipes typing)', /bar\.querySelectorAll\('\[data-k\]'\)\.forEach\(el=>\{p\.data\[el\.dataset\.k\]=el\.value\|\|'';\}\);/.test(APP));
  ok('it hands the page the date, today flag, both fields, the floors, the workout and the past intentions', /NBDJournalUI\.html\(\{dk:p\.dk,isToday:isToday\(p\.dk\),intention:p\.data\['journal-intention'\]\|\|'',note:p\.data\['journal-note'\]\|\|'',floorsMet:hit,floorsTotal:total,workout:s\.workout,recent:NBDJournalUI\.recentIntentions\(pages,p\.dk,5\)\}\)/.test(APP));
  ok('collectPage saves every data-k field on the page (so the journal fields ride the page save)', /document\.querySelectorAll\('\[data-k\]'\)\.forEach\(el=>\{p\.data\[el\.dataset\.k\]=el\.value\|\|'';\}\);/.test(APP));
  ok('journal-ui loads deferred', /<script src="\/pro\/daily-success\/js\/journal-ui\.js\?v=\d+" defer><\/script>/.test(INDEX));
  const jn = CSS.slice(CSS.indexOf('Journal:'), CSS.indexOf('One Thing:'));
  const rules = jn.split('\n').filter((l) => /\{/.test(l));
  ok('every Journal rule is scoped to [data-ui="journal"]', rules.length >= 10 && rules.every((l) => /^\[data-ui="journal"\]/.test(l.trim())), rules.filter((l) => !/^\[data-ui="journal"\]/.test(l.trim())).join(' | '));
  ok('paper in every theme: fixed warm paper and dark ink, a serif stack, inputs 44 px, static', /\.jn-page \{ background: #f7f3ea; color: #1f2937;/.test(jn) && /Georgia/.test(jn) && /\.jn-in, \[data-ui="journal"\] \.jn-note \{[^}]*min-height: 44px/.test(jn) && /today-journal \{ position: static;/.test(jn));
  ok('no font under 11 px', !/font-size: (10|9|8)px/.test(jn));
  ok('layouts.css cache version bumped', /layouts\.css\?v=\d+/.test(INDEX));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
