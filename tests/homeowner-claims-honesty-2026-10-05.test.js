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
 * 2026-10-06: the "Licensed" pin (section 5) no longer uses PENDING_OWNER —
 * #2203 fixed the partials and the SEO-audit PR fixed the homepage body and
 * regenerated llms-full.txt, so it reads the whole tree plus the partial and
 * generator sources. PENDING_OWNER now applies to the years pin only.
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

// ── 1. Written labor warranty: "up to 20 years, by package" ──────────
// 2026-10-06 (Jo's final warranty model): the site no longer calls any tier's
// labor warranty "lifetime". The written labor/workmanship warranty is by
// package, up to 20 years (Economy 1, Standard 5, Preferred 10, Elite 20);
// the Pledge is a separate promise; product warranties are the
// manufacturer's, per product/package. The old "code truth" pins against
// docs/pro/js/estimate-config.js were dropped here: that file still carries
// the older lifetime tiers and is the CRM's to update, not this page's.
console.log('\n1. written labor warranty terms on the Pledge page');
{
  const pledge = stripComments(read('docs/the-pledge/index.html'), 'x.html');
  ok('the Pledge page states the written labor warranty: up to 20 years, by package', /your written labor warranty \(up to 20 years, by package; repairs and smaller jobs carry their own written terms\)/.test(pledge));
  ok('...and the manufacturer warranty per product/package', /the manufacturer warranty per product\/package on materials/.test(pledge));
  ok('...and no longer calls any roof tier lifetime', !/lifetime on our [^;)]+ roofs/i.test(pledge));
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
  // STRICT since 2026-10-06 (#2203 + the SEO-audit PR): the whole tree —
  // partial regions, the homepage and llms-full.txt included. Nothing pending.
  const LIC_LABEL = /\bLicensed\b(?! under)/;
  const LIC_FIRST = /\b(?:we're|we are|I'm|I am|NBD is|Joe is|No Big Deal is|is)\s+(?:fully\s+)?licensed\b|\blicensed (?:roofing|roofer)\b|\bown licensed contractor\b|\bmy license\b|Kentucky licensing knowledge|\blicensed (?:and|&|&amp;) (?:fully )?insured\b/i; // the comma list ("pick anyone local, licensed, insured") is advice and passes
  const lic = hits(LIC_LABEL, true).concat(hits(LIC_FIRST, true));
  ok('no homeowner page claims a license (whole tree: partials, homepage, llms-full.txt)', lic.length === 0, show(lic));
  // The sources that stamp those pages can't bring it back either.
  const SRC = fs.readdirSync(path.join(ROOT, 'site-src', 'partials')).map((n) => 'site-src/partials/' + n)
    .concat(['scripts/build-town-pages.mjs', 'scripts/build-llms.mjs', 'scripts/build-projects.mjs', 'scripts/add-transparency-strip-services.js']);
  const srcHits = SRC.filter((rel) => { const t = stripComments(read(rel), rel.replace(/\.mjs$/, '.js')); return LIC_LABEL.test(t) || LIC_FIRST.test(t); });
  ok('no partial or page generator carries a "Licensed" claim', srcHits.length === 0, srcHits.join(', '));
  ok('the #org schema description says "Fully insured"', /"description": "[^"]*Fully insured[^"]*"/.test(read('site-src/partials/schema-entity.html')));
  const home = stripComments(read('docs/index.html'), 'x.html');
  ok('homepage FAQ asks "Are you insured and certified?" and answers "fully insured" (visible + JSON-LD)', (home.match(/Are you insured and certified\?/g) || []).length === 2 && (home.match(/No Big Deal is fully insured/g) || []).length === 2);
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

