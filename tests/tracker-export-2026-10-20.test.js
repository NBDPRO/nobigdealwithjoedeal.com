#!/usr/bin/env node
/**
 * Tracker idea #8 (2026-10-20): "Download my data" — JSON of everything plus
 * Excel-safe CSVs, built entirely on the device
 * (docs/pro/daily-success/js/export-logic.js, export-ui.js).
 *
 * Run: node tests/tracker-export-2026-10-20.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const E = require(path.join(ROOT, 'docs/pro/daily-success/js/export-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const K = E.KEYS;
const NOW = new Date(2026, 9, 20, 12, 0, 0);

const pages = [
  { id: 1, dk: '2026-10-18', data: { 'bm-wt': '201.4', 'diet-m0-name': 'Eggs, "extra" cheesy', 'diet-m0-p': '30', 'diet-m0-c': '2', 'diet-m0-f': '20', 'diet-m0-cal': '310', 'diet-m2-name': '=HYPERLINK("http://evil")' } },
  { id: 2, dk: '2026-10-19', data: { 'bm-wt': '200', 'diet-m1-name': 'Café bowl\nwith rice', 'diet-m1-p': '45' } },
  { id: 3, dk: '2026-10-17', deleted: true, data: { 'bm-wt': '250', 'diet-m0-name': 'GONE-flagged' } },
  { id: 4, dk: '2026-10-16', data: { 'bm-wt': '260', 'diet-m0-name': 'GONE-tombstoned' } },
  { id: 5, dk: '2026-10-15', data: {} },
];
const sessions = [
  { id: 's1', date: '2026-10-19', split: 'Push', exercises: [{ exId: 'bb_bench', name: 'Barbell Bench Press', sets: [{ reps: 8, weight: 185, rpe: 8, done: true }, { reps: '8', weight: '185', rpe: '', done: false, warm: true }] }] },
  { id: 's2', date: '2026-10-17', split: '+Pull', exercises: [{ exId: 'row', name: '@Row', sets: [{ reps: 10, weight: 100, rpe: 7 }] }] },
];
const raw = {
  [K.pages]: JSON.stringify(pages), [K.tomb]: JSON.stringify(['4']), [K.sessions]: JSON.stringify(sessions),
  [K.coach]: JSON.stringify({ rotation: 'ppl' }), [K.food]: JSON.stringify({ favorites: [{ name: 'Shake' }], targets: { calories: 2400 } }),
  [K.config]: JSON.stringify({ floors: [{ id: 'qs1', label: 'Sleep' }] }), [K.goals]: JSON.stringify({ d: 1, r: 2, c: 3 }),
  [K.reviews]: JSON.stringify({ goal: {}, weeks: {} }), [K.money]: JSON.stringify({}), [K.streak]: '4',
};
const byId = (files, id) => files.find((f) => f.id === id);
const rows = (t) => t.slice(1).split('\r\n').filter(Boolean);

console.log('A. CSV cells');
ok('plain cell is untouched', E.csvCell('Bench Press') === 'Bench Press' && E.csvCell(185) === '185');
ok('comma, quote and newline are quoted, quotes doubled', E.csvCell('a,b') === '"a,b"' && E.csvCell('say "hi"') === '"say ""hi"""' && E.csvCell('x\ny') === '"x\ny"');
ok('formula injection defused: = + - @ get a leading single quote',
  E.csvCell('=1+1') === "'=1+1" && E.csvCell('+cmd') === "'+cmd" && E.csvCell('-2+3') === "'-2+3" && E.csvCell('@SUM(A1)') === "'@SUM(A1)");
ok('a defused cell that also needs quoting is both', E.csvCell('=HYPERLINK("u","x")') === '"\'=HYPERLINK(""u"",""x"")"');
ok('a normal cell next to them is NOT prefixed (control)', E.csvCell('Dumbbell Row') === 'Dumbbell Row' && E.csvCell('Row = 5') === 'Row = 5');
ok('a real negative number is not treated as a formula', E.csvCell(-5) === '-5');
ok('toCsv: BOM first, CRLF rows', E.toCsv(['a'], [['1']]) === '﻿a\r\n1\r\n');

console.log('B. files from real stores');
const files = E.buildFiles(raw, NOW);
const json = byId(files, 'json'), ses = byId(files, 'sessions'), wt = byId(files, 'weight'), food = byId(files, 'food');
ok('four files, names carry the date', files.length === 4 && files.every((f) => f.name.includes('2026-10-20')), files.map((f) => f.name).join(','));
ok('every CSV starts with the BOM', [ses, wt, food].every((f) => f.text.charCodeAt(0) === 0xFEFF));
const data = JSON.parse(json.text);
ok('JSON round trip: same session count and ids', data.sessions.length === 2 && data.sessions.map((s) => s.id).join() === 's1,s2');
ok('JSON carries settings, floors, goals, food favorites, streak',
  data.coachSettings.rotation === 'ppl' && data.userConfig.floors.length === 1 && data.goalTargets.c === 3 && data.food.favorites.length === 1 && data.streak === 4);
ok('deleted (flag) and tombstoned pages are excluded from the JSON', data.pages.map((p) => p.id).join() === '1,2,5' && !json.text.includes('GONE'));
ok('…and from the weight and food CSVs', !wt.text.includes('250') && !wt.text.includes('260') && !food.text.includes('GONE'));
ok('weight CSV: date,lbs sorted', wt.text === '﻿date,lbs\r\n2026-10-18,201.4\r\n2026-10-19,200\r\n', JSON.stringify(wt.text));
ok('sessions CSV: one row per set (3) plus header', rows(ses.text).length === 4, String(rows(ses.text).length));
ok('sessions CSV: warm flag and not-done carried', rows(ses.text).some((l) => /,2,8,185,,no,yes,s1$/.test(l)), rows(ses.text).join(' | '));
ok('sessions CSV: exercise "@Row" and split "+Pull" are defused', ses.text.includes("'@Row") && ses.text.includes("'+Pull"));
ok('food CSV: quotes/newline/accents survive, formula meal defused',
  food.text.includes('"Eggs, ""extra"" cheesy"') && food.text.includes('"Café bowl\nwith rice"') && food.text.includes('"\'=HYPERLINK(""http://evil"")"'));
ok('food CSV: a meal with nothing in it is not a row (3 meals + header)', food.text.split('\r\n').filter(Boolean).length === 4);

console.log('C. empty stores');
const empty = E.buildFiles({}, NOW);
ok('empty stores still give four valid files', empty.length === 4);
const ed = JSON.parse(byId(empty, 'json').text);
ok('empty JSON parses with empty lists', ed.pages.length === 0 && ed.sessions.length === 0 && ed.weight.length === 0 && ed.streak === 0);
ok('empty CSVs are header-only with BOM', ['sessions', 'weight', 'food'].every((id) => { const t = byId(empty, id).text; return t.charCodeAt(0) === 0xFEFF && rows(t).length === 1; }));
const junk = E.buildFiles({ [K.pages]: '{not json', [K.sessions]: '42', [K.tomb]: 'x' }, NOW);
ok('corrupt stores do not throw', junk.length === 4 && JSON.parse(byId(junk, 'json').text).pages.length === 0);

console.log('D. scope and wiring');
const ui = read('docs/pro/daily-success/js/export-ui.js');
ok('no network, no inline handlers, never writes a store',
  !/fetch\(|XMLHttpRequest|sendBeacon|\bon(click|input|change)\s*=/.test(ui) && !/localStorage\.(setItem|removeItem|clear)/.test(ui));
ok('keys list is exactly the tracker stores', Object.values(K).every((k) => /^nbd_(dsp_|ds_|user_config|gt|streak)/.test(k)));
const idx = read('docs/pro/daily-success/index.html');
ok('index.html loads both scripts (deferred, versioned) and the css',
  /export-logic\.js\?v=\d+" defer/.test(idx) && /export-ui\.js\?v=\d+" defer/.test(idx) && /css\/export\.css\?v=\d+/.test(idx));
ok('logic loads before ui', idx.indexOf('export-logic.js') < idx.indexOf('export-ui.js'));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
