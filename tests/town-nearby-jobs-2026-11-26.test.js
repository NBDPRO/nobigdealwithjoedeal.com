#!/usr/bin/env node
/**
 * town-nearby-jobs-2026-11-26 — the "jobs near <Town>" fallback that
 * scripts/build-projects.mjs stamps on /areas/<town> and the town-specific
 * /services/<service>-<town> pages whose own town has no matching live job.
 *
 * The rule (Jo, 2026-11-26): show the town's own projects, or failing that the
 * nearest real ones labelled honestly ("Nearby: Milford, OH · 6 mi away").
 * Never pretend a nearby job was in that town. Distances come from Census
 * Gazetteer points in site-src/data/towns.json, never guessed at runtime.
 *
 * Checks the STAMPED pages (what ships), not the generator's source text:
 *   1. every town in towns.json has a geo point;
 *   2. every nearby card names a different town than the page's, and its
 *      distance matches the towns.json points (rounded, within 1 mile) and the
 *      30-mile cap;
 *   3. a page whose town has its own matching job never carries a nearby block;
 *   4. positive control: nearby blocks exist (the check above can fail).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, failN = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failN++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const towns = JSON.parse(fs.readFileSync(path.join(ROOT, 'site-src', 'data', 'towns.json'), 'utf8'));
const geo = new Map();
const slugOf = (name, st) => `${name.toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${st.toLowerCase()}`;
for (const t of towns.towns) if (t.geo) geo.set(t.slug, t.geo);
for (const o of towns.otherPlaces || []) geo.set(slugOf(o.town, o.state), o.geo);
const miles = (a, b) => {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
};

console.log('\ntowns.json carries a Census point for every town');
const missing = towns.towns.filter((t) => !t.geo || typeof t.geo.lat !== 'number' || typeof t.geo.lng !== 'number').map((t) => t.slug);
ok('every town has numeric geo.lat / geo.lng', missing.length === 0, missing.join(', '));

const projects = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'data', 'projects.json'), 'utf8')).projects;
const ALIAS = { 'mount orab': 'mt orab', 'mt. orab': 'mt orab', anderson: 'anderson township', 'sycamore twp': 'sycamore township' };
const projTown = (city) => {
  const m = /^(.+?),\s*([A-Z]{2})$/.exec(city.trim());
  const lower = m[1].toLowerCase().trim();
  return slugOf(ALIAS[lower] || lower, m[2]);
};

const REGION = /<!-- OURWORK-(?:AREA|LOCAL)-START -->([\s\S]*?)<!-- OURWORK-(?:AREA|LOCAL)-END -->/;
const CARD = /<span class="project-loc">[\s\S]*?<\/svg> Nearby: ([^<·]+?) · (\d+) mi away<\/span>/g;
const pages = [];
for (const f of fs.readdirSync(path.join(ROOT, 'docs', 'areas'))) {
  if (f.endsWith('.html') && f !== 'index.html') pages.push({ file: `docs/areas/${f}`, town: f.slice(0, -5), service: null });
}
const PREFIX = { 'roof-replacement': 'roof-replacement', 'roof-repair': 'roof-repair', 'roof-inspection': 'roof-inspection', 'storm-damage': 'storm-damage', 'hail-damage': 'storm-damage', 'gutter-replacement': 'gutter-replacement', 'siding-replacement': 'siding-replacement', 'siding-repair': 'siding-repair' };
const prefixes = Object.keys(PREFIX).sort((a, b) => b.length - a.length);
for (const f of fs.readdirSync(path.join(ROOT, 'docs', 'services'))) {
  if (!f.endsWith('.html')) continue;
  const base = f.slice(0, -5);
  const p = prefixes.find((x) => base.startsWith(`${x}-`) && geo.has(base.slice(x.length + 1)));
  if (p) pages.push({ file: `docs/services/${f}`, town: base.slice(p.length + 1), service: PREFIX[p] });
}

console.log('\nnearby cards are labelled with their real town and a true distance');
let nearbyPages = 0, nearbyCards = 0;
const bad = [];
for (const pg of pages) {
  const m = REGION.exec(fs.readFileSync(path.join(ROOT, pg.file), 'utf8'));
  const own = projects.filter((p) => projTown(p.city) === pg.town && (!pg.service || p.services.includes(pg.service)));
  const isNear = !!m && /Jobs Near <span>/.test(m[1]);
  if (own.length && isNear) bad.push(`${pg.file}: town has ${own.length} own job(s) but shows a nearby block`);
  if (!isNear) continue;
  nearbyPages++;
  const cards = [...m[1].matchAll(CARD)];
  const all = (m[1].match(/class="project project-link"/g) || []).length;
  if (!cards.length || cards.length !== all) bad.push(`${pg.file}: ${all} card(s) but ${cards.length} carry a "Nearby: <town> · N mi away" label`);
  for (const [, city, mi] of cards) {
    nearbyCards++;
    const s = projTown(city);
    if (s === pg.town) { bad.push(`${pg.file}: a nearby card claims the page's own town (${city})`); continue; }
    const real = miles(geo.get(pg.town), geo.get(s));
    if (Math.abs(real - Number(mi)) > 1 || real > 30) bad.push(`${pg.file}: ${city} labelled ${mi} mi, towns.json says ${real.toFixed(1)} mi`);
  }
}
ok('no own-town page shows a nearby block; every nearby card has an honest town + distance', bad.length === 0, bad.slice(0, 8).join('\n      '));
ok(`POSITIVE CONTROL: nearby blocks were found (${nearbyPages} pages, ${nearbyCards} cards)`, nearbyPages >= 10 && nearbyCards >= 10);

console.log(`\n${'─'.repeat(50)}\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
