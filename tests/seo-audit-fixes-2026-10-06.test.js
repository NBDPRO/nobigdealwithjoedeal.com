/**
 * tests/seo-audit-fixes-2026-10-06.test.js
 *
 * WHY THIS EXISTS
 * ────────────────
 * The 2026-10-06 SEO/AEO audit (Jo approved the fixes the same day) found:
 *   - a blog title that promised a claim outcome ("The Walkaround That Wins
 *     Claims"), against the no-insurance-outcome rule;
 *   - 26 towns whose hail-damage and storm-damage pages targeted the same
 *     thing in the title and H1 ("… & Insurance Claims in <Town>"), so the
 *     two pages competed for one query;
 *   - 0 of 193 service/area pages with a freshness date (visible or schema);
 *   - the weakest helpful pages (storm-roofer guide, emergency tarping, Roof
 *     Care Plan) with almost no internal links.
 * Each pin below goes red if the fix is reverted, partially reverted, or a
 * new page is copied from an old one. Text is compared with HTML comments
 * stripped, so a comment quoting the old wording cannot satisfy or trip a pin.
 *
 * Pure-Node, zero-dep. Run: node tests/seo-audit-fixes-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SVC = path.join(DOCS, 'services');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');
const readDoc = (rel) => strip(fs.readFileSync(path.join(DOCS, rel), 'utf8'));
const one = (re, s) => { const m = re.exec(s); return m ? m[1] : null; };
const show = (a) => a.slice(0, 5).join(' | ');

// Homeowner tree (same scope as homeowner-claims-honesty): docs/ minus the
// CRM/private trees and vendored code.
const TREE = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(DOCS, p).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (/^(pro|admin|sites|dev)$/.test(rel) || e.name === 'vendor' || e.name === 'node_modules') continue;
      walk(p);
    } else if (/\.(html|js|json|txt|xml)$/.test(e.name)) {
      const raw = fs.readFileSync(p, 'utf8');
      TREE.push({ rel, text: /\.js$/.test(rel) ? raw.replace(/\/\*[\s\S]*?\*\//g, ' ') : strip(raw) });
    }
  }
})(DOCS);
ok('walked a real homeowner tree (' + TREE.length + ' files)', TREE.length > 300);

// ── 1. No claim-outcome blog title ─────────────────────────────────────
console.log('\n1. hail-prep post: documentation title, no "wins claims"');
{
  const bad = [];
  for (const f of TREE) {
    const re = /\bwins? (?:your |the |more )?(?:insurance )?claims?\b/gi;
    let m; while ((m = re.exec(f.text))) bad.push(f.rel + ': ' + m[0]);
  }
  ok('no page or feed says a walkaround/anything "wins claims"', bad.length === 0, show(bad));
  const post = readDoc('blog/hail-season-prep-checklist.html');
  const title = one(/<title>([^<]*)<\/title>/, post) || '';
  const h1 = (one(/<h1>([\s\S]*?)<\/h1>/, post) || '').replace(/<[^>]+>/g, '');
  const og = one(/<meta property="og:title" content="([^"]*)"/, post) || '';
  ok('post <title> is about documenting the roof', /Document Your Roof/.test(title), title);
  ok('post H1 is about documenting the roof', /Document Your Roof/.test(h1), h1);
  ok('og:title is about documenting the roof', /Documents Your Roof/.test(og), og);
  const posts = fs.readFileSync(path.join(DOCS, 'assets/js/inline/c00f1acac9.js'), 'utf8');
  ok('POSTS array carries the same headline as og:title', posts.includes('title: "' + og + '"'));
  ok('the URL is unchanged (slug carries no claim)', /<link rel="canonical" href="https:\/\/nobigdealwithjoedeal\.com\/blog\/hail-season-prep-checklist">/.test(post));
}

// ── 2. Hail vs storm town pages target different things ────────────────
console.log('\n2. hail vs storm town pages: distinct titles, H1s and meta');
{
  const towns = fs.readdirSync(SVC)
    .map((f) => /^hail-damage-(.+-(?:oh|ky))\.html$/.exec(f))
    .filter((m) => m && !m[1].startsWith('insurance-claim'))
    .map((m) => m[1])
    .filter((t) => fs.existsSync(path.join(SVC, 'storm-damage-' + t + '.html')));
  ok('found the town pairs (' + towns.length + ')', towns.length >= 26);
  const bad = [];
  for (const t of towns) {
    const h = readDoc('services/hail-damage-' + t + '.html');
    const s = readDoc('services/storm-damage-' + t + '.html');
    const ht = one(/<title>([^<]*)<\/title>/, h), st = one(/<title>([^<]*)<\/title>/, s);
    const hh = (one(/<h1>([\s\S]*?)<\/h1>/, h) || '').replace(/<[^>]+>/g, ' ');
    const sh = (one(/<h1>([\s\S]*?)<\/h1>/, s) || '').replace(/<[^>]+>/g, ' ');
    const hd = one(/<meta name="description" content="([^"]*)"/, h), sd = one(/<meta name="description" content="([^"]*)"/, s);
    if (!/^Hail Damage Roof Inspection in /.test(ht || '')) bad.push(t + ' hail title: ' + ht);
    if (!/^Wind &(amp;)? Storm Damage Roof Repair in /.test(st || '')) bad.push(t + ' storm title: ' + st);
    if (!/^Hail Damage Roof Inspection\s/.test(hh)) bad.push(t + ' hail h1: ' + hh);
    if (!/^Wind &(amp;)? Storm Damage Repair\s/.test(sh)) bad.push(t + ' storm h1: ' + sh);
    if (!hd || !sd || hd === sd) bad.push(t + ' descriptions missing or identical');
    if (/Insurance Claims/i.test((ht || '') + (st || '') + hh + sh)) bad.push(t + ' title/H1 still targets "Insurance Claims"');
    if (!/hail/i.test(hd || '') || /hail/i.test(sd || '')) bad.push(t + ' hail desc must say hail, storm desc must not');
  }
  ok('every pair: hail = "Hail Damage Roof Inspection", storm = "Wind & Storm Damage Roof Repair"', bad.length === 0, show(bad));
  // Global: no two indexable pages share a <title>.
  const seen = new Map(); const dup = [];
  for (const f of TREE) {
    if (!/\.html$/.test(f.rel) || /noindex/i.test(one(/<meta name="robots" content="([^"]*)"/, f.text) || '')) continue;
    const t = one(/<title>([^<]*)<\/title>/, f.text);
    if (!t) continue;
    if (seen.has(t)) dup.push(t + ' (' + seen.get(t) + ', ' + f.rel + ')'); else seen.set(t, f.rel);
  }
  ok('no two indexable pages share a <title>', dup.length === 0, show(dup));
}

// ── 3. Freshness: visible "Last updated" + WebPage dateModified ────────
console.log('\n3. service/area pages carry a visible date and a matching dateModified');
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/stamp-page-dates.mjs'), '--check'], { encoding: 'utf8' });
  const n = +(one(/--check: (\d+) pages/, r.stdout || '') || 0);
  ok('stamp-page-dates --check passes', r.status === 0, (r.stdout || '').split('\n').slice(0, 6).join(' | ') + (r.stderr || ''));
  ok('...over every service and area page (' + n + ')', n >= 190);
  const sample = ['services/roof-replacement-mason-oh.html', 'areas/goshen-oh.html', 'services/the-nbd-build/index.html'];
  for (const rel of sample) {
    const src = readDoc(rel).replace(/\r\n/g, '\n');
    const main = one(/<main[^>]*>([\s\S]*)<\/main>/, src) || '';
    const vis = one(/Last updated <time datetime="(\d{4}-\d{2}-\d{2})">/, main);
    const ld = [...src.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => { try { return JSON.parse(m[1]); } catch (e) { return null; } })
      .find((j) => j && j['@type'] === 'WebPage');
    ok(rel + ': visible "Last updated" inside <main>, same date as WebPage.dateModified', !!vis && !!ld && ld.dateModified === vis, vis + ' vs ' + (ld && ld.dateModified));
  }
}

// ── 4. Internal links to the weakest helpful pages ─────────────────────
console.log('\n4. town pages link the storm-roofer guide, tarping and the Roof Care Plan');
{
  const NEED = {
    'storm-damage': ['/services/emergency-roof-tarping', '/blog/how-to-choose-a-roofer-after-a-storm'],
    'hail-damage': ['/blog/how-to-choose-a-roofer-after-a-storm'],
    'roof-repair': ['/services/emergency-roof-tarping', '/services/roof-care-plan'],
  };
  for (const [fam, hrefs] of Object.entries(NEED)) {
    const pages = fs.readdirSync(SVC).filter((f) => new RegExp('^' + fam + '-(?!insurance-claim).+-(oh|ky)\\.html$').test(f));
    const miss = [];
    for (const f of pages) {
      const src = readDoc('services/' + f);
      for (const h of hrefs) if (!src.includes('href="' + h + '"')) miss.push(f + ' → ' + h);
    }
    ok(fam + ' town pages (' + pages.length + ') link ' + hrefs.join(' + '), pages.length >= 13 && miss.length === 0, show(miss));
  }
  for (const t of ['/blog/how-to-choose-a-roofer-after-a-storm', '/services/emergency-roof-tarping', '/services/roof-care-plan']) {
    const inl = TREE.filter((f) => /\.html$/.test(f.rel) && f.text.includes('href="' + t + '"')).length;
    ok(t + ' has at least 15 linking pages (' + inl + ')', inl >= 15);
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
