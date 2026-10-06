#!/usr/bin/env node
/*
 * Tier 2 (2026-07): internal linking for the location cluster + real geo.
 *
 * Fixes three verified gaps:
 *  1. Every areas/{city}.html carried the SAME placeholder GeoCoordinates
 *     (39.2,-84.15 — Goshen's) — all 25 cities claimed the same point.
 *     Replaced with approximate real city-center coordinates.
 *  2. Service hub pages linked 0 of their own city variants. Each hub gains
 *     a "cities" pill-link section (marker: data-nbd-cities="v1").
 *  3. Location pages didn't link the same service in nearby cities, and had
 *     zero blog links. Each gains a section with the 6 geographically
 *     nearest same-service pages + up to 2 topical guides, using the same
 *     svc-grid/svc-card markup as the existing "Also in {City}" block
 *     (marker: data-nbd-nearby="v1").
 *
 * Idempotent via the data-nbd markers.
 */
const fs = require('fs');
const path = require('path');

const DOCS = path.resolve(__dirname, '..', 'docs');
const SVC = path.join(DOCS, 'services');

// Approximate city-center coordinates (2dp, Greater Cincinnati metro).
const COORDS = {
  'amelia-oh': [39.03, -84.22], 'anderson-township-oh': [39.08, -84.34],
  'batavia-oh': [39.08, -84.18], 'blanchester-oh': [39.29, -83.99],
  'blue-ash-oh': [39.23, -84.38], 'cincinnati-oh': [39.10, -84.51],
  'clarksville-oh': [39.40, -83.98], 'covington-ky': [39.08, -84.51],
  'erlanger-ky': [39.02, -84.60], 'fairfield-oh': [39.35, -84.56],
  'fayetteville-oh': [39.19, -83.93], 'florence-ky': [39.00, -84.63],
  'fort-mitchell-ky': [39.04, -84.55], 'goshen-oh': [39.23, -84.16],
  'indian-hill-oh': [39.18, -84.34], 'lebanon-oh': [39.44, -84.21],
  'loveland-oh': [39.27, -84.26], 'maineville-oh': [39.31, -84.22],
  'mason-oh': [39.36, -84.31], 'milford-oh': [39.18, -84.29],
  'monroe-oh': [39.44, -84.36], 'mt-orab-oh': [39.03, -83.92],
  'springboro-oh': [39.55, -84.23], 'west-chester-oh': [39.33, -84.40],
  'wilmington-oh': [39.45, -83.83],
  // Central Kentucky expansion (2026-08-25): Lexington flagship + Bluegrass ring.
  'lexington-ky': [38.05, -84.50], 'georgetown-ky': [38.21, -84.56],
  'nicholasville-ky': [37.88, -84.57], 'winchester-ky': [37.99, -84.18],
  'richmond-ky': [37.75, -84.29], 'versailles-ky': [38.05, -84.73],
  // 2026-09-24: 12 towns with finished /our-work jobs but no area page.
  'montgomery-oh': [39.23, -84.35], 'sycamore-township-oh': [39.21, -84.37],
  'madeira-oh': [39.19, -84.36], 'norwood-oh': [39.16, -84.46],
  'sharonville-oh': [39.27, -84.41], 'newtown-oh': [39.12, -84.36],
  'franklin-oh': [39.56, -84.30], 'miamisburg-oh': [39.64, -84.29],
  'bethel-oh': [38.96, -84.08], 'new-richmond-oh': [38.95, -84.28],
  'newport-ky': [39.09, -84.50], 'union-ky': [38.95, -84.68],
};

