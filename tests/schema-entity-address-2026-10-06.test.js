/**
 * tests/schema-entity-address-2026-10-06.test.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Pins the business address in the ONE shared entity
 * (site-src/partials/schema-entity.html → stamped into every public page).
 *
 * Why: until 2026-10-06 the #org PostalAddress said Campton, KY 41301 with a
 * comment claiming it matched the Google Business Profile's verified hidden
 * address, while `geo` sat in Goshen, OH. The GBP (checked 2026-10-06) is a
 * SERVICE-AREA business with no business location at all ("No location;
 * deliveries and home services only"). So the schema was publishing a ZIP
 * the GBP does not, in a different state from its own map point. Jo's
 * standing call (2026-08-18): locality stays Goshen.
 *
 * Asserts, against the partial AND every stamped page in docs/:
 *   A1 locality Goshen, region OH, country US
 *   A2 no streetAddress, no postalCode (a service-area business shape)
 *   A3 no "Campton" / "41301" in any JSON-LD on the public site
 *   A4 geo is within ~11 km of Goshen, OH (locality and map point agree)
 *   A5 areaServed covers every GBP service area
 *   A6 the partial's comment no longer claims a verified GBP address
 *
 * Run: node tests/schema-entity-address-2026-10-06.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const PARTIAL = path.join(ROOT, 'site-src', 'partials', 'schema-entity.html');
const ORG = 'https://nobigdealwithjoedeal.com/#org';

// Goshen, OH (village centre). 0.1 deg is ~11 km of latitude.
const GOSHEN = { lat: 39.2334, lng: -84.1613 };
const GEO_TOLERANCE_DEG = 0.1;

// The GBP's service-area list as shown on 2026-10-06, normalised to the
// partial's naming ("Twp" → "Township").
const GBP_SERVICE_AREAS = [
  ['Mason', 'Ohio'], ['Amelia', 'Ohio'], ['Madeira', 'Ohio'], ['Milford', 'Ohio'],
  ['Norwood', 'Ohio'], ['Blue Ash', 'Ohio'], ['Fairfield', 'Ohio'], ['Cincinnati', 'Ohio'],
  ['Maineville', 'Ohio'], ['Montgomery', 'Ohio'], ['Springboro', 'Ohio'], ['Batavia', 'Ohio'],
  ['Lebanon', 'Ohio'], ['Loveland', 'Ohio'], ['Liberty Township', 'Ohio'],
  ['Anderson Township', 'Ohio'], ['West Chester', 'Ohio'],
  ['Florence', 'Kentucky'], ['Lexington', 'Kentucky'], ['Independence', 'Kentucky'],
];

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
  }
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function orgNode(html, where) {
  for (const raw of jsonLdBlocks(html)) {
    let data;
    try { data = JSON.parse(raw); } catch (e) { continue; }
    const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data];
    const org = nodes.find((n) => n && n['@id'] === ORG && n.address);
    if (org) return org;
  }
  throw new Error(`${where}: no #org node with an address`);
}

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // docs/pro is the CRM; docs/sites/* are OTHER tenants' sites.
      if (p === path.join(DOCS, 'pro') || p === path.join(DOCS, 'sites') || ent.name === 'node_modules') continue;
      walk(p, acc);
    } else if (ent.name.endsWith('.html')) acc.push(p);
  }
  return acc;
}

const partialSrc = fs.readFileSync(PARTIAL, 'utf8');
const partialOrg = orgNode(partialSrc, 'schema-entity.html');
const stamped = walk(DOCS)
  .map((f) => ({ f: path.relative(ROOT, f).replace(/\\/g, '/'), html: fs.readFileSync(f, 'utf8') }))
  .filter((p) => /<!-- nbd:partial schema-entity/.test(p.html));

check('A0 the entity is stamped into a real number of pages (or the page checks are vacuous)', () => {
  assert.ok(stamped.length >= 250, `only ${stamped.length} pages carry the schema-entity region`);
});

function assertAddress(org, where) {
  const a = org.address;
  assert.strictEqual(a['@type'], 'PostalAddress', `${where}: address must be a PostalAddress`);
  assert.strictEqual(a.addressLocality, 'Goshen', `${where}: addressLocality is "${a.addressLocality}", expected Goshen`);
  assert.strictEqual(a.addressRegion, 'OH', `${where}: addressRegion is "${a.addressRegion}", expected OH`);
  assert.strictEqual(a.addressCountry, 'US', `${where}: addressCountry is "${a.addressCountry}", expected US`);
}

check('A1 partial: locality Goshen, region OH, country US', () => assertAddress(partialOrg, 'partial'));

check('A1 every stamped page: locality Goshen, region OH, country US', () => {
  const bad = [];
  for (const p of stamped) {
    try { assertAddress(orgNode(p.html, p.f), p.f); } catch (e) { bad.push(e.message); }
  }
  assert.deepStrictEqual(bad.slice(0, 5), [], `${bad.length} page(s) wrong`);
});

check('A2 no streetAddress and no postalCode (service-area business, nothing the GBP does not publish)', () => {
  const a = partialOrg.address;
  assert.ok(!('streetAddress' in a), 'partial #org address carries a streetAddress');
  assert.ok(!('postalCode' in a), 'partial #org address carries a postalCode');
  const bad = stamped.filter((p) => {
    const x = orgNode(p.html, p.f).address;
    return 'streetAddress' in x || 'postalCode' in x;
  }).map((p) => p.f);
  assert.deepStrictEqual(bad.slice(0, 5), [], `${bad.length} page(s) carry a street or ZIP`);
});

check('A3 no Campton / 41301 in any JSON-LD on the public site', () => {
  const bad = [];
  for (const raw of jsonLdBlocks(partialSrc)) if (/Campton|41301/i.test(raw)) bad.push('site-src/partials/schema-entity.html');
  for (const f of walk(DOCS)) {
    const html = fs.readFileSync(f, 'utf8');
    for (const raw of jsonLdBlocks(html)) {
      if (/Campton|41301/i.test(raw)) { bad.push(path.relative(ROOT, f).replace(/\\/g, '/')); break; }
    }
  }
  assert.deepStrictEqual(bad.slice(0, 5), [], `${bad.length} file(s) still publish the Campton address`);
});

check('A4 geo agrees with the locality (within ~11 km of Goshen, OH)', () => {
  const g = partialOrg.geo;
  assert.ok(g && g['@type'] === 'GeoCoordinates', 'partial #org must carry GeoCoordinates');
  const lat = Number(g.latitude), lng = Number(g.longitude);
  assert.ok(Number.isFinite(lat) && Number.isFinite(lng), `geo is not numeric: ${g.latitude},${g.longitude}`);
  assert.ok(Math.abs(lat - GOSHEN.lat) <= GEO_TOLERANCE_DEG && Math.abs(lng - GOSHEN.lng) <= GEO_TOLERANCE_DEG,
    `geo ${lat},${lng} is not near ${partialOrg.address.addressLocality}, ${partialOrg.address.addressRegion} (${GOSHEN.lat},${GOSHEN.lng})`);
  // The region must be the state the map point is in. Goshen is in Ohio;
  // the Campton bug was a KY address with an OH point.
  assert.strictEqual(partialOrg.address.addressRegion, 'OH', 'geo is in Ohio, so addressRegion must be OH');
});

check('A5 areaServed covers every GBP service area', () => {
  const served = new Set((partialOrg.areaServed || []).map((c) => `${c.name}|${c.containedInPlace && c.containedInPlace.name}`));
  const missing = GBP_SERVICE_AREAS.filter(([n, s]) => !served.has(`${n}|${s}`)).map(([n, s]) => `${n}, ${s}`);
  assert.deepStrictEqual(missing, [], `GBP service areas missing from areaServed: ${missing.join('; ')}`);
});

check('A6 the partial comment does not claim a verified GBP address', () => {
  const comments = (partialSrc.match(/<!--[\s\S]*?-->/g) || []).join('\n');
  assert.ok(!/verified \(hidden\) address|GBP's verified/i.test(comments),
    'schema-entity.html still says the address matches a verified GBP address; the GBP has no published address');
  assert.ok(/service-area business/i.test(comments),
    'schema-entity.html must say the GBP is a service-area business with no published address');
});

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f.name}\n     ${f.message}`);
  console.error(`\nschema-entity address: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`schema-entity address: all ${passed} checks passed`);
