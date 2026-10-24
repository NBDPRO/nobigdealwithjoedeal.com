#!/usr/bin/env node
/**
 * tests/d2d-door-import-2026-10-16.test.js — door-list CSV import for the D2D
 * tracker (docs/pro/js/d2d-door-import.js).
 *
 *   A. the CSV reader: quotes, doubled quotes, commas and newlines in quotes, CRLF, BOM
 *   B. columns: header aliases; people / contact columns are never read (owner,
 *      name, phone, email, mailing address) and are reported, not stored
 *   C. the plan: address required, bad locations / duplicates skipped, a 1500
 *      cap, roof age from the last roof permit before year built, routes kept
 *      or made (oldest roof first), permit notes per town
 *   D. the stored doc: only the allowlisted keys; nothing personal survives
 *   E. the Routes section: escaped, each stop opens the knock sheet with the
 *      address (and location), knocked doors marked, 44 px targets
 *   F. wiring: lazy d2d bundle (before the tracker), the shim's actions, the
 *      Routes tab hook, cache-busting, the rules match the client
 *
 * Run: node tests/d2d-door-import-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const D = require(path.join(ROOT, 'docs/pro/js/d2d-door-import.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

console.log('A. the CSV reader');
{
  const rows = D.parseCsv('﻿address,city\r\n"12 Oak St, Apt 2","Mason"\r\n"He said ""hi""",x\n"two\nlines",y\n\n');
  ok('BOM, CRLF, quoted commas, doubled quotes, newline in quotes, blank line', JSON.stringify(rows) === JSON.stringify([['address', 'city'], ['12 Oak St, Apt 2', 'Mason'], ['He said "hi"', 'x'], ['two\nlines', 'y']]), JSON.stringify(rows));
  ok('no trailing newline still reads the last row', D.parseCsv('a,b\n1,2').length === 2);
}

console.log('B. columns');
{
  const c = D.mapColumns(['Address', 'City', 'ZIP', 'Latitude', 'Longitude', 'Year Built', 'Owner Name', 'Phone', 'Email', 'Mailing Address', 'Parcel', 'Route', 'Stop', 'permit_note']);
  ok('aliases map to fields', c.map.address === 0 && c.map.city === 1 && c.map.zip === 2 && c.map.lat === 3 && c.map.lng === 4 && c.map.yearBuilt === 5 && c.map.route === 11 && c.map.stop === 12 && c.map.note === 13, JSON.stringify(c.map));
  ok('owner / phone / email / mailing address are never read (reported as not read)', c.personal.join() === 'Owner Name,Phone,Email,Mailing Address' && [6, 7, 8, 9].every((i) => !Object.values(c.map).includes(i)), JSON.stringify(c));
  ok('other columns are ignored, not stored', c.ignored.join() === 'Parcel');
}

console.log('C. the plan');
{
  const csv = [
    'address,city,state,zip,lat,lng,year_built,last_roof_permit,owner,phone,route,stop,permit_note',
    '"1 Elm St",Mason,OH,45040,39.36,-84.31,1990,,Jane Doe,513-555-0100,R2,2,Register with Mason Police (Ch. 707).',
    '"2 Elm St",Mason,OH,45040,39.361,-84.311,1995,2018,John Roe,513-555-0101,R2,1,',
    '"3 Elm St",Mason,OH,45040,95,-84,1980,,,,R1,1,',
    '"1 Elm St",Mason,OH,45040,39.36,-84.31,1990,,,,R1,3,',
    ',Mason,OH,45040,,,,,,,R1,4,',
    '"4 Oak St",Loveland,OH,45140,,,2001,,,,R1,2,Per-person permit; fingerprints first.',
  ].join('\n');
  const p = D.planImport(csv, 2026);
  ok('kept doors: address required, bad location / duplicate / blank skipped', p.doors.length === 3 && p.skipped.bad_location === 1 && p.skipped.duplicate === 1 && p.skipped.no_address === 1, JSON.stringify(p.skipped));
  const d2 = p.doors.find((d) => /^2 Elm/.test(d.a));
  ok('roof age from the LAST ROOF PERMIT when there is one (2026-2018 = 8)', d2.ag === 8 && d2.b === 'roof_permit' && d2.r === 2018 && d2.y === 1995);
  const d1 = p.doors.find((d) => /^1 Elm/.test(d.a));
  ok('else from year built (2026-1990 = 36)', d1.ag === 36 && d1.b === 'year_built');
  ok('the full address carries town, state and zip once', d1.a === '1 Elm St, Mason, OH 45040', d1.a);
  ok('a door with no location is kept (listed, not on the map)', p.doors.find((d) => /^4 Oak/.test(d.a)).la === null);
  ok('the file\'s own routes and stops are kept', d1.rt === 'R2' && d1.s === 2 && d2.s === 1);
  ok('permit notes: one per town', JSON.stringify(p.notes) === JSON.stringify([{ town: 'Mason', note: 'Register with Mason Police (Ch. 707).' }, { town: 'Loveland', note: 'Per-person permit; fingerprints first.' }]), JSON.stringify(p.notes));
  ok('owner and phone columns are reported as not read', p.personal.join() === 'owner,phone');
  const s = JSON.stringify(p.doors);
  ok('nothing personal in the doors (no name, no phone)', !/Jane|John|555/.test(s), s);
  const noRoute = D.planImport('address,year_built\n"A St",2010\n"B St",1985\n"C St",\n', 2026);
  ok('no route column: one route R1, oldest roof first, unknown last', noRoute.doors.map((d) => d.a + ':' + d.s).join() === 'B St:1,A St:2,C St:3' && noRoute.doors.every((d) => d.rt === 'R1'), JSON.stringify(noRoute.doors));
  const big = 'address\n' + Array.from({ length: 1600 }, (_, i) => i + ' Main St').join('\n');
  const pb = D.planImport(big, 2026);
  ok('capped at 1500 doors, the rest counted', pb.doors.length === 1500 && pb.skipped.over_cap === 100);
  ok('no address column → a clear error', /No address column/.test(D.planImport('street_no,zip\n1,45040', 2026).error));
  ok('header only → a clear error', /No rows found/.test(D.planImport('address\n', 2026).error));
  ok('over 2 MB → refused', /over 2 MB/.test(D.planImport('address\n' + 'x'.repeat(2 * 1024 * 1024 + 1), 2026).error));
}

console.log('D. the stored doc');
{
  const p = D.planImport('address,lat,lng,owner,email\n"9 Pine",39.1,-84.5,Ann Lee,ann@example.test\n', 2026);
  const doc = D.listDoc(p, { userId: 'u1', companyId: 'c1', name: 'x'.repeat(100), source: 'aging-roofs' });
  ok('only the allowlisted list keys (createdAt is added by the caller)', Object.keys(doc).sort().join() === D.LIST_KEYS.filter((k) => k !== 'createdAt').sort().join(), Object.keys(doc).join());
  ok('every door carries only the door keys', doc.doors.every((d) => Object.keys(d).sort().join() === D.DOOR_KEYS.slice().sort().join()));
  ok('the name is capped at 80', doc.name.length === 80);
  ok('nothing personal stored', !/Ann|example\.test/.test(JSON.stringify(doc)));
}

console.log('E. the Routes section');
{
  const p = D.planImport('address,city,lat,lng,year_built,route,stop\n"5 O\'Brien Ct <b>",Mason,39.3,-84.3,1990,R1,1\n"6 Elm",Mason,,,2000,R1,2\n', 2026);
  const list = Object.assign({ id: 'L1', mine: true, name: 'Mason <list>', notes: [{ town: 'Mason', note: 'Register first' }] }, D.listDoc(p, { userId: 'u', companyId: 'c' }), { name: 'Mason <list>', notes: [{ town: 'Mason', note: 'Register first' }] });
  const html = D.sectionHtml([list], 'L1', { '6 elm, mason': 1 });
  ok('names and addresses are escaped', /Mason &lt;list&gt;/.test(html) && /5 O&#39;Brien Ct &lt;b&gt;, Mason/.test(html) && !/<b>/.test(html));
  const args = /data-d2d-args="([^"]+)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  ok('a stop opens the knock sheet with the address and location', /data-d2d-action="openQuickKnock"/.test(html) && JSON.parse(args).address === "5 O'Brien Ct <b>, Mason" && JSON.parse(args).lat === 39.3, args);
  ok('a stop with no location opens it with the address only', /data-d2d-args="\{&quot;address&quot;:&quot;6 Elm, Mason&quot;\}"/.test(html), html);
  ok('a knocked door is marked', /is-done/.test(html) && /· knocked/.test(html) && /1 knocked/.test(html));
  ok('show / hide / delete / import go through the D2D delegate', /data-d2d-action="hideDoorList"/.test(html) && /data-d2d-action="deleteDoorList" data-d2d-id="L1"/.test(html) && /data-d2d-action="importDoors"/.test(html));
  ok('a list someone else made: no Delete', !/deleteDoorList/.test(D.sectionHtml([Object.assign({}, list, { mine: false })], null, {})));
  ok('the permit note shows with the list', /<strong>Mason:<\/strong> Register first/.test(html));
  ok('doors and mail only: the help line says contact columns are never read', /phone, email and owner columns are never read/.test(html));
  const css = read('docs/pro/css/d2d-tracker.css');
  ok('44 px targets for stops and buttons', /\.d2d-doorlist \.d2d-route-stop \{ min-height: 44px; \}/.test(css) && /\.d2d-doorlist \.d2d-action-btn \{ min-height: 44px; \}/.test(css));
}

console.log('F. wiring');
{
  const sl = read('docs/pro/js/script-loader.js');
  ok('in the lazy d2d bundle, before the tracker, cache-busted', /'js\/d2d-door-import\.js\?v=1',\n\s*'js\/d2d-tracker-core-2026b\.js\?v=17',\n\s*'js\/d2d-tracker-ui-2026b\.js\?v=12',\n\s*'js\/d2d-tracker-2026b\.js\?v=6'/.test(sl));
  const shim = read('docs/pro/js/d2d-tracker-2026b.js');
  ok('the shim exposes importDoors / showDoorList / hideDoorList / deleteDoorList', ['importDoors', 'showDoorList', 'hideDoorList', 'deleteDoorList'].every((a) => new RegExp('\\b' + a + ': ').test(shim)));
  ok('the Routes tab paints the door lists', /if \(window\.NBDDoorImport && typeof window\.NBDDoorImport\.html === 'function'\) html \+= window\.NBDDoorImport\.html\(\);/.test(read('docs/pro/js/d2d-tracker-ui-2026b.js')));
  const dash = read('docs/pro/dashboard.html');
  ok('script-loader and the D2D stylesheet were cache-busted', /js\/script-loader\.js\?v=(20[89]|2[1-9]\d)\b/.test(dash) && /css\/d2d-tracker\.css\?v=([3-9]|\d\d)(?!\d)/.test(dash) && /js\/script-loader\.js\?v=(20[89]|2[1-9]\d)\b/.test(read('docs/pro/customer.html')));
  const src = read('docs/pro/js/d2d-door-import.js');
  ok('writes only to d2d_doorlists, with the import confirmed first; nothing is sent', /collection\(w\._db \|\| w\.db, 'd2d_doorlists'\)/.test(src) && /uiConfirm\(msg/.test(src) && !/sms:|tel:|mailto:|httpsCallable|fetch\(/.test(src));
  ok('a viewer is stopped before the file picker (NBDRole.guard)', /root\.NBDRole\.guard\(\) === false/.test(src));
  ok('the rules block names the collection and the cap', /match \/d2d_doorlists\/\{listId\}/.test(read('firestore.rules')) && /d\.doors\.size\(\) <= 1500/.test(read('firestore.rules')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
