/**
 * tests/marketing-polish-contract.test.js — visual-audit sweep contracts
 * (2026-07-19 marketing polish batch 1).
 *
 * The marketing site has no shared chrome layer — consistency is enforced by
 * injection sweeps, and drift = pages a sweep missed (that is exactly how the
 * Fairfield/Lebanon .ico black-blob defect happened). These guards make the
 * batch-1 invariants permanent so a future page/template can't silently fork:
 *
 *  1. .btn-cal:hover background is #BD5728 everywhere (white text passes AA at
 *     4.61:1). This started life as #B85400, a darker orange the 2026-07 a11y
 *     pass introduced because the THEN-brand orange #E8720C measured only
 *     3.07:1 (and --orange-light #F08030 just 2.68:1). The palette re-measured
 *     off the logo in 2026-09 clears AA on its own, so the workaround collapsed
 *     back into the brand accent. Those two ratios are historical, and belong
 *     to #E8720C and #F08030 — do not "update" them to a current hex.
 *  2. No 7px/99px border-radius strays (8px / 100px system).
 *  3. nbd-mobile.css carries the a11y + interaction-polish block
 *     (:focus-visible ring, pressed states, reduced-motion kill switch).
 *  4. The 4 lead-tool pages load nbd-mobile.css (overflow/safe-area guards).
 *  5. Every page using <svg class="ico"> has the .ico sizing CSS (unsized
 *     inline SVG renders as a giant black blob).
 *  6. Every page with a collapsible nav collapses at 1024px (not only a
 *     legacy 900/780px rule).
 *  7. Blog pages all carry the Non-hero heading caps block.
 *  8. The 12 service hubs carry the laptop nav-squeeze block their city
 *     variants have.
 *  9. One-off regressions: privacy favicon, estimate footer separator,
 *     no empty-src <img> on marketing pages.
 *
 * Zero deps. Run: node tests/marketing-polish-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function listHtml(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const rel = path.relative(DOCS, full).replace(/\\/g, '/');
      if (/^(pro|admin|assets)(\/|$)/.test(rel)) continue;
      listHtml(full, out);
    } else if (name.endsWith('.html')) out.push(full);
  }
  return out;
}
const ALL = listHtml(DOCS);
const rel = (f) => path.relative(DOCS, f).replace(/\\/g, '/');
const marketing = ALL.filter((f) => !/^(sites|tools)\//.test(rel(f)));
const read = (f) => fs.readFileSync(f, 'utf8');

console.log('MARKETING POLISH CONTRACT — batch 1 invariants');

// 1. btn-cal hover
{
  const bad = [];
  for (const f of marketing) {
    const s = read(f);
    const m = s.match(/\.btn-cal:hover\s*\{[^}]*?background:\s*([^;}]+)/g) || [];
    for (const rule of m) {
      if (!/#bd5728/i.test(rule)) { bad.push(rel(f)); break; }
    }
  }
  ok('.btn-cal:hover background is #BD5728 site-wide', bad.length === 0, bad.slice(0, 4).join(', '));
}

// 1b. One on-navy orange. --orange-light is the brand accent lifted to 62%
// lightness (same 19deg hue, same 65% saturation) so it clears AA as link text
// on the navy chrome: 5.83:1 on #12223D, 4.80:1 on #1A3057. The site previously
// carried three different light oranges for that one job (#f08030, #ffaf66,
// #f9c97a); this guard is what stops a fourth appearing.
{
  const bad = [];
  for (const f of marketing) {
    const s = read(f);
    const m = s.match(/--orange-light:\s*([^;}]+)/g) || [];
    for (const rule of m) {
      if (!/#dd875f/i.test(rule)) { bad.push(rel(f)); break; }
    }
  }
  ok('--orange-light is #DD875F site-wide', bad.length === 0, bad.slice(0, 4).join(', '));
}

// 1c. The favicons are real SVG markup. Shipped 6-byte binary blobs on
// 2026-09-07 (#1467): the authoring tool treats .svg as an image and silently
// wrote a degenerate encode instead of the markup, so every tab on the site
// lost its icon. Same failure family as the Fairfield/Lebanon .ico black blob.
// Byte-length alone is not enough — assert it parses as the mark we intend.
{
  for (const f of ['favicon.svg', 'pro/favicon.svg']) {
    const p = path.join(DOCS, f);
    if (!fs.existsSync(p)) { ok(f + ' exists', false, 'missing'); continue; }
    const s = fs.readFileSync(p, 'utf8');
    ok(f + ' is well-formed SVG markup, not a binary blob',
      s.trimStart().startsWith('<svg')
      && s.trimEnd().endsWith('</svg>')
      && /viewBox="0 0 64 64"/.test(s)
      && /fill="#[0-9a-f]{6}"/i.test(s)
      && s.length > 150,
      f + ' is ' + s.length + ' bytes, starts ' + JSON.stringify(s.slice(0, 24)));
  }
}

// 2. radius strays
{
  const bad = [];
  const targets = marketing.concat(
    ['quick-lead-form.css', 'blog-midpost-cta.css', 'nbd-mobile.css', 'mobile-cta.css']
      .map((n) => path.join(DOCS, 'assets/css', n)).filter(fs.existsSync)
  );
  for (const f of targets) {
    const s = read(f);
    if (/border-radius:\s*(7|99)px/.test(s)) bad.push(rel(f));
  }
  ok('no 7px/99px border-radius strays', bad.length === 0, bad.slice(0, 4).join(', '));
}

// 3. nbd-mobile a11y block
{
  const s = read(path.join(DOCS, 'assets/css/nbd-mobile.css'));
  ok('nbd-mobile.css has focus ring + pressed states + reduced-motion',
    // The locked brand orange. This expectation moved WITH its source: the
    // public marketing site (docs/assets/css and the rest of docs/ outside
    // /pro) was repointed to the locked palette, so nbd-mobile.css now paints
    // the focus ring #BD5728. The retired #E8720C measured 3.07:1 on white and
    // failed WCAG AA; #BD5728 measures 4.61:1. Matched case-insensitively —
    // hex casing carries no meaning, and the public site writes it lowercase.
    /:focus-visible\{outline:3px solid #BD5728/i.test(s)
    && /\.btn-primary:active/.test(s)
    && /prefers-reduced-motion:reduce/.test(s)
    && /nbdRevealIn/.test(s));
}

// 4. funnel pages load nbd-mobile.css
{
  const bad = ['inspect.html', 'roof-score.html', 'storm-check.html', 'storm-report.html']
    .filter((p) => !read(path.join(DOCS, p)).includes('nbd-mobile.css'));
  ok('lead-tool pages load nbd-mobile.css', bad.length === 0, bad.join(', '));
}

// 5. svg.ico pages have sizing CSS — via the shared stylesheet since
//    2026-08-07 (an inline .ico block still satisfies the contract so a
//    hand-authored page can't regress to black-blob icons either way).
{
  const bad = [];
  for (const f of marketing) {
    const s = read(f);
    if (!s.includes('class="ico"')) continue;
    if (!s.includes('/assets/css/nbd-icons.css') && !/\.ico\{[^}]*width:1em/.test(s)) bad.push(rel(f));
  }
  ok('every svg.ico page has .ico sizing CSS (no black-blob regressions)', bad.length === 0, bad.slice(0, 4).join(', '));
}

// 6. nav collapse at 1024
{
  const bad = [];
  for (const f of marketing) {
    const s = read(f);
    if (!s.includes('nav-links') || !s.includes('hamburger')) continue;
    // The 1024px rule moved to the shared docs/assets/css/nbd-nav-base.css
    // (2026-09-17 inline-CSS dedup) — a page linking it carries the rule
    // just as authoritatively as an inline copy.
    if (s.includes('/assets/css/nbd-nav-base.css')) continue;
    const legacyOnly = /@media[^{]*max-width:\s*(900|780)px[^{]*\{[^@]*?\.nav-links\s*\{[^}]*display:\s*none/.test(s)
      && !/@media[^{]*max-width:\s*1024px[^{]*\{[\s\S]{0,600}?\.nav-links\s*\{[^}]*display:\s*none/.test(s);
    if (legacyOnly) bad.push(rel(f));
  }
  ok('no page collapses nav only below 1024px', bad.length === 0, bad.slice(0, 4).join(', '));
}

// 7. blog caps coverage
// The caps live in the nbd-readability-v2 block, which moved to the shared
// docs/assets/css/nbd-readability.css (2026-09-18 inline-CSS dedup slice 3b,
// linked IN PLACE of the inline copy). Five posts get the caps ONLY from that
// block, so a page linking the sheet carries them as authoritatively as an
// inline copy — provided the sheet itself still does (7b pins its bytes).
{
  const sheet = read(path.join(DOCS, 'assets/css/nbd-readability.css'));
  const sheetCaps = sheet.includes('Non-hero heading caps');
  const linksSheet = (s) => /<link rel="stylesheet" href="\/assets\/css\/nbd-readability\.css">[\s\S]*<\/head>/.test(s);
  const bad = marketing.filter((f) => rel(f).startsWith('blog/')).filter((f) => {
    const s = read(f);
    return !s.includes('Non-hero heading caps') && !(sheetCaps && linksSheet(s));
  }).map(rel);
  ok('all blog pages carry the heading-caps block (inline or linked)', bad.length === 0, bad.slice(0, 4).join(', '));
}

// 7b. The extracted sheet is byte-pinned to CANONICAL_BODY — the exact text
// scripts/ensure-readability-css.js matched when it swapped each inline copy
// for the link. A drifted sheet would silently restyle ~186 pages.
{
  const { CANONICAL_BODY } = require('../scripts/ensure-readability-css.js');
  const css = read(path.join(DOCS, 'assets/css/nbd-readability.css')).replace(/\r\n/g, '\n');
  const header = css.match(/^\/\*[\s\S]*?\*\/\n/);
  const body = header ? css.slice(header[0].length) : css;
  const want = CANONICAL_BODY + '\n';
  let at = 0;
  while (at < Math.max(body.length, want.length) && body[at] === want[at]) at++;
  ok('nbd-readability.css body is byte-identical to ensure-readability-css.js CANONICAL_BODY',
    !!header && body === want,
    !header ? 'no file-header comment' : 'first difference at char ' + at + ': ' + JSON.stringify(body.slice(at, at + 40)));
}

// 8. hub nav-squeeze
{
  const hubs = ['roof-replacement', 'roof-repair', 'roof-inspection', 'hail-damage-insurance-claim',
    'storm-damage', 'gutter-replacement', 'siding-repair', 'siding-replacement',
    'financing', 'fire-water-smoke-damage', 'roof-care-plan', 'roof-cleaning-soft-wash'];
  const bad = hubs.filter((h) => !read(path.join(DOCS, 'services', h + '.html')).includes('min-width:1025px'));
  ok('all 12 service hubs have the laptop nav-squeeze block', bad.length === 0, bad.join(', '));
}

// 9. one-offs
ok('privacy.html has a favicon', /rel="icon"/.test(read(path.join(DOCS, 'privacy.html'))));
ok('estimate.html footer has no doubled separator',
  !/Solutions &middot;\s*<span style="opacity:\.4">·<\/span>/.test(read(path.join(DOCS, 'estimate.html'))));
{
  const bad = marketing.filter((f) => /<img[^>]+src=""/.test(read(f))).map(rel);
  ok('no empty-src <img> on marketing pages', bad.length === 0, bad.slice(0, 3).join(', '));
}

// 10. Audit-response (2026-07-19 external audit): review markup + funnel link
{
  const s = read(path.join(DOCS, 'review.html'));
  const m = s.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let j = null;
  try { j = JSON.parse(m[1]); } catch (_) {}
  ok('review.html LocalBusiness carries review[] from on-page cards',
    !!(j && Array.isArray(j.review) && j.review.length >= 3 && j.review[0].author));
  // Deliberate: no fabricated aggregateRating (no truthful count on page).
  ok('review.html schema has NO aggregateRating (honest-count rule)', !(j && j.aggregateRating));
}
// Jo's call (2026-07-29): the growth playbook is a CONTRACTOR lead magnet —
// it must NOT appear on homeowner pages; it lives on the /pro surfaces only.
ok('free-guide funnel link ABSENT from consumer footers (index)',
  !/data-nbd-freeguide/.test(read(path.join(DOCS, 'index.html'))));
ok('free-guide funnel link present on the pro landing footer',
  /data-nbd-freeguide/.test(read(path.join(DOCS, 'pro/index.html'))));
// The reverse leak (2026-09-13): the contractor magnet itself shipped the
// HOMEOWNER chrome — a free-roof nomination bar and a 26-link drawer of roofing
// services, warranty pages and homeowner tools. Its header, drawer and footer
// now link only to /pro surfaces and its own form.
{
  const fg = read(path.join(DOCS, 'sites/free-guide/index.html'));
  const chrome = [
    (fg.match(/<div class="ann-bar">[\s\S]*?<\/div>/) || [''])[0],
    (fg.match(/<nav>[\s\S]*?<\/nav>/) || [''])[0],
    (fg.match(/<div class="mobile-nav" id="mobileNav">[\s\S]*?\n<\/div>/) || [''])[0],
    (fg.match(/<footer>[\s\S]*?<\/footer>/) || [''])[0],
  ];
  ok('free-guide chrome regions all located (a missing region would pass the next check vacuously)', chrome.every((c) => c.length > 20));
  const hrefs = [...chrome.join('\n').matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);
  const homeowner = hrefs.filter((h) => !/^(\/pro(\/[a-z-]*)?|#hero)$/.test(h));
  ok('free-guide header, drawer and footer link only to /pro surfaces or its own form', homeowner.length === 0, homeowner.slice(0, 6).join(' '));
  ok('free-guide carries no free-roof announcement slide', !/data-nbd-freeroof-ann/.test(fg));
  // Declarations only. Slice the <style> blocks (pure CSS), strip their comments,
  // THEN find the rule: the fix carries a comment that quotes a whole CSS rule,
  // braces and all, so matching `{[^}]*}` on raw source stopped inside the comment
  // and passed with the declaration deleted (caught by a break-test, twice).
  const fgCss = [...fg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const drawerRules = [...fgCss.matchAll(/\.mobile-nav a\s*\{([^}]*)\}/g)].map((m) => m[1]);
  ok('free-guide drawer links render as rows (display:block beats nbd-nav.css forcing the open drawer to block)',
    drawerRules.some((d) => /(^|[;{\s])display:\s*block/.test(d)), drawerRules.length + ' rule(s)');
  const fb = JSON.parse(read(path.join(DOCS, '..', 'firebase.json')));
  const rule = fb.hosting.headers.find((h) => h.source === '/sites/free-guide');
  ok('free-guide has an X-Robots-Tag noindex header like every sibling /sites surface',
    !!(rule && rule.headers.some((x) => x.key === 'X-Robots-Tag' && /noindex/.test(x.value))));
}
ok('free-roof page has JSON-LD', /application\/ld\+json/.test(read(path.join(DOCS, 'free-roof/index.html'))));

// 11. Chrome batch 2 (Jo's calls, 2026-07-19)
{
  // Differentiated nav CTAs: no marketing page pairs "Free Estimate" nav
  // button with the Instant Estimate link anymore.
  const bad = marketing.filter((f) => /class="nav-cta">Free Estimate/.test(read(f))).map(rel);
  ok('nav CTA button is "Book Inspection" site-wide (no Free Estimate dupes)', bad.length === 0, bad.slice(0, 3).join(', '));
}
{
  // Cert badges on every city service page.
  const bad = marketing.filter((f) => /^services\/[a-z-]+-(oh|ky)\.html$/.test(rel(f))
    && !read(f).includes('gaf-certified-badge')).map(rel);
  ok('every city service page carries the GAF/TAMKO badge row', bad.length === 0, bad.slice(0, 3).join(', '));
}
{
  // Timberline in the dropdown wherever LumaNail is listed.
  const bad = marketing.filter((f) => {
    const s = read(f);
    return s.includes('/services/lumanail') && !s.includes('/services/gaf-timberline');
  }).map(rel);
  ok('GAF Timberline dropdown link everywhere LumaNail is listed', bad.length === 0, bad.slice(0, 3).join(', '));
}
{
  // Hub closers on the site-majority navy. Pinned to the CURRENT accent: held
  // on the retired #B85400 this would pass vacuously and protect nothing.
  const bad = marketing.filter((f) => /^services\/[a-z-]+\.html$/.test(rel(f))
    && /\.final-cta\s*\{\s*background:#BD5728/i.test(read(f))).map(rel);
  ok('no hub keeps the solid-orange closing band', bad.length === 0, bad.join(', '));
}
{
  // Reviews widget on all 12 hubs.
  const hubs = ['roof-replacement', 'roof-repair', 'roof-inspection', 'hail-damage-insurance-claim',
    'storm-damage', 'gutter-replacement', 'siding-repair', 'siding-replacement',
    'financing', 'fire-water-smoke-damage', 'roof-care-plan', 'roof-cleaning-soft-wash'];
  const bad = hubs.filter((h) => !fs.readFileSync(path.join(DOCS, 'services', h + '.html'), 'utf8').includes('google-reviews-widget'));
  ok('google-reviews widget on all 12 service hubs', bad.length === 0, bad.join(', '));
}

// ────────────────────────────────────────────────────────────────────────────
// BATCH 3 (2026-07-20) — cert bar sweep, nav canon, hub lead capture, chrome
// gaps. Same rationale as above: no shared chrome layer, so every one of these
// is a sweep result that a new page or a hand-edit can silently fork away from.
// ────────────────────────────────────────────────────────────────────────────
console.log('\nMARKETING POLISH CONTRACT — batch 3 invariants');

const HUBS = ['roof-replacement', 'roof-repair', 'roof-inspection', 'hail-damage-insurance-claim',
  'storm-damage', 'gutter-replacement', 'siding-repair', 'siding-replacement',
  'financing', 'fire-water-smoke-damage', 'roof-care-plan', 'roof-cleaning-soft-wash'];

// Pages the add-footer-cert-bar.js sweep targets: city service pages + area pages.
const certBarTargets = marketing.filter((f) => /^services\/[a-z0-9-]+-(oh|ky)\.html$/.test(rel(f))
  || (/^areas\/[a-z0-9-]+\.html$/.test(rel(f)) && rel(f) !== 'areas/index.html'));

{
  // 1. Footer cert bar present on every swept city + area page.
  const bad = certBarTargets.filter((f) => !read(f).includes('data-nbd-certbar="v1"')).map(rel);
  ok('footer cert bar on every city service + area page', bad.length === 0,
    `${bad.length} missing: ` + bad.slice(0, 3).join(', '));
}
{
  // 2. Injected exactly once — a re-run of the idempotent sweep must not double-insert.
  const bad = certBarTargets.filter((f) => read(f).split('data-nbd-certbar="v1"').length - 1 > 1).map(rel);
  ok('cert bar injected exactly once per page', bad.length === 0, bad.slice(0, 3).join(', '));
}
{
  // 3. Cert bar carries all badge verify links + the full independent-contractor
  //    disclaimer with the license IDs (the legal reason the bar exists).
  //    american-operator (Locally Owned & Operated cert, added 2026-08-13) has
  //    no ID number — the badge + link is the whole credential.
  const bad = certBarTargets.filter((f) => {
    const s = read(f);
    return !(s.includes('gaf-certified-badge-120.png') && s.includes('tamko-pro-gold-badge-120.png')
      && s.includes('american-operator-badge-120.png')
      && s.includes('GAF ID 1162011') && s.includes('TAMKO Pro ID 181382')
      && s.includes('Independent Contractor'));
  }).map(rel);
  ok('cert bar carries all three badges + IDs + disclaimer', bad.length === 0, bad.slice(0, 3).join(', '));
}
{
  // 4. THE SAME INVARIANT, KEYED ON THE ASSET RATHER THAN A FILE LIST.
  //    Checks 1-3 scope to certBarTargets — city service pages + area leaves —
  //    so on 2026-08-19 eight pages carrying a real cert bar sat outside every
  //    one of them: areas/index.html is explicitly excluded by that filter, and
  //    the 7 brand microsites are services/<name>/index.html, which the
  //    services/<slug>-(oh|ky).html pattern never matches. All eight shipped two
  //    badges where 187 pages shipped three, and this suite stayed green. Third
  //    'guard defeated by its own list' failure logged in this repo.
  //
  //    So: forget who is *supposed* to have a cert bar. Any page shipping the GAF
  //    badge image has one, and it must be complete. A new page cannot opt out by
  //    not being on a list.
  const withGafBadge = marketing.filter((f) => read(f).includes('gaf-certified-badge-120.png'));
  const bad = withGafBadge.filter((f) => {
    const s = read(f);
    return !(s.includes('tamko-pro-gold-badge-120.png')
      && s.includes('american-operator-badge-120.png')
      && s.includes('data-nbd-certbar="v1"'));
  }).map(rel);
  ok(`cert bar is complete WHEREVER it appears (${withGafBadge.length} pages)`, bad.length === 0,
    `${bad.length} incomplete: ` + bad.slice(0, 5).join(', '));
}
{
  // 5. The quiet /pro door had FOUR wordings before 2026-08-19 — "Are you a
  //    contractor?" (178), "...or entrepreneur?" (17), an &rarr; entity variant,
  //    and "Contractor or entrepreneur?" — plus 3 grid footers with no door at
  //    all. Three of the four footer partials already used the majority wording;
  //    footer-extended was the outlier, which is how 14 pages inherited a fork.
  //    Assert the wording rather than the presence: a page is free not to carry
  //    the door (404, offline, the tenant template must not), but if it does, it
  //    says one thing.
  const CANON = 'Are you a contractor? → NBD Pro';
  const bad = marketing.filter((f) => {
    const s = read(f);
    const doors = [...s.matchAll(/<a href="\/pro\/"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1].trim());
    return doors.some((d) => /contractor|entrepreneur/i.test(d) && d !== CANON);
  }).map(rel);
  ok('pro door uses one wording site-wide', bad.length === 0,
    `${bad.length} forked: ` + bad.slice(0, 5).join(', '));
  // One door per footer (Jo, 2026-09-13): footer-extended carried a second,
  // louder 'NBD Pro ↗' item in its Company column on top of the canonical door,
  // escaping the wording check above only because it lacked the word
  // "contractor". Count the /pro/ links in every footer partial.
  const partialsDir = path.join(DOCS, '..', 'site-src', 'partials');
  const extraDoors = fs.readdirSync(partialsDir).filter((p) => /^footer-.*\.html$/.test(p)).map((p) => [p, (read(path.join(partialsDir, p)).match(/href="\/pro\/?"/g) || []).length]).filter(([, n]) => n > 1);
  ok('no footer partial carries more than one /pro link (one silent door, no second Pro menu item)', extraDoors.length === 0, JSON.stringify(extraDoors));
}
{
  // 4. CERT CLAIM GUARD — Joe is GAF Certified (System Plus) and TAMKO only.
  //    "Master Elite" is a higher GAF tier he does NOT hold; he holds no Owens
  //    Corning certification at all. Both names legitimately appear as honest
  //    prose — the-nbd-guarantee explicitly disclaims Master Elite, and the
  //    shingle-comparison blog says outright "I'm not one of them" about OC's
  //    network — so a bare name match is NOT the defect. The defect is an
  //    affirmative self-claim, so match claim verbs and drop negated sentences.
  const CLAIM = /\b(we are|we're|i am|i'm|as an?|proud(?:ly)?)\s+(?:an?\s+)?(?:[a-z]+\s+){0,3}(master.?elite|owens.?corning)[^.<>]{0,40}(certified|certification|contractor|preferred|platinum|elite)/i;
  const NEG = /\b(not|isn'?t|aren'?t|never|don'?t|doesn'?t|separate|different)\b/i;
  const bad = marketing.filter((f) => {
    // Sentence-level so a disclaimer elsewhere on the page can't mask a claim,
    // and a negation inside the sentence correctly clears it.
    const text = read(f).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return text.split(/(?<=[.!?])\s+/).some((sent) => CLAIM.test(sent) && !NEG.test(sent));
  }).map(rel);
  ok('no Master Elite / Owens Corning certification claim', bad.length === 0, bad.slice(0, 3).join(', '));
}
{
  // 5. Quick-lead form on all 12 hubs — markup, stylesheet and renderer, i.e.
  //    the SAME embed the city pages use (no second submit path).
  const bad = HUBS.filter((h) => {
    const s = fs.readFileSync(path.join(DOCS, 'services', h + '.html'), 'utf8');
    return !(s.includes('data-nbd-quick-form') && s.includes('/assets/css/quick-lead-form.css')
      && s.includes('/assets/js/quick-lead-form.js'));
  });
  ok('quick-lead form embed on all 12 service hubs', bad.length === 0, bad.join(', '));
}
{
  // 6. Exactly one form host per hub (idempotency of add-hub-quick-lead-form.js).
  const bad = HUBS.filter((h) => {
    const s = fs.readFileSync(path.join(DOCS, 'services', h + '.html'), 'utf8');
    return s.split('data-nbd-quick-form').length - 1 !== 1;
  });
  ok('hub quick-lead form injected exactly once', bad.length === 0, bad.join(', '));
}
{
  // 7. No page invents its own lead endpoint — every quick-form page routes
  //    through the shared submitPublicLead gateway client.
  const bad = marketing.filter((f) => {
    const s = read(f);
    if (!s.includes('data-nbd-quick-form')) return false;
    // a raw <form action="http..."> next to the quick form = a forked path
    return /<form[^>]+action\s*=\s*["']https?:/i.test(s);
  }).map(rel);
  ok('no forked submit path on quick-form pages', bad.length === 0, bad.slice(0, 3).join(', '));
}
{
  // 8. free-roof.html shipped with no chrome at all — lock header + footer.
  //    The header check used to pin the literal `<header class="fr-head">`,
  //    which is the hand-rolled fork this page carried until 2026-08-19, when it
  //    was stamped with the shared nav-tool partial. The footer check pinned
  //    `class="fr-foot"` the same way, until footer-slim replaced that fork too.
  //    The intent — "this page has a header and a footer" — is unchanged, so
  //    assert THAT and let the implementation move.
  const s = fs.readFileSync(path.join(DOCS, 'free-roof', 'index.html'), 'utf8');
  const hasHeader = /nbd:partial nav-tool/.test(s) || /<header class="fr-head"/.test(s);
  const hasFooter = /nbd:partial footer-slim/.test(s) || /class="fr-foot"/.test(s);
  ok('free-roof carries header + footer chrome',
    hasHeader && hasFooter && s.includes('tel:+18594207382'));
}
{
  // 9. inspect mini-footer carries the phone (funnel-family parity).
  const s = fs.readFileSync(path.join(DOCS, 'inspect.html'), 'utf8');
  ok('inspect mini-footer carries the phone number',
    /mini-footer/.test(s) && /<span class="ph"><a href="tel:\+18594207382">/.test(s));
}
{
  // 10. Nav dropdown label canon: the pledge entry in a dropdown-menu reads
  //     "The Lifetime Pledge" (index.html also has a separate top-level
  //     "The Pledge" nav item, which is intentionally short — dropdown only).
  const bad = marketing.filter((f) => {
    const s = read(f);
    const menus = s.match(/<ul class="dropdown-menu">[\s\S]*?<\/ul>/g) || [];
    return menus.some((m) => m.includes('/the-pledge') && !m.includes('>The Lifetime Pledge<'));
  }).map(rel);
  ok('nav dropdown pledge label is "The Lifetime Pledge"', bad.length === 0, bad.slice(0, 3).join(', '));
}
{
  // 11. JSON-LD must stay parseable — the cert-bar/form sweeps edit near the
  //     schema blocks, and a broken block silently kills rich results.
  const bad = [];
  for (const f of marketing) {
    const blocks = read(f).match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const b of blocks) {
      const body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
      try { JSON.parse(body); } catch { bad.push(rel(f)); break; }
    }
  }
  ok('all JSON-LD blocks parse', bad.length === 0, bad.slice(0, 3).join(', '));
}
{
  // 12. Cert-bar pages must not keep the superseded short trademark line the
  //     sweep replaces (both = duplicated, conflicting disclaimers).
  const bad = certBarTargets.filter((f) => {
    const s = read(f);
    return s.includes('data-nbd-certbar="v1"')
      && s.includes('Independent Contractor &mdash; not an employee or agent');
  }).map(rel);
  ok('superseded short disclaimer removed where cert bar landed', bad.length === 0, bad.slice(0, 3).join(', '));
}

{
  // 13. A11y lane D (2026-08-06): the muted-gray text token. #6b7280 was
  //     4.36:1 on the site's --off-white — an AA fail for normal text.
  //     Swept to #5d6673 (5.24:1 off-white / 5.81 white / 4.63 light-gray).
  //     Guard both directions: the old literal must not creep back into any
  //     homeowner page, and the token definition stays at the passing value.
  //     docs/pro|admin|dev excluded — the CRM theme system has its own gates.
  const pages = ALL.filter((f) => !/^dev\//.test(rel(f)));  // ALL already skips pro/admin
  const stale = pages.filter((f) => read(f).includes('#6b7280')).map(rel);
  ok('a11y: no #6b7280 literal on homeowner pages (token is #5d6673)',
    stale.length === 0, stale.slice(0, 3).join(', '));
  const untoken = pages.filter((f) => /--gray:\s*#(?!5d6673)[0-9a-f]{6}/i.test(read(f))).map(rel);
  ok('a11y: every --gray token definition is #5d6673',
    untoken.length === 0, untoken.slice(0, 3).join(', '));
}
{
  // 14. A11y lane D: navy-page muted text floors. These rgba alphas were
  //     raised to clear 4.5:1 composited over their real backgrounds
  //     (worst case: input fill over --navy-dark #12223D needs >=.56; the
  //     values below all land 4.9:1+). String-pinned — the values are fixed,
  //     so a regression is a literal revert, not a math question.
  const estimate = read(path.join(DOCS, 'estimate.html'));
  const storm = read(path.join(DOCS, 'storm-alerts.html'));
  const floors = [
    ['estimate.html placeholder >= .6', estimate, '.input-group input::placeholder{color:rgba(255,255,255,.6);}'],
    ['estimate.html .tile-desc >= .64', estimate, '.tile-desc{font-size:.65rem;color:rgba(255,255,255,.64);'],
    ['estimate.html .nav-sub >= .68', estimate, '.nav-sub{font-size:.65rem;color:rgba(255,255,255,.68);}'],
    ['estimate.html .step-subtitle >= .68', estimate, '.step-subtitle{color:rgba(255,255,255,.68);'],
    ['estimate.html .progress-label >= .7', estimate, 'text-transform:uppercase;color:rgba(255,255,255,.7);'],
    ['estimate.html .otp-skip-btn >= .7', estimate, '.otp-skip-btn{background:none;border:none;padding:4px;color:rgba(255,255,255,.7);'],
    ['estimate.html .otp-skip-status >= .72', estimate, '.otp-skip-status{font-size:.78rem;margin-top:6px;color:rgba(255,255,255,.72);}'],
    ['estimate.html .unlock-prompt p >= .72', estimate, '.unlock-prompt p{font-size:.88rem;color:rgba(255,255,255,.72);'],
    ['estimate.html .ns-card-desc >= .7', estimate, '.ns-card-desc{font-size:.82rem;color:rgba(255,255,255,.7);'],
    ['estimate.html .tier-tab text >= .68', estimate, 'background:rgba(255,255,255,.04);color:rgba(255,255,255,.68);'],
    ['storm-alerts.html placeholder >= .6', storm, '.field input::placeholder { color:rgba(255,255,255,.6); }'],
  ];
  for (const [name, src, needle] of floors) ok('a11y: ' + name, src.includes(needle));
}

// ── Featured Projects card CSS (guard for the PR #1194 regression class:
// an icon-CSS consolidation deleted our-work.html's whole page style block
// and nothing caught /our-work shipping unstyled) ──────────────────────────
{
  const cardsCss = path.join(DOCS, 'assets/css/project-cards.css');
  ok('project-cards.css exists', fs.existsSync(cardsCss));
  if (fs.existsSync(cardsCss)) {
    const s = fs.readFileSync(cardsCss, 'utf8');
    ok('project-cards.css defines .gallery grid', /\.gallery\{[^}]*display:grid/.test(s));
    ok('project-cards.css defines .project.hidden (filter JS contract)', s.includes('.project.hidden{display:none}'));
  }
  const ourWork = fs.readFileSync(path.join(DOCS, 'our-work.html'), 'utf8');
  ok('our-work.html links project-cards.css', ourWork.includes('/assets/css/project-cards.css'));
  ok('our-work.html page styles present (.hero rule)', ourWork.includes('.hero{background:linear-gradient'));
}

// ── Homepage "Areas we serve" row (2026-10-07). #2206 removed the areas grid
// and with it every homepage link to a town page; 16 core town pages sat
// "Discovered – not indexed". This row puts plain crawlable <a href> links
// back, below the book section (not above the fold), resolving to real pages
// and real towns.json slugs. ─────────────────────────────────────────────────
{
  const home = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  const m = home.match(/<section class="home-areas"[\s\S]*?<\/section>/);
  ok('home: areas row present', !!m);
  const block = m ? m[0] : '';
  const towns = require(path.join(__dirname, '..', 'site-src', 'data', 'towns.json')).towns;
  const known = new Set(towns.map((t) => t.slug));
  const region = new Map(towns.map((t) => [t.slug, t.region]));
  const slugs = [...block.matchAll(/<a href="\/areas\/([a-z0-9-]+)"/g)].map((x) => x[1]);
  ok('home: areas row links >= 12 town pages', slugs.length >= 12, slugs.length);
  ok('home: areas row has no duplicate towns', new Set(slugs).size === slugs.length);
  const missing = slugs.filter((s) => !known.has(s) || !fs.existsSync(path.join(DOCS, 'areas', s + '.html')));
  ok('home: every areas-row link is a towns.json slug with a page', missing.length === 0, missing.join(','));
  ok('home: areas row covers Ohio and Northern Kentucky',
    slugs.some((s) => region.get(s) === 'cincy-oh') && slugs.some((s) => region.get(s) === 'nky'));
  for (const s of ['west-chester-oh', 'milford-oh', 'batavia-oh', 'mason-oh', 'loveland-oh', 'anderson-township-oh',
    'cincinnati-oh', 'florence-ky', 'covington-ky', 'fort-mitchell-ky', 'erlanger-ky']) {
    ok('home: areas row links ' + s, slugs.includes(s));
  }
  ok('home: areas row links /areas', /<a [^>]*href="\/areas"/.test(block));
  ok('home: areas row has no inline handlers or scripts', !/\son[a-z]+=|<script/i.test(block));
  const iContact = home.indexOf('id="contact"');
  const iAreas = home.indexOf('class="home-areas"');
  const iMain = home.indexOf('</main>');
  ok('home: areas row sits after the book section, inside <main>', iContact > 0 && iAreas > iContact && iAreas < iMain);
  ok('home: areas links keep a 44px tap height', /\.ha-links a\{[^}]*min-height:44px/.test(home));
}

// ── GAF vs OC vs Atlas post: no contractor wholesale prices (Jo 2026-10-07).
// Public pages carry installed/retail figures only (public-price-policy). ────
{
  const post = fs.readFileSync(path.join(DOCS, 'blog', 'gaf-vs-owens-corning-vs-atlas-shingles.html'), 'utf8');
  const body = (post.match(/<article>[\s\S]*?<\/article>/) || [''])[0];
  ok('blog gaf-vs-oc-vs-atlas: article body found', body.length > 1000);
  ok('blog gaf-vs-oc-vs-atlas: no wholesale/contractor price wording', !/wholesale|prices for contractors/i.test(body));
  ok('blog gaf-vs-oc-vs-atlas: no material-only cost box', !/Material Costs Only/i.test(body));
  const perSq = [...body.matchAll(/\$(\d{2,3})(?:–|-)\$(\d{2,3}) per/g)].map((x) => +x[1]);
  ok('blog gaf-vs-oc-vs-atlas: per-square figures are installed retail (>= $500)', perSq.every((n) => n >= 500), perSq.join(','));
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
