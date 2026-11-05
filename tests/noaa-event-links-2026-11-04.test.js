/**
 * tests/noaa-event-links-2026-11-04.test.js
 *
 * NOAA moved the Storm Events Database from ncdc.noaa.gov to ncei.noaa.gov.
 * The old per-event links (ncdc.noaa.gov/stormevents/eventdetails.jsp?id=N)
 * still answer — but they redirect to the database HOME page, not the event,
 * so every "NOAA logged 1.25-inch hail in Amelia…" citation on the area and
 * city-service pages pointed at nothing specific (checked in a browser
 * 2026-11-04). The event page is now
 *   https://www.ncei.noaa.gov/access/storm-events-database/event-details/<id>
 *
 * Guards: no public page and no generator links the old host; the town-page
 * generator builds the new event URL; every cited event link carries a
 * numeric id.
 *
 * Run: node tests/noaa-event-links-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const pages = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) pages.push(p);
  }
})(path.join(ROOT, 'docs'));

const OLD = /https?:\/\/(?:www\.)?ncdc\.noaa\.gov\/stormevents/;
const withOld = pages.filter((p) => OLD.test(fs.readFileSync(p, 'utf8'))).map((p) => path.relative(ROOT, p));
ok('no page under docs/ links the retired ncdc Storm Events host', withOld.length === 0, withOld.slice(0, 5).join(', '));

const NEW_EVENT = /https:\/\/www\.ncei\.noaa\.gov\/access\/storm-events-database\/event-details\/(\S*?)"/g;
let cited = 0, bad = [];
for (const p of pages) {
  const html = fs.readFileSync(p, 'utf8');
  for (const m of html.matchAll(NEW_EVENT)) { cited++; if (!/^\d+$/.test(m[1])) bad.push(path.relative(ROOT, p) + ' → ' + m[1]); }
}
// Positive control: the area and city-service pages DO cite NOAA events, so
// "no old links" cannot pass just because the citations vanished.
ok('pages still cite NOAA events (positive control: more than 50 event links)', cited > 50, String(cited));
ok('every event link carries a numeric event id', bad.length === 0, bad.slice(0, 3).join('; '));

const gen = fs.readFileSync(path.join(ROOT, 'scripts/build-town-pages.mjs'), 'utf8').replace(/^\s*\/\/.*$/mg, '');
ok('the town-page generator builds event-details/<id> on ncei', /ncei\.noaa\.gov\/access\/storm-events-database\/event-details\/\$\{id\}/.test(gen));
ok('the generator never emits the old host', !OLD.test(gen));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