// ── 10. No promise about what the carrier pays or approves (2026-10-06) ─
// The Mason hail hero said "how to make sure your carrier pays what your
// Mason roof actually needs"; ~25 hail/storm/area pages sold the same result
// in other words ("what adjusters need to approve a complete scope",
// "Documentation is what gets a claim approved", "the threshold for full
// replacement under most policies", "build claims"). Jo: Joe inspects,
// photographs, documents and writes the estimate; what a claim pays is the
// insurer's call. The neutral line is "so you have clear photos and an
// itemized estimate to share with your insurer". Homeowner QUESTIONS ("How
// long does it take to get a claim approved?") and conditionals ("insurance
// covers the rest when a claim is approved") still pass.
console.log('\n10. no carrier-pays / claim-approval promises');
{
  const OUTCOME = new RegExp([
    /\b(make sure|ensure|so that)\b[^.;!?<]{0,40}\b(carriers?|insurers?|insurance|adjusters?)\b[^.;!?<]{0,30}\b(pays?|covers?|approves?)\b/,
    /\b(need|needs|require|requires)\b[^.;!?<]{0,25}\bto (approve|pay out)\b/,
    /\bgets? (a |the |your )?claims? approved\b(?!\s+in\b)/, // "get a claim approved in Ohio?" is the blog's question
    /\bgetting the claim paid\b/,
    /\bsupports? (the )?full replacement\b/,
    /\bthreshold (that triggers|for) full replacement\b/,
    /\bqualify as insurance work\b|\bstorm damage that qualifies for a claim\b|\boften qualifies for a claim\b/,
    /\bapproved at full value\b|\bpay out a legitimate claim in full\b/,
    /\bdifference between a partial and full approval\b/,
    /\binsurance companies take damage seriously and will pay\b/,
    /\bbuild claims\b/,
  ].map((r) => r.source).join('|'), 'i');
  const promise = hits(OUTCOME, true);
  ok('no homeowner page promises what the carrier pays or approves (whole tree)', promise.length === 0, show(promise));
  const SRC = ['scripts/merge-hail-claim-content.js', 'scripts/build-town-pages.mjs', 'site-src/data/towns.json']
    .concat(fs.readdirSync(path.join(ROOT, 'site-src', 'partials')).map((n) => 'site-src/partials/' + n));
  const srcHits = SRC.filter((rel) => OUTCOME.test(stripComments(read(rel), rel.replace(/\.mjs$/, '.js'))));
  ok('no partial, town data or page generator carries one either', srcHits.length === 0, srcHits.join(', '));
  const mason = stripComments(read('docs/services/hail-damage-mason-oh.html'), 'x.html');
  ok('the Mason hail page uses the neutral documentation line', /how to document every strike, so you have clear photos and an itemized estimate to share with your insurer\./.test(mason));
  const neutral = FILES.filter((f) => /so you have clear photos and an itemized estimate to share with your insurer/.test(f.text)).length;
  ok('the neutral line replaced the promises across the hail/storm/area pages (>= 20 files)', neutral >= 20, String(neutral));
}

