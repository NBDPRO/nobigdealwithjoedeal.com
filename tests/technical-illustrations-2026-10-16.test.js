/**
 * tests/technical-illustrations-2026-10-16.test.js — the technical
 * illustrations (scripts/build-illustrations.mjs, site-src/illustrations/).
 *
 *  1. every SVG: accessible (role img + title + desc), carries the
 *     "Illustration · not a photo" badge, no script, sane size
 *  2. every page lists its figures with alt, width/height, lazy loading and the
 *     badge; stamped regions are current (build --check)
 *  3. "Details per …" links only to sources marked verified in sources.json;
 *     generic figures carry none
 *  4. the interactive roof: keyboard-operable slider with aria, real buttons,
 *     ships pulled apart (no-JS / reduced-motion view), JS honours
 *     prefers-reduced-motion; the airflow animation has a Pause button and a
 *     reduced-motion stop
 *  5. no banned phrases (hail-proof, licensed, lifetime warranty …), no inline
 *     script/handlers/style attributes in the stamped regions
 *
 * Run: node tests/technical-illustrations-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const FIG = JSON.parse(read('site-src/illustrations/figures.json'));
const SRC = JSON.parse(read('site-src/illustrations/sources.json')).sources;
const BADGE = 'Illustration · not a photo of an actual job';
const ids = Object.keys(FIG.figures);
const BANNED = [/hail[- ]?proof/i, /\blicensed\b/i, /lifetime (warranty|workmanship|pledge)/i, /master elite/i, /handle (your|the) claim/i, /insurance will (cover|pay)/i, /indestructible/i, /guarantee[sd]? (no|against) (hail|damage|leaks)/i];

console.log('\n1. The SVG files');
ok('16 illustrations in figures.json', ids.length === 16, ids.length);
for (const id of ids) {
  const f = 'docs/assets/images/illustrations/' + id + '.svg';
  const exists = fs.existsSync(path.join(ROOT, f));
  ok(id + '.svg exists', exists);
  if (!exists) continue;
  const svg = read(f);
  ok(id + ': role="img" + <title> + <desc> wired by aria-labelledby', /role="img"/.test(svg) && /<title id="([^"]+)">/.test(svg) && /<desc id="([^"]+)">/.test(svg) && /aria-labelledby="[^"]+-t [^"]+-d"/.test(svg));
  ok(id + ': carries the illustration badge', svg.includes(BADGE));
  ok(id + ': desc says it is not a photo', /Illustration, not a photo of an actual job\./.test(svg));
  ok(id + ': no script, no external refs', !/<script/i.test(svg) && !/href="https?:/.test(svg));
  ok(id + ': under 120 KB', svg.length < 120 * 1024, svg.length);
  ok(id + ': phone rule hides the small text', /@media \(max-width:640px\)/.test(svg));
  ok(id + ': no banned phrases', !BANNED.some((re) => re.test(svg)));
}

console.log('\n2. Pages');
let check = '';
try { check = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-illustrations.mjs'), '--check'], { encoding: 'utf8' }); } catch (e) { check = 'FAILED ' + (e.stdout || '') + (e.stderr || ''); }
ok('stamped regions are current (node scripts/build-illustrations.mjs --check)', /all regions current/.test(check), check.slice(0, 300));
for (const [page, list] of Object.entries(FIG.pages)) {
  const html = read(page);
  ok(page + ': loads illustrations.css', /<link rel="stylesheet" href="\/assets\/css\/illustrations\.css\?v=\d+">/.test(html));
  ok(page + ': 1–3 figures (or the explainer)', list.length <= 3 || page === 'docs/guides/how-a-roof-works.html', list.length);
  for (const id of list) {
    const m = html.match(new RegExp('<!-- ILLUS:' + id + ':START -->([\\s\\S]*?)<!-- ILLUS:' + id + ':END -->'));
    ok(page + ' → ' + id + ': region present', !!m);
    if (!m) continue;
    const r = m[1];
    ok(page + ' → ' + id + ': img with alt, width/height, lazy, ?v=', new RegExp('<img src="/assets/images/illustrations/' + id + '\\.svg\\?v=[0-9a-f]{8}" width="1200" height="900" loading="lazy" decoding="async" alt="[^"]{40,}">').test(r));
    ok(page + ' → ' + id + ': badge present', r.includes('<span class="illus-badge">' + BADGE + '</span>'));
    ok(page + ' → ' + id + ': caption key', /<ol class="illus-key"><li>/.test(r));
    ok(page + ' → ' + id + ': no inline style/handler/script', !/\sstyle=|\son[a-z]+=|<script/i.test(r));
  }
}
const guide = read('docs/guides/how-a-roof-works.html');
ok('explainer is in the sitemap', read('docs/sitemap.xml').includes('<loc>https://nobigdealwithjoedeal.com/guides/how-a-roof-works</loc>'));
ok('explainer is on the /free-tools hub', read('docs/free-tools/index.html').includes('href="/guides/how-a-roof-works"'));
for (const p of Object.keys(FIG.pages).filter((p) => !p.includes('how-a-roof-works'))) ok(p + ' links to the explainer', read(p).includes('href="/guides/how-a-roof-works'));
ok('explainer canonical + description', /<link rel="canonical" href="https:\/\/nobigdealwithjoedeal\.com\/guides\/how-a-roof-works">/.test(guide) && /<meta name="description" content="[^"]{120,160}">/.test(guide));

console.log('\n3. Sources');
for (const id of ids) {
  const f = FIG.figures[id];
  for (const s of f.sources) ok(id + ': linked source "' + s + '" is verified with a URL', SRC[s] && SRC[s].verified === true && /^https:\/\//.test(SRC[s].url));
  if (f.generic) ok(id + ': generic figure has no source line', !(f.sources || []).length);
}
const allHtml = Object.keys(FIG.pages).map(read).join('\n');
const linked = [...allHtml.matchAll(/<p class="illus-src">Details per (.*?)<\/p>/g)].map((m) => m[1]);
const okUrls = new Set(Object.values(SRC).filter((s) => s.verified && s.url).map((s) => s.url));
ok('every "Details per" link points at a verified source', linked.length > 0 && linked.every((l) => [...l.matchAll(/href="([^"]+)"/g)].every((m) => okUrls.has(m[1].replace(/&amp;/g, '&')))));
ok('unverified items are recorded in sources.json', Array.isArray(JSON.parse(read('site-src/illustrations/sources.json')).unverified));

console.log('\n4. Interactive pieces');
const rx = (guide.match(/<!-- ILLUS-INLINE:roof-explode:START -->([\s\S]*?)<!-- ILLUS-INLINE:roof-explode:END -->/) || [])[1] || '';
ok('pull-apart roof stamped on the explainer', rx.length > 1000);
ok('inline SVG is labelled (role img, title, desc)', /<svg class="rx-svg"[^>]*role="img"[^>]*aria-labelledby="rx-t rx-d"/.test(rx) && /<title id="rx-t">/.test(rx) && /<desc id="rx-d">/.test(rx));
ok('slider: labelled range input with aria-valuetext', /<label class="rx-label" for="rx-range">/.test(rx) && /<input class="rx-range" id="rx-range" type="range" min="0" max="100" step="1" value="100" aria-valuetext="Pulled apart" data-rx-range>/.test(rx));
const keys = [...rx.matchAll(/class="rx-layer" data-layer="([a-z-]+)"/g)].map((m) => m[1]);
const btns = [...rx.matchAll(/<button type="button" class="rx-btn" data-rx-layer="([a-z-]+)"[^>]*aria-pressed="false"/g)].map((m) => m[1]);
ok('9 layers, each with a real <button> (keyboard)', keys.length === 9 && keys.join() === btns.join(), keys.join() + ' / ' + btns.join());
ok('ships pulled apart: layers above the deck carry a translate (no-JS / reduced-motion view)', [...rx.matchAll(/class="rx-layer" data-layer="[a-z-]+" data-i="(\d)" transform="translate\(0 (-?[\d.]+)\)"/g)].every((m) => (m[1] === '0') === (parseFloat(m[2]) === 0)));
ok('live region for the layer description', /<div class="rx-info" id="rx-info" aria-live="polite">/.test(rx));
ok('badge on the interactive figure', rx.includes(BBADGE()));
function BBADGE() { return '<span class="illus-badge">' + BADGE + '</span>'; }
const js = read('docs/assets/js/roof-explode.js');
ok('roof-explode.js: honours prefers-reduced-motion (static exploded view, no scroll link)', /prefers-reduced-motion: reduce/.test(js) && /if \(reduce\) \{ set\(100\); return; \}/.test(js));
ok('roof-explode.js: slider input drives it; textContent only (no innerHTML)', /addEventListener\('input'/.test(js) && !/innerHTML/.test(js));
ok('explainer loads both scripts deferred, external', /<script defer src="\/assets\/js\/roof-explode\.js\?v=\d+"><\/script>/.test(guide) && /<script defer src="\/assets\/js\/vent-flow\.js\?v=\d+"><\/script>/.test(guide));
const vx = (guide.match(/<!-- ILLUS-INLINE:vent-flow:START -->([\s\S]*?)<!-- ILLUS-INLINE:vent-flow:END -->/) || [])[1] || '';
ok('airflow figure: labelled SVG + hidden-until-JS Pause button', /<svg class="vx-svg"[^>]*role="img"/.test(vx) && /<button type="button" class="vx-toggle" data-vx-toggle aria-pressed="false" hidden>Pause the airflow<\/button>/.test(vx));
const vjs = read('docs/assets/js/vent-flow.js'), css = read('docs/assets/css/illustrations.css');
ok('vent-flow.js: reduced motion → no animation; animates only while visible', /prefers-reduced-motion: reduce/.test(vjs) && /IntersectionObserver/.test(vjs));
ok('CSS: animation only under .is-animating and off for reduced motion', /\.vx\.is-animating \.vf\{animation:/.test(css) && /@media \(prefers-reduced-motion:reduce\)\{\.vx \.vf\{animation:none!important\}/.test(css));
ok('CSS: marketing radii only (8px / 100px)', [...css.matchAll(/border-radius:([^;}]+)/g)].every((m) => /^(8px|100px)$/.test(m[1].trim()) || /^0 /.test(m[1].trim())));

console.log('\n5. Wording');
const figText = JSON.stringify(FIG);
ok('figures.json: no banned phrases', !BANNED.some((re) => re.test(figText)));
ok('regions on pages: no banned phrases', !BANNED.some((re) => re.test(allHtml.match(/<!-- ILLUS[\s\S]*?ILLUS[^>]*END -->/g).join(''))));
ok('UHDZ Class 4 stated plainly', /GAF Timberline UHDZ is UL 2218 Class 4/.test(figText));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
