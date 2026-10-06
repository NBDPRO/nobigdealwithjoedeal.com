/**
 * tests/homeowner-claims-honesty-2026-10-05.test.js
 *
 * WHY THIS EXISTS
 * ────────────────
 * The 2026-10-05 homeowner-site honesty audit found public claims the
 * business and the code do not back up:
 *   - the Pledge page promised "Lifetime workmanship coverage" on EVERY
 *     estimate, while the CRM (docs/pro/js/estimate-config.js) writes 1 year
 *     on an Economy roof, 2-5 years on gutters and other installs, and 0-1
 *     year on repairs;
 *   - /storm-check and /storm-report predicted the claim ("You likely have a
 *     claimable loss", "Strong claim potential … exactly what insurers act
 *     on") and a blog FAQ said "insurance should cover it regardless of age".
 *     Jo: never promise an insurance outcome;
 *   - the NBD Guarantee page said the Pledge lasts "Forever" while the Pledge
 *     page itself says "as long as I'm in business";
 *   - "7 years" / "Seven years" / "7+ years" mixed across ~300 pages;
 *   - "Licensed & Insured" on ~200 pages, but Jo has no Ohio or Kentucky
 *     registration number to back "Licensed" (Jo, 2026-10-05: "Fully
 *     insured" instead);
 *   - llms.txt claimed "Founded: 2024", which is not true (Jo, 2026-10-05).
 *
 * Each pin checks the CORRECTED wording is present AND the false wording is
 * gone from the whole homeowner tree, so a revert, a partial revert, or a new
 * page copied from an old one all go red. Text is compared with HTML and JS
 * comments stripped, so a comment that merely quotes the old phrase can
 * neither satisfy a presence pin nor trip an absence pin.
 *
 * HOMEOWNER TREE = every .html/.js/.json/.txt/.xml file under docs/ except
 * the CRM and private trees (pro/, admin/, sites/, dev/) and vendored
 * libraries. Owned by other in-flight changes and skipped ONLY for the
 * "Licensed" and years pins (listed in PENDING_OWNER below; drop an entry
 * once its PR lands): docs/index.html (home-page PR), the Roof Care Plan page, the nbd:partial
 * regions (partials PR) and llms-full.txt (regenerated at deploy from those
 * pages).
 *
 * Pure-Node, zero-dep. Run: node tests/homeowner-claims-honesty-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Comments out, so a pin reads only what ships to a visitor.
function stripComments(src, rel) {
  if (/\.js$/.test(rel)) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');
  }
  return src.replace(/<!--[\s\S]*?-->/g, ' ');
}
const PARTIAL = /<!-- nbd:partial ([\w-]+)[^>]*-->[\s\S]*?<!-- \/nbd:partial \1 -->/g;

const PENDING_OWNER = new Set([
  'index.html',
  'services/roof-care-plan.html',
  'llms-full.txt',
]);

const FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(DOCS, p).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (/^(pro|admin|sites|dev)$/.test(rel) || e.name === 'vendor' || e.name === 'node_modules') continue;
      walk(p);
    } else if (/\.(html|js|json|txt|xml)$/.test(e.name)) {
      const raw = fs.readFileSync(p, 'utf8');
      FILES.push({ rel, text: stripComments(raw, rel), own: stripComments(raw.replace(PARTIAL, ' '), rel) });
    }
  }
})(DOCS);

// [rel, matched text] for every hit of `re` (strict = whole tree; otherwise
// skip PENDING_OWNER files and partial regions).
function hits(re, strict) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const f of FILES) {
    if (!strict && PENDING_OWNER.has(f.rel)) continue;
    const t = strict ? f.text : f.own;
    let m; g.lastIndex = 0;
    while ((m = g.exec(t))) out.push(f.rel + ': ' + m[0]);
  }
  return out;
}
const show = (h) => h.slice(0, 5).map((x) => x.slice(0, 140)).join(' | ');

ok('walked a real homeowner tree (' + FILES.length + ' files)', FILES.length > 300);

// ── 1. Workmanship warranty: the Pledge page says what the CRM writes ──
console.log('\n1. workmanship warranty terms ↔ docs/pro/js/estimate-config.js');
{
  const CFG = require(path.join(DOCS, 'pro', 'js', 'estimate-config.js'));
  const lifetime = Object.keys(CFG.TIER_DISPLAY).filter((k) => !CFG.TIER_DISPLAY[k].warranty.workmanshipYears);
  const limited = Object.keys(CFG.TIER_DISPLAY).filter((k) => CFG.TIER_DISPLAY[k].warranty.workmanshipYears);
  const labels = lifetime.map((k) => CFG.TIER_DISPLAY[k].label);
  ok('code truth: Standard, Preferred and Elite are lifetime tiers', ['Standard', 'Preferred', 'Elite'].every((l) => labels.includes(l)), labels.join(','));
  ok('code truth: at least one roof tier is NOT lifetime (Economy)', limited.length > 0 && limited.every((k) => /^1-year/.test(CFG.tierWarrantyText(k, true))));
  const W = CFG.WORKMANSHIP_WARRANTY;
  ok('code truth: non-roof work carries a fixed-year (not lifetime) warranty', [W.gutter_system, W.install_default, W.repair].every((w) => w && Number.isFinite(w.years) && w.years > 0 && w.years < 10));
  const pledge = stripComments(read('docs/the-pledge/index.html'), 'x.html');
  const m = /the workmanship warranty for that job \(lifetime on our ([^;)]+) roofs; repairs, gutters and other work carry their own written terms\)/.exec(pledge);
  ok('the Pledge page names the job-specific warranty and the lifetime tiers', !!m);
  const named = m ? m[1].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean) : [];
  ok('...every tier it calls lifetime IS lifetime in the config', named.length >= 3 && named.every((l) => labels.includes(l)), named.join(','));
  ok('...and no fixed-year tier is called lifetime', limited.every((k) => !named.includes(CFG.TIER_DISPLAY[k].label)));
  const blanket = hits(/lifetime workmanship (coverage|warranty) on every (job|estimate|roof)|Every estimate spells out exactly what's covered and exactly what isn't\. Lifetime workmanship coverage/i, true);
  ok('no page promises lifetime workmanship on every job', blanket.length === 0, show(blanket));
}

// ── 2. Certifications ──────────────────────────────────────────────────
console.log('\n2. certifications: GAF Certified (System Plus), TAMKO Pro Gold, no OC cert, Hardie = membership');
{
  const ent = read('site-src/partials/schema-entity.html') + read('docs/about.html');
  ok('GAF Certified is claimed', /GAF Certified/.test(ent));
  ok('TAMKO Pro Gold is claimed', /TAMKO Pro Gold/.test(read('docs/about.html') + FILES.map((f) => f.rel.startsWith('services/') ? f.text : '').join('')));
  const me = hits(/[^.]{0,120}\bMaster Elite\b[^.]{0,120}/, true).filter((h) => !/requires|only|unless|isn|separate|not\b|n't|Silver Pledge|Golden Pledge/i.test(h));
  ok('no page claims GAF Master Elite (mentions only say it is required / not held)', me.length === 0, show(me));
  const oc = hits(/\b(I'm|I am|we're|we are|Joe is|NBD is|an?)\s+(an?\s+)?Owens Corning (Preferred|Platinum|certified|Certified)/i, true);
  ok('no page claims an Owens Corning certification', oc.length === 0, show(oc));
  const jh = hits(/James Hardie (Elite Preferred|Preferred Contractor|certified|Certified)/, true);
  ok('James Hardie is a membership (Alliance), never a certification', jh.length === 0, show(jh));
}

// ── 3. No insurance-outcome predictions anywhere under docs/ (not docs/pro) ─
console.log('\n3. no claim-outcome predictions');
{
  const bad = hits(/claimable loss|claim potential|insurers? act on|insurance should cover it regardless|full amount regardless of age|not a valid reason to deny|you have a valid claim\. Period/i, true);
  ok('no "claimable loss" / "claim potential" / "insurance should cover it regardless" anywhere', bad.length === 0, show(bad));
  const W = require(path.join(DOCS, 'pro', 'js', 'claim-wording-filter.js'));
  const ids = W.RULES.map((r) => r.id);
  ok('the public claim-wording gate carries the outcome rules', ids.includes('claim-outcome-prediction') && ids.includes('covers-regardless'));
  const sc = stripComments(read('docs/assets/js/storm-check.js'), 'x.js');
  const sr = stripComments(read('docs/assets/js/storm-report-page.js'), 'x.js');
  ok('/storm-check strong result recommends an inspection, not a claim', sc.includes("headline = 'Storm activity near you is worth a free inspection.'"));
  ok('/storm-report strong result recommends an inspection, not a claim', sr.includes("h: 'Severe storm activity near you — worth a free inspection.'"));
  // 2026-10-06 (Jo, #2233): "document anything claimable" predicted a claim
  // outcome (OH/KY wording rules). Neutral replacement pinned; the word is
  // banned anywhere in the page's shipped (comment-stripped) code.
  ok('/storm-report never says "claimable"', !/claimable/i.test(sr));
  ok('/storm-report middle verdict uses the neutral wording', sr.includes('Joe will get on the roof and document what he finds so you can decide your next step.'));
  const blog = read('docs/blog/my-roof-is-too-old-will-insurance-still-pay.html');
  ok('the old-roof FAQ answer says "it depends on your policy", visible AND in JSON-LD', (blog.match(/It depends on your policy\. If a covered peril like hail or wind caused the damage/g) || []).length === 2);
}

// ── 4. Years: one phrase ("7+ years"), no founding year ────────────────
console.log('\n4. years of experience + founding year');
{
  const bare = hits(/\b(?:7|[Ss]even) years (?:of|in) (?:prior )?(?:insurance )?restoration|Coming up on 7 years|\b(?:My|I have|with) 7 years\b/);
  ok('no bare "7 years" / "Seven years" experience line (it is "7+ years")', bare.length === 0, show(bare));
  const llms = read('docs/llms.txt');
  ok('llms.txt states 7+ years', (llms.match(/7\+ years/g) || []).length >= 3 && !/\b7 years\b/.test(llms));
  const founded = hits(/Founded:?\**\s*\d{4}|\bfounded (in|on) (19|20)\d\d\b|"foundingDate"|\bsince 202\d\b|\bestablished (in )?20\d\d\b/i, true)
    .filter((h) => !/^areas\/|towns\.json/.test(h) || /No Big Deal|NBD|Joe/.test(h));
  ok('no founding-year claim anywhere (llms.txt, JSON-LD, copy)', founded.length === 0, show(founded));
}

// ── 5. "Licensed": Jo has no OH/KY registration number ─────────────────
console.log('\n5. no "Licensed" claim (it is "Fully insured")');
{
  // A capital-L "Licensed" is a badge/label claim; the lowercase forms are
  // first-person claims. Advice ("pick anyone local, licensed …", "a licensed
  // public adjuster") passes.
  const lic = hits(/\bLicensed\b(?! under)/).concat(hits(/\b(?:we're|we are|I'm|I am|NBD is|Joe is|No Big Deal is|is)\s+(?:fully\s+)?licensed\b|\blicensed (?:roofing|roofer)\b|\bown licensed contractor\b|\bmy license\b|Kentucky licensing knowledge/i));
  ok('no homeowner page claims a license', lic.length === 0, show(lic));
  ok('the replacement is in place (service-page transparency strip)', /Fully insured/i.test(read('docs/services/gutter-cleaning.html')));
  ok('the transparency-strip generator emits "Fully insured", not "Licensed"', /Fully insured/.test(read('scripts/add-transparency-strip-services.js')) && !/Licensed/.test(read('scripts/add-transparency-strip-services.js')));
}

// ── 6. The Pledge lasts as long as Joe is in business ──────────────────
console.log('\n6. Pledge duration matches the Pledge page');
{
  const pledge = stripComments(read('docs/the-pledge/index.html'), 'x.html');
  ok('the Pledge page defines it: "as long as I\'m in business"', /as long as I'm in business and you own the home/.test(pledge));
  const forever = hits(/✓ Forever|reactive, forever|applies forever|free, forever|backed personally, forever|anytime, forever|Layer 2 · Forever|come back forever|honest answer forever/i);
  ok('no page says the Pledge lasts "forever"', forever.length === 0, show(forever));
  const g = stripComments(read('docs/services/the-nbd-guarantee/index.html'), 'x.html');
  ok('the Guarantee table says "While I\'m in business" in all three tiers', (g.match(/✓ While I&rsquo;m in business/g) || []).length === 3);
}

// ── 7. Pledge FAQ: JSON-LD questions = the visible questions ───────────
console.log('\n7. Pledge FAQ JSON-LD question text = visible text');
{
  const src = read('docs/the-pledge/index.html');
  const ld = [...src.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((j) => j['@type'] === 'FAQPage');
  const visible = [...src.matchAll(/<summary class="faq-q">([\s\S]*?)<\/summary>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim());
  const names = ld ? ld.mainEntity.map((q) => q.name) : [];
  const missing = names.filter((n) => !visible.includes(n));
  ok('every FAQPage question is a visible question, word for word', names.length >= 5 && missing.length === 0, missing.join(' | '));
}

// ── 8. Smaller items ───────────────────────────────────────────────────
console.log('\n8. financing, retired orange');
{
  const fin = hits(/several financing options/i, true);
  ok('no "several financing options" (financing is one marketplace, Acorn)', fin.length === 0, show(fin));
  ok('the Milford FAQ names Acorn Finance', /Financing is available through Acorn Finance/.test(read('docs/services/roof-replacement-milford-oh.html')));
  ok('roof-score.js uses no retired orange', !/#e8720c|#f08030/i.test(stripComments(read('docs/assets/js/roof-score.js'), 'x.js')));
}

// ── 9. "24-hour" means a 24-hour REPLY (what /inspect promises) ────────
// The nav label lives in site-src/partials/ (another PR); this pins the
// /inspect promise and the /free-tools card body copy only.
console.log('\n9. 24-hour promise = reply within 24 hours');
{
  const inspect = stripComments(read('docs/inspect.html'), 'x.html');
  ok('/inspect promises a reply within 24 hours', /within 24 (hours|hrs)/i.test(inspect));
  const tools = stripComments(read('docs/free-tools/index.html').replace(PARTIAL, ' '), 'x.html');
  const card = (/<a href="\/inspect" class="tool-card"[\s\S]*?<\/a>/.exec(tools) || [''])[0];
  ok('/free-tools inspection card exists', card.length > 0);
  ok('...and promises a reply within 24 hrs, not a 24-hour inspection', /reply within 24 hrs/.test(card) && /replies within 24 hours/.test(card) && !/24-H(ou)?r Inspection|inspection[^.<]{0,30}within 24 hours/i.test(card));
  ok('/inspect mini-footer copy is light on navy (>= 75% white)', /\.mini-footer p\{color:rgba\(255,255,255,\.(7[5-9]|[89]\d?)\)\}/.test(inspect));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