// ── 11. Jo's final warranty model (2026-10-06) ─────────────────────────
// The NBD Pledge is a PROMISE on every job: "NBD Pledge: for as long as you
// own the home, we'll come back and make it right." It is never called a
// lifetime (workmanship) warranty. The written labor warranty is by package,
// up to 20 years. Manufacturer/product warranties are stated separately and
// are never called "lifetime". #2204/#2205/#2248/#2250 dropped the Pledge
// from trust rows, town pages and meta descriptions; these pins put it back
// and keep it there. Text is read with comments stripped AND with tags
// replaced by a space, so a split like "Lifetime</div><div>Shingle Warranty"
// still trips the ban.
console.log('\n10. Pledge promise, written labor warranty, no "lifetime" warranty');
{
  const PROMISE = "NBD Pledge: for as long as you own the home, we'll come back and make it right";
  const untag = (t) => t.replace(/<[^>]+>/g, ' ').replace(/&rsquo;|&#8217;|’/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  // "lifetime" glued to a warranty word, with any product qualifiers between.
  const LIFETIME_WARRANTY = [
    /\blifetime[\s-]+(?:(?:limited|material|manufacturer|shingle|functionality|workmanship|labor|product|designer)[\s-]+)*(?:warrant\w*|coverage|guarantee)/i,
    /\blimited[\s-]+lifetime\b/i,
    /\blifetime[\s-]+(?:limited|functionality|workmanship)\b/i,
    /\bwarrant(?:y|ies)\s*:?\s*lifetime\b/i,
    /\bLIFETIME\s+Labor\b/i,
  ];
  const textOf = (raw, rel) => { const t = stripComments(raw, rel); return [t, untag(t)]; };
  const scan = (rel, raw) => {
    const out = [];
    for (const t of textOf(raw, rel)) for (const re of LIFETIME_WARRANTY) { const m = re.exec(t); if (m) out.push(rel + ': ' + t.slice(Math.max(0, m.index - 40), m.index + 60)); }
    return out;
  };
  // Whole homeowner tree (partial regions, homepage and llms-full.txt included)
  // plus the sources and generators that stamp those pages.
  const SRC = fs.readdirSync(path.join(ROOT, 'site-src', 'partials')).map((n) => 'site-src/partials/' + n)
    .concat(['site-src/data/towns.json', 'scripts/build-town-pages.mjs', 'scripts/build-llms.mjs', 'scripts/build-projects.mjs']);
  const bad = [];
  for (const f of FILES) bad.push(...scan(f.rel, fs.readFileSync(path.join(DOCS, f.rel), 'utf8')));
  for (const rel of SRC) bad.push(...scan(rel, read(rel)));
  ok('no "lifetime warranty" / "lifetime workmanship" / lifetime product warranty anywhere on the homeowner site or its sources', bad.length === 0, show([...new Set(bad)]));

  // The Pledge is a promise, not workmanship coverage.
  const asCoverage = hits(/(?:NBD |The )?Pledge on (?:my |all )?(?:installation )?workmanship|workmanship is covered (?:separately )?by (?:<a [^>]*>)?The Pledge/i, true);
  ok('the Pledge is never described as the workmanship coverage', asCoverage.length === 0, show(asCoverage));

  // The promise wording, word for word, where the Pledge is defined.
  const vis = (rel) => untag(stripComments(read(rel).replace(PARTIAL, ' '), rel));
  for (const rel of ['docs/the-pledge/index.html', 'docs/services/roof-replacement.html', 'docs/services/gutter-replacement.html', 'docs/services/siding-replacement.html', 'docs/services/roof-repair.html', 'docs/services/siding-repair.html']) {
    ok(rel.replace('docs/', '') + ' states the Pledge promise word for word', vis(rel).includes(PROMISE));
  }
  // The Pledge appears on the roofing, gutters and siding pages (page body, not just nav/footer partials).
  for (const rel of ['docs/services/roof-replacement.html', 'docs/services/roof-repair.html', 'docs/services/gutter-replacement.html', 'docs/services/siding-replacement.html', 'docs/services/siding-repair.html', 'docs/services/wood-siding-repair.html']) {
    ok(rel.replace('docs/', '') + ' names the NBD Pledge in its own body', /\b(?:NBD|The) Pledge\b/.test(vis(rel)));
  }
  // Where warranty terms are discussed: the written labor warranty by package.
  for (const rel of ['docs/the-pledge/index.html', 'docs/services/the-nbd-guarantee/index.html', 'docs/services/roof-replacement.html', 'docs/services/gutter-replacement.html', 'docs/services/siding-replacement.html', 'docs/llms.txt']) {
    ok(rel.replace('docs/', '') + ' says "written labor warranty up to 20 years, by package"', /written labor warranty \(?up to 20 years, by package/i.test(vis(rel)));
  }
  // Restored by this PR after #2204 / #2248 / #2250 dropped them.
  for (const s of ['hail-damage-insurance-claim', 'roof-cleaning-soft-wash', 'roof-inspection']) {
    ok(s + ': the hero proof row carries "Backed by the NBD Pledge"', /<ul class="svc-proof">[^\n]*<li>Backed by the NBD Pledge<\/li><\/ul>/.test(read('docs/services/' + s + '.html')));
  }
  for (const t of ['batavia', 'loveland', 'mason', 'west-chester']) {
    const src = read('docs/services/roof-replacement-' + t + '-oh.html');
    ok('roof-replacement-' + t + ': included list + schema carry the Pledge', /<strong>The NBD Pledge\.<\/strong> For as long as you own the home, we'll come back and make it right\./.test(src) && /"description": "Roof replacement in [^"]*Backed by the NBD Pledge\."/.test(src));
  }
  const TOWNS = ['hail-damage-batavia', 'hail-damage-cincinnati', 'hail-damage-loveland', 'hail-damage-maineville', 'hail-damage-mason', 'hail-damage-west-chester',
    'storm-damage-batavia', 'storm-damage-cincinnati', 'storm-damage-fayetteville', 'storm-damage-loveland', 'storm-damage-mason', 'storm-damage-west-chester'];
  const noMeta = TOWNS.filter((t) => { const m = /<meta name="description" content="([^"]*)"/.exec(read('docs/services/' + t + '-oh.html')); return !m || !/NBD Pledge/.test(m[1]) || m[1].length > 160; });
  ok('hail/storm town pages: meta description names the NBD Pledge (<= 160 chars)', noMeta.length === 0, noMeta.join(', '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
