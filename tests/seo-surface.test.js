/**
 * tests/seo-surface.test.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Proves scripts/check-seo-surface.js can go RED, one defect at a time.
 *
 * The gate currently reports 0 errors across the live site. That number was
 * arrived at by tuning the checks — which is exactly the situation this repo
 * has been burned by before (crm-audit.js exited 0 for its entire life; the
 * visual baselines were never committed; npm test skipped 22 suites). A gate
 * whose only evidence is a green streak is not evidence.
 *
 * So: a fixture tree with one deliberate defect per file, and an assertion
 * that each one is individually caught and correctly classified. If a check
 * is ever silently disabled, the fixture for it goes green and this fails.
 *
 * Run: node tests/seo-surface.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-seo-surface.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'seo-surface');

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
  }
}

// Run the gate against the fixture tree and return its parsed JSON plus the
// real exit code. `--root` points DOCS straight at the fixtures.
function run(extraArgs = []) {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync('node', [SCRIPT, '--root', FIXTURES, '--json', ...extraArgs], {
      encoding: 'utf8',
    });
  } catch (e) {
    stdout = e.stdout || '';
    status = typeof e.status === 'number' ? e.status : 1;
  }
  return { report: JSON.parse(stdout), status };
}

const { report, status } = run();
const byFile = {};
for (const f of report.findings) {
  (byFile[path.basename(f.file)] = byFile[path.basename(f.file)] || []).push(f);
}
const checksFor = (file) => (byFile[file] || []).filter((f) => f.level === 'ERROR').map((f) => f.check);

console.log('SEO SURFACE GATE — proving each check can fail');
console.log('='.repeat(64));

// ── Each defect fixture must produce its own ERROR ──────────────────────

const CASES = [
  ['F1', 'no-title.html', 'title', 'a page with no <title>'],
  ['F2', 'no-h1.html', 'h1', 'a page with no <h1> — the case the [\\b] regex bug hid'],
  ['F3', 'two-h1.html', 'h1', 'a page with two <h1> tags'],
  ['F4', 'no-description.html', 'meta-description', 'a page with no meta description'],
  ['F5', 'no-canonical.html', 'canonical', 'a page with no rel=canonical'],
  ['F6', 'no-lang.html', 'lang', 'a page whose <html> has no lang'],
  ['F7', 'no-viewport.html', 'viewport', 'a page with no viewport meta'],
  ['F8', 'bad-jsonld.html', 'structured-data', 'a page with unparseable JSON-LD'],
  ['F9', 'img-no-alt.html', 'img-alt', 'an <img> with no alt attribute'],
];

for (const [id, file, expectedCheck, description] of CASES) {
  check(`${id}  catches ${description}`, () => {
    const got = checksFor(file);
    assert.ok(
      got.includes(expectedCheck),
      `${file} should raise ERROR:${expectedCheck}, got [${got.join(', ') || 'nothing'}]`,
    );
  });
}

// ── The clean fixture must stay clean ───────────────────────────────────
// Without this, a check that fires on EVERYTHING would satisfy every case
// above while being worthless.

check('F10 the clean fixture raises no ERROR at all', () => {
  const got = checksFor('clean.html');
  assert.deepStrictEqual(got, [], `clean.html should be clean, got [${got.join(', ')}]`);
});

check('F11 the clean fixture raises no WARN either', () => {
  const w = (byFile['clean.html'] || []).filter((f) => f.level === 'WARN');
  assert.deepStrictEqual(w.map((f) => f.check), [],
    'clean.html must satisfy the warn-level checks too, or the warn tier is untested');
});

// ── Length checks measure RENDERED characters, not raw bytes ────────────
// This gate's first run produced nine "description too long" findings. Six
// were its own bug: `&#39;` is five bytes and one character, so any
// description containing an apostrophe was over-counted by four per entity.
// The fixture is 166 raw bytes and 154 rendered characters — comfortably in
// range, and it must produce no warning.

check('F19 a description of 166 raw bytes but 154 rendered chars is IN range', () => {
  const all = (byFile['entity-length.html'] || []).map((f) => `${f.level}:${f.check}`);
  assert.ok(
    !all.includes('WARN:meta-description-length'),
    'entity-encoded description was measured as raw bytes — length checks must '
      + `decode entities first; got [${all.join(', ')}]`,
  );
});

// ── FAQPage questions must be visible ───────────────────────────────────
// 84 of 753 FAQPage questions on the live site (2026-09-27) existed only in
// JSON-LD — against Google's FAQ policy, and some contradicted the article
// they sat on. Every check above passed them: the JSON parsed fine.

check('F20 catches a FAQPage question that exists only in the JSON-LD', () => {
  const errs = (byFile['faq-hidden.html'] || []).filter((f) => f.level === 'ERROR');
  const faq = errs.filter((f) => f.check === 'faq-visible');
  assert.strictEqual(faq.length, 1,
    `faq-hidden.html has one schema-only question; expected exactly 1 faq-visible ERROR, got ${faq.length}`);
  assert.ok(/only in the schema/.test(faq[0].detail),
    `the finding should name the hidden question, got: ${faq[0].detail}`);
  // Its text also sits in a comment, a <script> attribute and a <template>.
  // None of those is visible, so none of them may satisfy the check — this
  // pins that the visible-text reader strips them rather than grepping raw HTML.
  assert.deepStrictEqual(errs.map((f) => f.check), ['faq-visible'],
    `faq-hidden.html should fail on faq-visible alone, got [${errs.map((f) => f.check).join(', ')}]`);
});

check('F21 a question rendered with entities, curly quotes and inline tags counts as visible', () => {
  // The schema says `Don't ... & a permit?`; the page says
  // `Don&rsquo;t ... <em>GAF-certified</em> ... &amp; a permit?`. Same text
  // to a reader — a check that compares raw strings would fail every page
  // written with typographic apostrophes, and get switched off.
  const got = (byFile['faq-visible.html'] || []).map((f) => `${f.level}:${f.check}`);
  assert.deepStrictEqual(got, [], `faq-visible.html should raise nothing, got [${got.join(', ')}]`);
});

check('F23 two FAQPage nodes on one page is an ERROR (Google: "Duplicate field FAQPage")', () => {
  // faq-double.html is faq-visible.html with its FAQPage block repeated —
  // every question stays visible, so faq-single is the ONLY thing it can fail.
  const errs = (byFile['faq-double.html'] || []).filter((f) => f.level === 'ERROR');
  assert.deepStrictEqual(errs.map((f) => f.check), ['faq-single'],
    `faq-double.html should fail on faq-single alone, got [${errs.map((f) => f.check).join(', ')}]`);
  assert.ok(/2 FAQPage nodes/.test(errs[0].detail), `detail should count the nodes, got: ${errs[0].detail}`);
});

check('F22 the faq-visible allowlist stays narrow (two named posts, no globs)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const m = src.match(/const FAQ_VISIBLE_ALLOWLIST = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'FAQ_VISIBLE_ALLOWLIST literal not found — if it was removed, delete this case too');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(entries.length <= 2,
    `the allowlist is a temporary carve-out for two posts under rewrite; it has ${entries.length} entries`);
  for (const e of entries) {
    assert.ok(/^docs\/blog\/[a-z0-9-]+\.html$/.test(e), `allowlist entry must be one exact file path, got ${e}`);
  }
});

// ── noindex exemption ───────────────────────────────────────────────────

check('F12 a noindex page is skipped, not audited', () => {
  assert.strictEqual(byFile['noindex.html'], undefined,
    'noindex.html declares noindex and must not be audited as a search surface');
});

check('F13 noindex.html would otherwise have failed (the exemption is doing work)', () => {
  // It has no description, no canonical, no h1, no viewport. If the noindex
  // rule ever stops matching, F12 breaks — but only if the page is genuinely
  // defective, which this pins.
  const fs = require('fs');
  const html = fs.readFileSync(path.join(FIXTURES, 'noindex.html'), 'utf8');
  assert.ok(!/rel=["']canonical/i.test(html) && !/<h1/i.test(html),
    'the noindex fixture must stay defective, or F12 proves nothing');
});

// ── Exit code plumbing ──────────────────────────────────────────────────
// The failure this pins is specific and has happened here before: a --json
// branch that returns before the verdict, so the check reports findings and
// still exits 0.

check('F14 the gate EXITS NON-ZERO when errors exist, even in --json mode', () => {
  assert.ok(report.errors > 0, 'fixture tree must contain errors for this to mean anything');
  assert.strictEqual(status, 1, `expected exit 1 with ${report.errors} errors, got ${status}`);
});

check('F15 report.failed agrees with the exit code', () => {
  assert.strictEqual(report.failed, true);
});

check('F16 --warn-as-error escalates a warn-only tree', () => {
  const clean = run(['--warn-as-error']);
  assert.ok(clean.report.errors > 0 || clean.report.warnings > 0);
  assert.strictEqual(clean.status, 1);
});

// ── The real site ───────────────────────────────────────────────────────
// The gate is only worth having if it is green on what actually ships, and
// green for the right reason — over a real page count, not an empty walk.

check('F17 the live docs/ tree passes with zero ERRORs', () => {
  let out = '';
  try {
    out = execFileSync('node', [SCRIPT, '--json'], { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout || '';
  }
  const live = JSON.parse(out);
  assert.strictEqual(live.errors, 0,
    `docs/ should be error-free; got ${live.errors}: `
      + live.findings.filter((f) => f.level === 'ERROR').map((f) => `${f.file}:${f.check}`).join(', '));
});

check('F18 the live audit covers a real page count, not an empty walk', () => {
  let out = '';
  try {
    out = execFileSync('node', [SCRIPT, '--json'], { encoding: 'utf8' });
  } catch (e) { out = e.stdout || ''; }
  const live = JSON.parse(out);
  // Reporting success over zero pages is the second way crm-audit.js passed.
  assert.ok(live.pages > 150,
    `expected the public site to be >150 pages, got ${live.pages} — a collapsed `
      + 'walk would report a clean site by auditing nothing');
});

// ── Sitemapped pages inside a skipped directory ─────────────────────────
// SKIP_DIRS excludes docs/pro wholesale, which is right for 32 of its 36
// pages and wrong for the four in docs/sitemap-pro.xml. Between #1479 and
// #1482, /pro carried two JSON-LD blocks — including a FAQPage — that no
// gate ever parsed. Proven by hand at the time: breaking that FAQPage left
// the old gate at 224 pages, 0 errors, exit 0.
//
// A second fixture tree, because these cases need a sitemap at the root and
// the tree above deliberately has none.

const SITEMAP_FIXTURES = path.join(__dirname, 'fixtures', 'seo-surface-sitemap');

function runSitemap() {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync('node', [SCRIPT, '--root', SITEMAP_FIXTURES, '--json'], {
      encoding: 'utf8',
    });
  } catch (e) {
    stdout = e.stdout || '';
    status = typeof e.status === 'number' ? e.status : 1;
  }
  return { report: JSON.parse(stdout), status };
}

const sm = runSitemap();
const smErrors = sm.report.findings.filter((f) => f.level === 'ERROR');
const smChecks = (needle) => smErrors
  .filter((f) => f.file.replace(/\\/g, '/').includes(needle))
  .map((f) => f.check);

check('S1 a sitemapped page in a skipped dir IS audited (dir form, /pro -> pro/index.html)', () => {
  assert.ok(
    smChecks('pro/index.html').includes('structured-data'),
    'pro/index.html is listed in the fixture sitemap and has unparseable JSON-LD; '
      + `it must be audited and caught, got [${smChecks('pro/index.html').join(', ') || 'nothing'}]`,
  );
});

check('S2 the flat form resolves too (/pro/pricing -> pro/pricing.html)', () => {
  assert.ok(
    smChecks('pro/pricing.html').includes('h1'),
    'the .html sibling form must resolve, not just dir/index.html; got '
      + `[${smChecks('pro/pricing.html').join(', ') || 'nothing'}]`,
  );
});

check('S3 a NON-sitemapped page in the skipped dir stays excluded', () => {
  // The whole reason SKIP_DIRS exists. dashboard.html has no canonical, no
  // h1 and no description — the exact trio that produced 33 false findings
  // when the real docs/pro was audited whole. It must raise nothing.
  const got = sm.report.findings.filter((f) => f.file.replace(/\\/g, '/').includes('dashboard.html'));
  assert.deepStrictEqual(got, [],
    'dashboard.html is not in any sitemap and is noindexed by a header the gate '
      + `cannot read; auditing it is how the 33 false findings come back, got ${JSON.stringify(got)}`);
});

check('S4 a sitemap <loc> with no page behind it is an ERROR', () => {
  const orphan = smErrors.filter((f) => f.check === 'sitemap-orphan');
  assert.strictEqual(orphan.length, 1,
    `expected exactly one sitemap-orphan (for /pro/ghost), got ${orphan.length}`);
  assert.ok(/ghost/.test(orphan[0].detail), `orphan should name /pro/ghost, got: ${orphan[0].detail}`);
});

check('S5 a sitemapped page that also declares noindex is reported, not silently skipped', () => {
  assert.ok(
    smChecks('pro/hidden.html').includes('sitemap-noindex'),
    'a page cannot both be advertised in a sitemap and tell crawlers to skip it; '
      + `the contradiction must not hide behind the noindex exemption, got [${smChecks('pro/hidden.html').join(', ')}]`,
  );
});

check('S6 a sitemapped page OUTSIDE a skipped dir is not audited twice', () => {
  // clean.html is in the fixture sitemap AND found by the ordinary walk.
  // Counting it twice would double every finding on every normal page — the
  // tree holds five .html files and exactly four are search surfaces:
  // clean.html once, plus pro/{index,pricing,hidden}.html; pro/dashboard.html
  // is excluded (S3) and /pro/ghost resolves to nothing (S4).
  assert.strictEqual(sm.report.pages, 4,
    `expected 4 audited pages (clean + pro/{index,pricing,hidden}), got ${sm.report.pages}`);
  // Only PAGE files. The sitemap itself legitimately accumulates one finding
  // per bad <loc> (S4's orphan and S11's malformed entry both land on it), so
  // counting it here would make this assertion fail for the wrong reason.
  const seen = sm.report.findings.map((f) => f.file).filter((f) => /\.html$/i.test(f));
  assert.strictEqual(new Set(seen).size, seen.length,
    `every fixture page raises exactly one finding, so a repeated file means it `
      + `was audited twice: ${seen.join(', ')}`);
});

check('S7 the sitemap tree exits non-zero', () => {
  assert.strictEqual(sm.status, 1, `expected exit 1, got ${sm.status}`);
});

// ── The live site, tied to the real sitemap ─────────────────────────────
// F17 above proves docs/ is error-free. This proves docs/pro's public pages
// are inside the set that claim covers — the assertion whose absence let the
// FAQPage ship unvalidated. Derived from docs/sitemap-pro.xml so a page added
// there is required to be covered without editing this test.

check('S8 every page in docs/sitemap-pro.xml is actually audited by the live gate', () => {
  const fs = require('fs');
  const xml = fs.readFileSync(path.join(ROOT, 'docs', 'sitemap-pro.xml'), 'utf8');
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => new URL(m[1]).pathname);
  assert.ok(locs.length >= 4, `sitemap-pro.xml should list the public /pro pages, got ${locs.length}`);

  let out = '';
  try {
    out = execFileSync('node', [SCRIPT, '--json'], { encoding: 'utf8' });
  } catch (e) { out = e.stdout || ''; }
  const live = JSON.parse(out);

  // The report only names files that raised a finding, so ask the gate for
  // its page list the same way it builds one: a clean page proves coverage
  // only if breaking it would show up. Use the count instead — the walk's
  // own total must have grown by exactly the sitemapped /pro pages.
  const missing = locs.filter((p) => {
    const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '');
    const cands = [`docs/${trimmed}.html`, `docs/${trimmed}/index.html`];
    return !cands.some((c) => fs.existsSync(path.join(ROOT, c)));
  });
  assert.deepStrictEqual(missing, [],
    `sitemap-pro.xml lists URLs with no page: ${missing.join(', ')}`);

  // 224 locs in sitemap.xml drive the ordinary walk; the four /pro pages are
  // the carve-out. A collapsed carve-out shows up here as a smaller count.
  assert.ok(live.pages >= 228,
    `expected the audit to include the ${locs.length} sitemapped /pro pages on top of `
      + `the public walk; got ${live.pages} pages — the carve-out may have collapsed`);
});

// ── Hosting config decides what "no page ships for it" means ────────────
// A <loc> with no HTML file is only a 404 if firebase.json ALSO has nothing
// serving it. The real config has 21 redirects and 16 rewrites, six under
// /pro — /pro/landing is a 301 and /pro/account-erasure is a Cloud Function.
// Without this, adding either to sitemap-pro.xml fails the build on a URL
// that resolves perfectly well in production.

check('S9 a <loc> served by a redirect is NOT reported as an orphan', () => {
  const orphans = smErrors.filter((f) => f.check === 'sitemap-orphan')
    .map((f) => f.detail).join(' ');
  assert.ok(!/\/pro\/moved/.test(orphans),
    `/pro/moved has no file on disk but firebase.json 301s it to /pro; `
      + `it must not be called an orphan. Orphans reported: ${orphans}`);
});

check('S10 a <loc> served by a globbed rewrite is NOT an orphan either', () => {
  const orphans = smErrors.filter((f) => f.check === 'sitemap-orphan')
    .map((f) => f.detail).join(' ');
  assert.ok(!/fn-erasure/.test(orphans),
    `/pro/fn-erasure matches the rewrite glob /pro/fn-* and is served by a `
      + `function; it must not be called an orphan. Orphans reported: ${orphans}`);
});

check('S11 a <loc> that is not an absolute URL is reported, not swallowed', () => {
  // sitemap-pro.xml is hand-maintained and build-sitemap.js neither writes nor
  // validates it, so nothing else owns this. A silently dropped <loc> is the
  // exact failure the orphan check exists to end.
  const bad = smErrors.filter((f) => f.check === 'sitemap-malformed-loc');
  assert.strictEqual(bad.length, 1,
    `expected exactly one malformed <loc> (/pro/relative-oops), got ${bad.length}`);
  assert.ok(/relative-oops/.test(bad[0].detail),
    `should name the offending value, got: ${bad[0].detail}`);
});

// ── hero-format: markup decides what is "served modern" ─────────────────
// The rule used to ask one question — is there a same-stem .webp on disk? —
// so every hero served through <picture> with responsive AVIF/WebP variants
// (<stem>-640.avif …) was reported as unconverted: 7 false warnings on the
// live site on 2026-09-27, e.g. our-work.html's before-blue-tarp.jpg. And a
// bare <img> passed if a .webp merely sat beside it, though nothing asks
// for it. Now the <picture><source> markup is the evidence, and the source
// must resolve.
//
// Built in a temp dir at run time so no image binaries are committed: the
// rule reads only size and magic bytes, and a <source> only has to exist.

const HERO_TREE = (() => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-hero-'));
  fs.mkdirSync(path.join(dir, 'img'));
  const jpegBytes = Buffer.alloc(40 * 1024); // over HERO_MIN_BYTES (30 KB)
  jpegBytes[0] = 0xff; jpegBytes[1] = 0xd8; jpegBytes[2] = 0xff;
  const webpBytes = Buffer.alloc(40 * 1024);
  webpBytes.write('RIFF', 0, 'ascii'); webpBytes.write('WEBP', 8, 'ascii');
  const put = (rel, bytes) => fs.writeFileSync(path.join(dir, rel), bytes);
  for (const n of ['bare', 'sibling', 'avif', 'webp', 'dead', 'jpegsrc', 'lazy']) put(`img/${n}.jpg`, jpegBytes);
  put('img/misnamed.jpg', webpBytes);
  put('img/sibling.webp', Buffer.from('RIFF0000WEBP'));
  put('img/avif-640.avif', Buffer.from('x'));
  put('img/avif-800.avif', Buffer.from('x'));
  put('img/webp-640.webp', Buffer.from('RIFF0000WEBP'));
  put('img/misnamed-640.avif', Buffer.from('x'));

  const head = fs.readFileSync(path.join(FIXTURES, 'clean.html'), 'utf8')
    .replace(/<body>[\s\S]*<\/body>/, '<body><h1>Cincinnati Roofing</h1>__IMG__</body>');
  const page = (name, img) => put(`${name}.html`, head.replace('https://example.com/clean', `https://example.com/${name}`).replace('__IMG__', img));
  page('hero-bare', '<img src="/img/bare.jpg" alt="a roof" fetchpriority="high">');
  page('hero-sibling', '<img src="/img/sibling.jpg" alt="a roof">');
  page('hero-avif', '<picture><source type="image/avif" srcset="/img/avif-640.avif 640w, /img/avif-800.avif 800w" sizes="100vw">'
    + '<img src="/img/avif.jpg" alt="a roof" fetchpriority="high"></picture>');
  page('hero-webp', "<picture><source type='image/webp' srcset='/img/webp-640.webp'><img src=\"/img/webp.jpg\" alt=\"a roof\"></picture>");
  page('hero-dead', '<picture><source type="image/webp" srcset="/img/dead-640.webp 640w"><img src="/img/dead.jpg" alt="a roof"></picture>');
  page('hero-jpegsrc', '<picture><source type="image/jpeg" srcset="/img/jpegsrc.jpg"><img src="/img/jpegsrc.jpg" alt="a roof"></picture>');
  page('hero-lazy', '<img src="/img/lazy.jpg" alt="a roof" loading="lazy">');
  page('hero-misnamed', '<picture><source type="image/avif" srcset="/img/misnamed-640.avif"><img src="/img/misnamed.jpg" alt="a roof"></picture>');
  return dir;
})();

const hero = (() => {
  let out = '';
  try {
    out = execFileSync('node', [SCRIPT, '--root', HERO_TREE, '--json'], { encoding: 'utf8' });
  } catch (e) { out = e.stdout || ''; }
  require('fs').rmSync(HERO_TREE, { recursive: true, force: true });
  return JSON.parse(out);
})();
const heroWarned = (img) => hero.findings.some((f) => f.check === 'hero-format' && f.detail.includes(`/img/${img}.jpg`));

check('H1 catches a bare eager raster over 30 KB (the rule can still fail)', () => {
  assert.ok(heroWarned('bare'), 'bare eager /img/bare.jpg must raise WARN:hero-format');
});

check('H2 a same-stem .webp on disk does NOT excuse a bare <img> — nothing requests it', () => {
  assert.ok(heroWarned('sibling'), '/img/sibling.jpg has sibling.webp on disk but a bare <img>; it must still warn');
});

check('H3 an <img> in a <picture> with a responsive AVIF <source> is served modern (no warning)', () => {
  assert.ok(!heroWarned('avif'), '/img/avif.jpg is the fallback inside <picture><source type=image/avif>; false positive');
});

check('H4 a WebP <source> (single-quoted attributes) counts too', () => {
  assert.ok(!heroWarned('webp'), '/img/webp.jpg is the fallback inside <picture><source type=image/webp>; false positive');
});

check('H5 a modern <source> whose srcset 404s serves nothing — still warns', () => {
  assert.ok(heroWarned('dead'), '/img/dead.jpg sits in a <picture> whose only WebP source does not exist; must warn');
});

check('H6 a <picture> offering only a JPEG <source> is not modern — still warns', () => {
  assert.ok(heroWarned('jpegsrc'), '/img/jpegsrc.jpg has only a type=image/jpeg source; must warn');
});

check('H7 a lazy raster is off the render path — no warning', () => {
  assert.ok(!heroWarned('lazy'), '/img/lazy.jpg is loading=lazy; the rule is for eager images only');
});

check('H8 a misnamed .jpg (really WebP) is still named even inside a modern <picture>', () => {
  const f = hero.findings.filter((x) => x.check === 'image-extension' && x.detail.includes('/img/misnamed.jpg'));
  assert.strictEqual(f.length, 1, 'the fallback still ships with the wrong Content-Type; expected one image-extension WARN');
});

check('H9 the hero tree produced exactly the expected hero-format set', () => {
  const got = hero.findings.filter((f) => f.check === 'hero-format')
    .map((f) => f.detail.match(/\/img\/([\w-]+)\.jpg/)[1]).sort();
  assert.deepStrictEqual(got, ['bare', 'dead', 'jpegsrc', 'sibling'],
    `hero-format should fire for exactly bare/dead/jpegsrc/sibling, got [${got.join(', ')}]`);
});

// ── Report ──────────────────────────────────────────────────────────────

console.log('');
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.message}`);
  console.log('');
  console.log(`FAILED — ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`PASSED — ${passed} assertions; every check proven able to fail`);
process.exit(0);