const FAMILIES = [
  { prefix: 'hail-damage-insurance-claim', hub: 'hail-damage-insurance-claim.html', label: 'Hail Claim Help', icon: '📋' },
  { prefix: 'hail-damage', hub: 'hail-damage-insurance-claim.html', label: 'Hail Damage Inspection', icon: '🛡️' },
  { prefix: 'storm-damage', hub: 'storm-damage.html', label: 'Storm Damage Repair', icon: '⛈️' },
  { prefix: 'roof-replacement', hub: 'roof-replacement.html', label: 'Roof Replacement', icon: '🏠' },
  { prefix: 'roof-repair', hub: 'roof-repair.html', label: 'Roof Repair', icon: '🔧' },
  { prefix: 'roof-inspection', hub: 'roof-inspection.html', label: 'Roof Inspection', icon: '🔍' },
  { prefix: 'siding-replacement', hub: 'siding-replacement.html', label: 'Siding Replacement', icon: '🧱' },
  { prefix: 'siding-repair', hub: 'siding-repair.html', label: 'Siding Repair', icon: '🧰' },
  { prefix: 'gutter-replacement', hub: 'gutter-replacement.html', label: 'Gutter Replacement', icon: '🌧️' },
];

const GUIDES = {
  'hail-damage': [
    ['/blog/does-homeowner-insurance-cover-hail-damage-ohio', 'Does Insurance Cover Hail Damage?'],
    ['/blog/cincinnati-hail-season-2026', 'Cincinnati Hail Season Guide'],
    // 2026-10-06 SEO audit fix #8: the weakest helpful pages get town links.
    ['/blog/how-to-choose-a-roofer-after-a-storm', 'How to Choose a Roofer After a Storm'],
  ],
  'hail-damage-insurance-claim': [
    ['/blog/how-to-file-storm-damage-insurance-claim-ohio', 'How to File a Storm Claim in Ohio'],
    ['/blog/what-to-expect-roof-insurance-adjuster-visit', 'What the Adjuster Visit Looks Like'],
  ],
  'storm-damage': [
    ['/blog/how-to-file-storm-damage-insurance-claim-ohio', 'How to File a Storm Claim in Ohio'],
    ['/blog/how-long-roof-insurance-claim-ohio', 'How Long an Ohio Roof Claim Takes'],
    ['/services/emergency-roof-tarping', 'Emergency Roof Tarping'],
    ['/blog/how-to-choose-a-roofer-after-a-storm', 'How to Choose a Roofer After a Storm'],
  ],
  'roof-replacement': [
    ['/blog/how-much-does-roof-cost-cincinnati-2026', 'What a New Roof Costs in Cincinnati'],
    ['/blog/how-long-does-roof-replacement-take-cincinnati', 'How Long a Replacement Takes'],
  ],
  'roof-repair': [
    ['/blog/signs-your-roof-needs-replacement-vs-repair', 'Repair or Replace? The Signs'],
    ['/services/emergency-roof-tarping', 'Emergency Roof Tarping'],
    ['/services/roof-care-plan', 'Roof Care Plan'],
  ],
  'roof-inspection': [
    ['/blog/signs-your-roof-needs-replacement-vs-repair', 'Repair or Replace? The Signs'],
  ],
};

function cityName(slug) {
  const st = slug.endsWith('-ky') ? 'KY' : 'OH';
  const base = slug.replace(/-(oh|ky)$/, '');
  const name = base.split('-').map((w) => (w === 'mt' ? 'Mt.' : w[0].toUpperCase() + w.slice(1))).join(' ');
  return { name, st };
}

function dist(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

// Inventory: family prefix -> [citySlug...]
const files = fs.readdirSync(SVC);
const variants = {};
for (const fam of FAMILIES) variants[fam.prefix] = [];
for (const f of files) {
  const m = f.match(/^([a-z-]+)-([a-z-]+-(?:oh|ky))\.html$/);
  if (!m) continue;
  // longest-prefix family match
  const fam = FAMILIES.filter((x) => m[0].startsWith(x.prefix + '-'))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!fam) continue;
  const city = m[0].slice(fam.prefix.length + 1, -5);
  if (COORDS[city]) variants[fam.prefix].push(city);
}

const stats = { areaGeo: 0, hubs: 0, nearby: 0, skipped: [] };

