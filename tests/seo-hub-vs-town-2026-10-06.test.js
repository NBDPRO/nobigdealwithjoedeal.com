/**
 * tests/seo-hub-vs-town-2026-10-06.test.js
 *
 * WHY THIS EXISTS
 * ────────────────
 * The 2026-10-06 SEO/AEO audit (issue 3, §1d) found six service hubs whose
 * titles said "<Service> Cincinnati OH" sitting next to the town page
 * "<Service> in Cincinnati, OH", so the hub and the Cincinnati page competed
 * for the same query. Jo approved the split the same day:
 *   hub       = <Service> + "Greater Cincinnati & Northern Kentucky/KY"
 *   town page = <Service> + "Cincinnati, OH"
 * and "free roof inspection (cincinnati)" belongs to /inspect, not the
 * /services/roof-inspection hub.
 *
 * Pins go red if a hub title/meta drifts back to "Cincinnati OH", a town
 * page loses its "in Cincinnati, OH", the inspection hub leads with "Free",
 * or a "free roof inspection" anchor points at the hub again. HTML comments
 * are stripped first.
 *
 * Pure-Node, zero-dep. Run: node tests/seo-hub-vs-town-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const read = (rel) => fs.readFileSync(path.join(DOCS, rel), 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
const one = (re, s) => { const m = re.exec(s); return m ? m[1] : ''; };
const dec = (s) => s.replace(/&amp;/g, '&');
const head = (src) => ({
  title: dec(one(/<title>([^<]*)<\/title>/, src)),
  desc: dec(one(/<meta name="description" content="([^"]*)"/, src)),
  og: dec(one(/<meta property="og:title" content="([^"]*)"/, src)),
  tw: dec(one(/<meta name="twitter:title" content="([^"]*)"/, src)),
  ogd: dec(one(/<meta property="og:description" content="([^"]*)"/, src)),
  h1: dec(one(/<h1[^>]*>([\s\S]*?)<\/h1>/, src).replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
});

const HUBS = {
  'roof-repair': 'Roof Repair',
  'roof-inspection': 'Roof Inspection',
  'siding-repair': 'Siding Repair',
  'siding-replacement': 'Siding Replacement',
  'gutter-replacement': 'Gutter Replacement',
  'wood-siding-repair': 'Wood Siding Repair',
};
const REGION = /Greater Cincinnati & Northern (Kentucky|KY)/;

console.log('1. hubs target the region, town pages target Cincinnati, OH');
for (const [slug, svc] of Object.entries(HUBS)) {
  const hub = head(read('services/' + slug + '.html'));
  const town = head(read('services/' + slug + '-cincinnati-oh.html'));
  ok(slug + ' hub: title = "' + svc + ' in Greater Cincinnati & Northern K…"', hub.title.startsWith(svc + ' in ') && REGION.test(hub.title), hub.title);
  ok(slug + ' hub: og/twitter titles carry the region', REGION.test(hub.og) && REGION.test(hub.tw), hub.og + ' | ' + hub.tw);
  ok(slug + ' hub: no "Cincinnati OH"/"Cincinnati, OH" in title, og, twitter, meta', !/Cincinnati,? OH\b/.test([hub.title, hub.og, hub.tw, hub.desc, hub.ogd].join(' | ')));
  ok(slug + ' hub: descriptions name Northern Kentucky', /Northern Kentucky/.test(hub.desc) && /Northern Kentucky/.test(hub.ogd), hub.desc);
  ok(slug + ' hub: og:description is about this service (not a copied roof-replacement line)', !/roof replacement/i.test(hub.ogd) || slug === 'roof-replacement', hub.ogd);
  ok(slug + '-cincinnati-oh: title and H1 = "' + svc + ' in Cincinnati, OH"', town.title.startsWith(svc + ' in Cincinnati, OH') && town.h1.startsWith(svc + ' in Cincinnati, OH'), town.title + ' / ' + town.h1);
  ok(slug + ': hub and town titles differ', hub.title !== town.title);
}

console.log('\n2. "free roof inspection" belongs to /inspect');
{
  const hub = head(read('services/roof-inspection.html'));
  ok('roof-inspection hub title and H1 do not lead with "Free"', !/^Free\b/i.test(hub.title) && !/^Free\b/i.test(hub.h1), hub.title + ' / ' + hub.h1);
  const bad = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(DOCS, p).split(path.sep).join('/');
      if (e.isDirectory()) { if (!/^(pro|admin|sites|dev)$/.test(rel)) walk(p); continue; }
      if (!e.name.endsWith('.html')) continue;
      const src = read(rel);
      for (const m of src.matchAll(/<a [^>]*href="\/services\/roof-inspection"[^>]*>([\s\S]*?)<\/a>/g)) {
        const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (/^free (roof )?inspection$/i.test(text)) bad.push(rel + ': ' + text);
      }
    }
  })(DOCS);
  ok('no "free (roof) inspection" anchor points at the hub (they go to /inspect)', bad.length === 0, bad.slice(0, 5).join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
