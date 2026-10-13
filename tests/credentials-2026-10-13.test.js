/**
 * tests/credentials-2026-10-13.test.js - guard for the /credentials page, the
 * credentials strip and their JSON-LD (all generated from
 * docs/assets/data/credentials.json by scripts/build-credentials.mjs).
 *
 * WHAT THIS PROTECTS
 *   A public credential is a claim. Four ways it goes wrong, each pinned here:
 *     1. a row that is not active (pending approval, expired) leaks onto the
 *        page, the strip or the JSON-LD;
 *     2. a rendered row has no plain summary or no approved wording;
 *     3. the honesty words come back (Master Elite / President's Club as a
 *        claim, "Licensed" anywhere on a credential surface) - Jo's rule is
 *        "Fully insured";
 *     4. a warranty or rebate promise rides in on a row nobody verified (the
 *        IKO row is text-only until Jo supplies the fields).
 *
 * METHOD
 *   Rendering rules are proven on a FIXTURE: the generator is copied into a
 *   throwaway mirror of the tree with a hostile data file, run, and its output
 *   read back. Each absence assertion is paired with a presence control (an
 *   active fixture row DOES render), so a harness that renders nothing cannot
 *   pass. Then the real tree's committed output is checked.
 *
 * Pure Node, no deps. Run: node tests/credentials-2026-10-13.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const GEN = path.join(ROOT, 'scripts', 'build-credentials.mjs');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' - ' + detail : '')); failed++; }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

const data = JSON.parse(read('docs/assets/data/credentials.json'));
const rows = data.credentials;
const active = rows.filter((r) => r.status === 'active');

// ── fixture harness ──────────────────────────────────────────────────────
function mirror(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-cred-'));
  const put = (rel, text) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  put('scripts/build-credentials.mjs', fs.readFileSync(GEN, 'utf8'));
  put('site-src/partials/credentials-strip.html', read('site-src/partials/credentials-strip.html'));
  put('docs/credentials.html', read('docs/credentials.html'));
  put('docs/home.html', '<html><body>\n<!-- CREDENTIALS-STRIP-START -->\n<!-- CREDENTIALS-STRIP-END -->\n</body></html>\n');
  for (const r of rows) if (r.badge) {
    const p = path.join(dir, 'docs', r.badge);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(path.join(DOCS, r.badge), p);
  }
  const fixture = JSON.parse(JSON.stringify(data));
  mutate(fixture);
  put('docs/assets/data/credentials.json', JSON.stringify(fixture, null, 2));
  const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'build-credentials.mjs')], { encoding: 'utf8' });
  const outPage = fs.readFileSync(path.join(dir, 'docs/credentials.html'), 'utf8');
  const outHome = fs.readFileSync(path.join(dir, 'docs/home.html'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { run, outPage, outHome, all: outPage + '\n' + outHome };
}
const baseRow = (o) => Object.assign({
  id: 'zz-fixture', name: 'ZZ Fixture Certification', issuer: 'ZZ Issuer', type: 'manufacturer',
  status: 'active', summary: 'ZZ fixture summary sentence.', claimWording: 'ZZ Fixture Wording',
  confirmedBy: 'Test', confirmedAt: '2026-10-13', order: 900, showInStrip: false,
}, o);

// ── 1. the real data validates and every surface is current ──────────────
console.log('credentials data + generated surfaces');
{
  const r = spawnSync(process.execPath, [GEN, '--check'], { encoding: 'utf8' });
  ok('build-credentials --check passes (schema valid, every surface current)', r.status === 0, (r.stdout + r.stderr).trim().split('\n')[0]);
}

// ── 2. non-active rows never render (fixture, with presence control) ─────
console.log('\npending / expired rows are never rendered');
{
  const f = mirror((d) => {
    d.credentials.forEach((c) => { c.showInStrip = c.id === 'gaf-certified'; });
    d.credentials.push(baseRow({ id: 'zz-active', name: 'ZZACTIVE Card', claimWording: 'ZZACTIVE wording', showInStrip: true, order: 901 }));
    d.credentials.push(baseRow({ id: 'zz-pending', name: 'ZZPENDING Card', claimWording: 'ZZPENDING wording', status: 'pending', showInStrip: true, order: 902 }));
    d.credentials.push(baseRow({ id: 'zz-expired', name: 'ZZEXPIRED Card', claimWording: 'ZZEXPIRED wording', status: 'expired', showInStrip: true, order: 903, contractorId: '9990001' }));
  });
  ok('fixture generator run succeeded', f.run.status === 0, (f.run.stdout + f.run.stderr).trim());
  ok('POSITIVE CONTROL: the active fixture row renders in the cards', /ZZACTIVE Card/.test(f.outPage));
  ok('POSITIVE CONTROL: the active fixture row renders in the strip', /ZZACTIVE wording/.test(f.outHome));
  ok('POSITIVE CONTROL: the active fixture row is in the JSON-LD', /"@id": "https:\/\/nobigdealwithjoedeal\.com\/credentials#zz-active"/.test(f.outPage));
  ok('pending row absent from page, strip and JSON-LD', !/ZZPENDING|zz-pending/.test(f.all));
  ok('expired row (and its ID) absent from page, strip and JSON-LD', !/ZZEXPIRED|zz-expired|9990001/.test(f.all));
  ok('strip capped at 3: a 4th flagged active row -> generator refuses',
    mirror((d) => { d.credentials.push(baseRow({ id: 'zz-s0', order: 910, showInStrip: true })); }).run.status === 1);
}

// ── 3. validator refusals (each is a break-test of one rule) ─────────────
console.log('\ngenerator validator');
function refuses(label, mutate, needle) {
  const f = mirror(mutate);
  const msg = f.run.stdout + f.run.stderr;
  ok(label, f.run.status === 1 && needle.test(msg), `exit ${f.run.status}: ${msg.trim().split('\n').slice(0, 3).join(' / ')}`);
}
refuses('an active row without a summary is refused', (d) => d.credentials.push(baseRow({ summary: '' })), /non-empty summary/);
refuses('an active row without approved claimWording is refused', (d) => { const r = baseRow({}); delete r.claimWording; d.credentials.push(r); }, /non-empty claimWording/);
refuses('"Master Elite" is refused in any field', (d) => d.credentials.push(baseRow({ summary: 'A GAF Master Elite contractor.' })), /forbidden claim word/);
refuses('"President\'s Club" is refused', (d) => d.credentials.push(baseRow({ name: "GAF President's Club" })), /forbidden claim word/);
refuses('"Licensed" is refused', (d) => d.credentials.push(baseRow({ claimWording: 'Licensed & insured' })), /forbidden claim word/);
refuses('a warranty string without warrantyVerified is refused', (d) => d.credentials.push(baseRow({ summary: 'Unlocks a 50-year warranty on every job.' })), /warrantyVerified/);
refuses('a rebate string without warrantyVerified is refused', (d) => d.credentials.push(baseRow({ summary: 'Earns you a manufacturer rebate.' })), /warrantyVerified/);
{
  const f = mirror((d) => d.credentials.push(baseRow({ summary: 'Qualifying installs are eligible for the manufacturer warranty.', warrantyVerified: true })));
  ok('POSITIVE CONTROL: the same warranty string passes once warrantyVerified is true', f.run.status === 0, (f.run.stdout + f.run.stderr).trim());
}
refuses('an unknown field (a cost or margin key) is refused', (d) => d.credentials.push(baseRow({ materialCost: 1200 })), /unknown field "materialCost"/);
refuses('a duplicate id is refused', (d) => d.credentials.push(baseRow({ id: 'gaf-certified', order: 950 })), /duplicate id/);
refuses('a non-https verifyUrl is refused', (d) => d.credentials.push(baseRow({ verifyUrl: 'http://example.test/x' })), /verifyUrl must be an https URL/);
refuses('a badge that does not exist is refused', (d) => d.credentials.push(baseRow({ badge: '/assets/gaf/nope.png', badgeAlt: 'x' })), /does not exist/);

// ── 4. real-tree rendered output ─────────────────────────────────────────
console.log('\nrendered output (committed tree)');
const page = read('docs/credentials.html');
const pageBody = stripComments(page);
const cardsRegion = (page.match(/<!-- CREDENTIALS-CARDS-START -->([\s\S]*?)<!-- CREDENTIALS-CARDS-END -->/) || [])[1] || '';
const pageNoEntity = page.replace(/<!-- nbd:partial schema-entity -->[\s\S]*?<!-- \/nbd:partial schema-entity -->/, '');
const ldMatches = [...pageNoEntity.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok('the cards region exists and is not empty', cardsRegion.trim().length > 200);
for (const r of active) {
  ok(`active row ${r.id}: summary + approved wording present in data`, !!(r.summary && r.claimWording && r.confirmedBy && r.confirmedAt));
  ok(`active row ${r.id}: its card renders with its summary`, cardsRegion.includes(`id="${r.id}"`) && cardsRegion.includes(r.summary.replace(/&/g, '&amp;')));
}
for (const r of rows.filter((x) => x.status !== 'active')) {
  ok(`non-active row ${r.id}: absent from the page`, !pageBody.includes(r.name) && !pageBody.includes(r.claimWording));
}
ok('groups in order: Manufacturer certifications, then Insured',
  cardsRegion.indexOf('Manufacturer certifications') > -1
  && cardsRegion.indexOf('Insured') > cardsRegion.indexOf('Manufacturer certifications'));
ok('no empty group heading (Materials we install is omitted while no supplier-material row is active)',
  active.some((r) => r.type === 'supplier-material') === /Materials we install/.test(cardsRegion));

// honesty words
const FORBID_PAT = /master\s*elite|president['’]?s\s*club|\blicensed\b/i;
const surfaces = {
  'credentials.html': pageBody,
  'credentials.json': read('docs/assets/data/credentials.json'),
  'index.html strip': (read('docs/index.html').match(/<!-- CREDENTIALS-STRIP-START -->[\s\S]*?<!-- CREDENTIALS-STRIP-END -->/) || [''])[0],
  'about.html strip': (read('docs/about.html').match(/<!-- CREDENTIALS-STRIP-START -->[\s\S]*?<!-- CREDENTIALS-STRIP-END -->/) || [''])[0],
};
ok('POSITIVE CONTROL: the honesty pattern catches the bad phrases',
  FORBID_PAT.test('We are GAF Master Elite') && FORBID_PAT.test("President’s Club") && FORBID_PAT.test('Licensed & insured') && !FORBID_PAT.test('Fully insured'));
for (const [name, text] of Object.entries(surfaces)) {
  ok(`${name}: no Master Elite / President's Club / Licensed`, text.length > 0 && !FORBID_PAT.test(text));
}
// Site-wide: Master Elite / President's Club may appear ONLY as a disclaimer
// ("Golden Pledge requires Master Elite - I'm GAF Certified").
const NEGATED = /\b(isn['’]t|isnt|not|requires?|separate|aren['’]t|n['’]t|isn&rsquo;t|isn&#39;t|no|don['’]t|unless|never|except)\b/i;
function affirmativeMentions(text) {
  const bad = [];
  const re = /master\s*elite|president(?:['’]|&rsquo;|&#39;)?s\s*club/gi;
  let m;
  while ((m = re.exec(text))) {
    const ctx = text.slice(Math.max(0, m.index - 170), m.index + 170);
    if (!NEGATED.test(ctx)) bad.push(ctx.replace(/\s+/g, ' ').trim());
  }
  return bad;
}
ok('POSITIVE CONTROL: an affirmative "we are Master Elite" is flagged, a disclaimer is not',
  affirmativeMentions('Proudly we are a GAF Master Elite roofer.').length === 1
  && affirmativeMentions('Golden Pledge requires Master Elite; I am GAF Certified, which is a separate tier.').length === 0);
{
  const skip = new Set(['pro', 'admin', 'dev', 'sites']);
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (d === DOCS && skip.has(e.name)) continue; walk(p); }
      else if (/\.(html|txt|json|js|xml)$/.test(e.name)) {
        const t = fs.readFileSync(p, 'utf8');
        if (!/master\s*elite|club/i.test(t)) continue;
        for (const ctx of affirmativeMentions(t)) hits.push(path.relative(ROOT, p).replace(/\\/g, '/') + ': ' + ctx.slice(0, 120));
      }
    }
  })(DOCS);
  ok('no page claims Master Elite / President\'s Club (disclaimers only)', hits.length === 0, hits.slice(0, 3).join(' | '));
}

// GAF row keeps its verify URL and ID
const gaf = rows.find((r) => r.id === 'gaf-certified');
ok('GAF row: contractor ID 1162011 and the contractor-specific verify URL',
  gaf && gaf.contractorId === '1162011'
  && gaf.verifyUrl === 'https://www.gaf.com/en-us/roofing-contractors/residential/usa/oh/goshen/no-big-deal-home-solutions-1162011');
ok('GAF card on the page shows the ID and links the verify URL with target=_blank rel=noopener',
  /GAF contractor ID <b>1162011<\/b>/.test(cardsRegion)
  && new RegExp('<a class="cred-verify" href="' + gaf.verifyUrl.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '" target="_blank" rel="noopener">').test(cardsRegion));
ok('GAF row is not labelled with a program tier GAF has not granted', !/master\s*elite|president|golden pledge/i.test(JSON.stringify(gaf)));

// IKO: text-only until Jo supplies the fields
const iko = rows.find((r) => r.id === 'iko-roofpro-advantage');
ok('IKO row exists and is text-only: no badge, ID, verify URL, warranty or rebate field',
  iko && !iko.badge && !iko.contractorId && !iko.verifyUrl && iko.warrantyVerified !== true);
const ikoCard = (cardsRegion.match(/<article class="cred-card" id="iko-roofpro-advantage">[\s\S]*?<\/article>/) || [''])[0];
ok('IKO card renders (control) with no image, no ID line and no verify link', ikoCard.length > 50 && !/<img/.test(ikoCard) && !/cred-id|cred-verify/.test(ikoCard));
ok('IKO card carries no warranty / rebate wording', ikoCard.length > 50 && !/warrant|rebate/i.test(ikoCard));
ok('IKO wording TODO is not rendered anywhere public', !/_todo|pending final confirmation/i.test(pageBody));
{
  // the rule itself: any rendered row that mentions warranty/rebate needs warrantyVerified
  const offenders = active.filter((r) => /warrant|rebate/i.test([r.name, r.summary, r.claimWording].join(' ')) && r.warrantyVerified !== true);
  ok('every rendered warranty/rebate string sits on a warrantyVerified row', offenders.length === 0, offenders.map((r) => r.id).join(','));
}

// insurance wording
const ins = rows.find((r) => r.type === 'insurance' && r.status === 'active');
ok('insurance row says "Fully insured" and publishes no carrier, limits or policy number',
  ins && ins.claimWording === 'Fully insured'
  && !/carrier|policy\s*(no|number|#)|\$\s?\d|limit/i.test(JSON.stringify(ins) + cardsRegion.match(/id="fully-insured"[\s\S]*?<\/article>/)));

// ── 5. JSON-LD ────────────────────────────────────────────────────────────
console.log('\nJSON-LD');
{
  const blocks = [];
  let parseOk = ldMatches.length > 0;
  for (const raw of ldMatches) { try { blocks.push(JSON.parse(raw)); } catch (e) { parseOk = false; } }
  ok('credentials.html carries JSON-LD and every block parses', parseOk);
  const nodes = blocks.flatMap((b) => (b['@graph'] ? b['@graph'] : [b]));
  const entityScoped = nodes.filter((n) => n['@id']);
  const ids = entityScoped.map((n) => n['@id']);
  ok('every @id is unique', new Set(ids).size === ids.length);
  const creds = nodes.filter((n) => n['@type'] === 'EducationalOccupationalCredential');
  const expectedCreds = active.filter((r) => r.type === 'manufacturer');
  ok('one credential node per active manufacturer row (insurance has no schema.org credential type)',
    creds.length === expectedCreds.length && expectedCreds.every((r) => ids.includes('https://nobigdealwithjoedeal.com/credentials#' + r.id)));
  ok('no node is a second Organization/business: only references to #org', !nodes.some((n) => /^(RoofingContractor|LocalBusiness)$/.test(String(n['@type'])))
    && nodes.filter((n) => n.about && n.about['@id'] === 'https://nobigdealwithjoedeal.com/#org').length === 1);
  const gafNode = creds.find((n) => /GAF/.test(n.name));
  ok('GAF credential node carries identifier 1162011 and the verify url', gafNode && gafNode.identifier === '1162011' && gafNode.url === gaf.verifyUrl);
  ok('IKO credential node has no identifier, url or warranty text',
    (() => { const n = creds.find((x) => /IKO/.test(x.name)); return n && !n.identifier && !n.url && !/warrant|rebate/i.test(JSON.stringify(n)); })());
  const listed = (nodes.find((n) => n['@type'] === 'CollectionPage') || {}).mainEntity;
  ok('ItemList references exactly the credential nodes', listed && listed.itemListElement.every((e) => ids.includes(e.item['@id'])) && listed.itemListElement.length === creds.length);
}

// ── 6. the strip ──────────────────────────────────────────────────────────
console.log('\nstrip');
{
  const stripRows = active.filter((r) => r.showInStrip);
  ok(`strip membership: ${stripRows.length} flagged row(s), at most 3`, stripRows.length >= 1 && stripRows.length <= 3);
  for (const [name, t] of [['index.html', surfaces['index.html strip']], ['about.html', surfaces['about.html strip']]]) {
    const chips = (t.match(/class="cred-chip"/g) || []).length;
    ok(`${name} strip renders exactly the flagged rows (${stripRows.length}), <= 3`, chips === stripRows.length && chips <= 3);
    ok(`${name} strip links /credentials and each chip's detail anchor`,
      /href="\/credentials"/.test(t) && stripRows.every((r) => t.includes(`href="/credentials#${r.id}"`)));
    ok(`${name} strip keeps GAF's verify link (target=_blank rel=noopener)`,
      t.includes(`href="${gaf.verifyUrl}" target="_blank" rel="noopener"`));
    ok(`${name} strip shows no non-strip row`, !stripRows.length || active.filter((r) => !r.showInStrip).every((r) => !t.includes(r.claimWording)));
  }
  // the hand-placed badge row the strip replaced is gone from the homepage trust section
  ok('homepage no longer hand-places the GAF/TAMKO badge row (hh-badges)', !/class="hh-badges"/.test(read('docs/index.html')));
  ok('about.html has no hand-placed "GAF Certified Contractor" / "Fully Insured" pills next to the strip',
    !/<div class="cred">GAF® Certified Contractor<\/div>/.test(read('docs/about.html')) && !/<div class="cred">Fully Insured<\/div>/.test(read('docs/about.html')));
}

// ── 7. page contract + wiring ─────────────────────────────────────────────
console.log('\npage contract and wiring');
{
  ok('exactly one <h1>', (pageBody.match(/<h1[\s>]/g) || []).length === 1);
  ok('canonical points at /credentials', /<link rel="canonical" href="https:\/\/nobigdealwithjoedeal\.com\/credentials">/.test(page));
  ok('meta description is present and 120-160 chars', (() => { const m = page.match(/<meta name="description" content="([^"]*)"/); return m && m[1].length >= 120 && m[1].length <= 160; })());
  ok('Open Graph title, description and url are set', ['og:title', 'og:description', 'og:url'].every((p) => page.includes(`<meta property="${p}"`)));
  ok('the schema-entity partial is stamped (the one #org lives there)', /<!-- nbd:partial schema-entity -->/.test(page));
  const main = (pageBody.match(/<main[\s\S]*?<\/main>/) || [''])[0];
  const body = main.replace(/<!-- nbd:partial[\s\S]*?<!-- \/nbd:partial [a-z-]+ -->/g, '');
  const own = (page.match(/<section class="cred-hero">[\s\S]*?<\/main>/) || [''])[0];
  ok('the page body adds no inline style attributes and no on* handlers', own.length > 500 && !/\sstyle\s*=/.test(own) && !/\son[a-z]+\s*=/.test(own));
  ok('the page body adds no inline <script>', !/<script(?![^>]*\bsrc=)/.test(body.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')));
  ok('links to its stylesheet', /href="\/assets\/css\/credentials\.css/.test(page));
  ok('credentials.css exists and keeps 44px targets', (() => { const c = read('docs/assets/css/credentials.css'); return /min-height:\s*44px/.test(c); })());
  ok('sitemap.xml lists /credentials', /<loc>https:\/\/nobigdealwithjoedeal\.com\/credentials<\/loc>/.test(read('docs/sitemap.xml')));
  ok('build-sitemap.js has a CORE_PAGES row for it', /\['credentials',\s*'credentials\.html'/.test(read('scripts/build-sitemap.js')));
  ok('llms.txt links /credentials', read('docs/llms.txt').includes('https://nobigdealwithjoedeal.com/credentials'));
  ok('footer-extended and footer-blog partials link /credentials', ['footer-extended', 'footer-blog'].every((p) => read(`site-src/partials/${p}.html`).includes('href="/credentials"')));
  ok('no footer partial gained a Pro link for this page (one silent Pro door)',
    ['footer-extended', 'footer-blog', 'footer-standard', 'footer-area'].every((p) => (read(`site-src/partials/${p}.html`).match(/href="\/pro\/?"/g) || []).length <= 1));
  ok('about.html links to /credentials', /href="\/credentials/.test(read('docs/about.html')));
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