// ── 1. real geo on area pages ──
for (const [slug, [lat, lon]] of Object.entries(COORDS)) {
  const file = path.join(DOCS, 'areas', slug + '.html');
  if (!fs.existsSync(file)) continue;
  const orig = fs.readFileSync(file, 'utf8');
  const next = orig.replace(
    /"latitude":\s*"39\.2",\s*"longitude":\s*"-84\.15"/g,
    `"latitude": "${lat.toFixed(2)}", "longitude": "${lon.toFixed(2)}"`
  );
  if (next !== orig) { fs.writeFileSync(file, next); stats.areaGeo++; }
}

// ── 2. hub "cities" sections ──
const hubCities = {};
for (const fam of FAMILIES) {
  (hubCities[fam.hub] = hubCities[fam.hub] || []).push(fam);
}
for (const [hub, fams] of Object.entries(hubCities)) {
  const file = path.join(SVC, hub);
  if (!fs.existsSync(file)) { stats.skipped.push('no-hub:' + hub); continue; }
  const orig = fs.readFileSync(file, 'utf8');
  if (orig.includes('data-nbd-cities="v1"')) continue;
  if (!orig.includes('</main>')) { stats.skipped.push('no-main:' + hub); continue; }
  const pills = [];
  for (const fam of fams) {
    for (const city of [...variants[fam.prefix]].sort()) {
      const { name, st } = cityName(city);
      pills.push(`<a href="/services/${fam.prefix}-${city}" style="display:inline-block;background:var(--off-white,#f5f3ef);border:1px solid var(--light-gray,#e8e5e0);border-radius:100px;padding:8px 16px;font-size:.8rem;font-weight:700;color:var(--navy-dark,#142a52);text-decoration:none">${fam.label} — ${name}, ${st}</a>`);
    }
  }
  if (!pills.length) continue;
  const section = `<section data-nbd-cities="v1" style="background:#fff;padding:48px 5%">
  <div style="max-width:1100px;margin:0 auto">
    <div class="eyebrow">City by City</div>
    <h2 class="sec-title">This Work, <span>Where You Live</span></h2>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:18px">
      ${pills.join('\n      ')}
    </div>
  </div>
</section>
`;
  fs.writeFileSync(file, orig.replace('</main>', section + '</main>'));
  stats.hubs++;
}

// ── 3. nearby-cities + guides on location pages ──
for (const fam of FAMILIES) {
  for (const city of variants[fam.prefix]) {
    const file = path.join(SVC, `${fam.prefix}-${city}.html`);
    const orig = fs.readFileSync(file, 'utf8');
    if (orig.includes('data-nbd-nearby="v1"')) continue;
    if (!orig.includes('</main>')) { stats.skipped.push('no-main:' + fam.prefix + '-' + city); continue; }
    const near = variants[fam.prefix]
      .filter((c) => c !== city)
      .sort((a, b) => dist(COORDS[a], COORDS[city]) - dist(COORDS[b], COORDS[city]))
      .slice(0, 6);
    const cards = near.map((c) => {
      const { name } = cityName(c);
      return `<a href="/services/${fam.prefix}-${c}" class="svc-card"><span class="svc-icon">${fam.icon}</span><span class="svc-name">${fam.label} in ${name}</span><span class="svc-arrow">→</span></a>`;
    });
    for (const [href, label] of GUIDES[fam.prefix] || []) {
      cards.push(`<a href="${href}" class="svc-card"><span class="svc-icon">📖</span><span class="svc-name">${label}</span><span class="svc-arrow">→</span></a>`);
    }
    const { name } = cityName(city);
    const section = `<section data-nbd-nearby="v1" style="background:#fff">
  <div class="section-inner">
    <div class="eyebrow">Beyond ${name}</div>
    <h2 class="sec-title">${fam.label} in <span>Nearby Cities</span></h2>
    <div class="svc-grid">
      ${cards.join('\n      ')}
    </div>
  </div>
</section>

`;
    fs.writeFileSync(file, orig.replace('</main>', section + '</main>'));
    stats.nearby++;
  }
}

console.log(JSON.stringify(stats, null, 1));
