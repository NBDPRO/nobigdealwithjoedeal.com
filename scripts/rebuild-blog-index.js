#!/usr/bin/env node
/**
 * Rebuild the blog index from docs/blog/*.html files.
 *
 * Usage:
 *   node scripts/rebuild-blog-index.js              # Just regenerate POSTS array from existing HTML dates
 *   node scripts/rebuild-blog-index.js --reschedule # Also rewrite dates per SEASONAL_MAP below
 *
 * The seasonal map clusters posts around Cincinnati roofing seasonality:
 *   - Premium-components series (Mar-Apr 2026): cluster recent, LumaNail anchors at -4 wks
 *   - Insurance season (Dec-Feb): moderate cadence
 *   - Late-fall post-storm settlements (Oct-Nov 2025): paired
 *   - Peak summer hail/replacement season (May-Jul 2025): clustered
 *   - Pre-season basics (Mar-Apr 2025): foundational posts
 *
 * Add a new blog post: drop the HTML file in docs/blog/, set its
 * <meta property="article:published_time"> to your chosen date, then run
 * `node scripts/rebuild-blog-index.js`. POSTS array auto-updates.
 *
 * Repaired 2026-07: the POSTS array moved OUT of blog/index.html into a
 * hash-named inline module (May 2026 CSP extraction) — this script now
 * locates that module by content scan and rewrites POSTS there, then
 * re-runs scripts/build-blog-index.mjs so the static card grid + Blog
 * schema in index.html stay in sync (one command = post fully published).
 * Posts whose HTML carries <meta name="robots" content="…noindex…"> are
 * skipped — deliberately unlisted stubs stay out of POSTS. Hand-curated
 * fields on existing entries (e.g. audience: 'contractor') are preserved.
 */

const fs = require('fs');
const path = require('path');

const BLOG_DIR = path.join(__dirname, '..', 'docs', 'blog');
const INDEX_FILE = path.join(BLOG_DIR, 'index.html');
const RESCHEDULE = process.argv.includes('--reschedule');
const { execFileSync } = require('child_process');

// The POSTS array lives in a hash-named inline module. Locate it by content
// so a future re-hash/rename can't silently break this script.
function locatePostsFile() {
  const dir = path.join(__dirname, '..', 'docs', 'assets', 'js', 'inline');
  const hits = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(dir, f))
    .filter(f => /const POSTS\s*=\s*\[/.test(fs.readFileSync(f, 'utf8')));
  if (hits.length !== 1) {
    throw new Error(`Expected exactly one inline module containing "const POSTS = [", found ${hits.length}`);
  }
  return hits[0];
}

// Publish-date map: slug → published date (YYYY-MM-DD), applied by --reschedule.
// Jo, 2026-11-04 (copy-004): keep the blog spread out, but NEVER date a post before it actually went up. The old map
// back-dated these to March 2025 – Feb 2026 when the repo began 2026-03-15 and every post here was first committed
// 2026-03-17 – 2026-06-24. Each date below is on or after the post's first commit (the "first" comment), one a week
// (Tuesdays), avoiding days another post already holds. Never move a date earlier than its "first".
const SEASONAL_MAP = {
  'architectural-shingles-vs-3-tab':                 '2026-03-17', // first 2026-03-17
  'how-long-does-roof-replacement-take-cincinnati':  '2026-03-24', // first 2026-03-17
  'my-roof-is-too-old-will-insurance-still-pay':     '2026-03-31', // first 2026-03-17
  'cincinnati-hail-season-2026':                     '2026-04-07', // first 2026-04-05; pre-season prep
  'signs-your-roof-needs-replacement-vs-repair':     '2026-04-14', // first 2026-04-04
  'why-i-install-lumanail-on-every-elite-roof':      '2026-04-21', // first 2026-04-21; premium-components series anchor
  'why-roofivent-is-on-my-roofs':                    '2026-04-28', // first 2026-04-21; series middle
  'the-pipe-boot-fork':                              '2026-05-05', // first 2026-04-21; series finale
  'how-much-does-roof-cost-cincinnati-2026':         '2026-05-12', // first 2026-04-04
  'does-homeowner-insurance-cover-hail-damage-ohio': '2026-05-19', // first 2026-04-04
  'what-to-expect-roof-insurance-adjuster-visit':    '2026-05-26', // first 2026-04-04
  'how-to-file-storm-damage-insurance-claim-ohio':   '2026-06-02', // first 2026-04-04
  'state-farm-allstate-roof-claims-ohio':            '2026-06-09', // first 2026-03-17
  'how-long-roof-insurance-claim-ohio':              '2026-06-16', // first 2026-04-04
  'gaf-vs-owens-corning-vs-atlas-shingles':          '2026-06-30', // first 2026-04-05 (06-23 held; modified 07-03)
  'can-i-keep-insurance-check-not-fix-roof':         '2026-07-07', // first 2026-04-04
  'tamko-hailguard-first-shingle-with-hail-warranty': '2026-07-21', // first 2026-06-24
};

// Tag inference from slug. Order matters — more specific matchers first.
const TAG_GUESSES = [
  [/^field-notes/, 'Field Notes'],
  [/lumanail|roofivent|pipe-boot|gaf-pivot/, 'Premium Components'],
  [/hail-season|storm-damage/, 'Storm Damage'],
  [/insurance|adjuster|claim|state-farm|allstate|insurance-check/, 'Insurance'],
  [/cost|price|how-much/, 'Pricing Guide'],
  [/shingle|architectural|gaf-vs|signs-your|replacement-take/, 'Roofing'],
];

function guessTag(slug) {
  for (const [re, tag] of TAG_GUESSES) {
    if (re.test(slug)) return tag;
  }
  return 'Roofing';
}

function extractMeta(html, slug) {
  const get = (re) => {
    const m = html.match(re);
    return m ? m[1].trim() : null;
  };
  const title =
    get(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
    get(/<title>([^<|]+)/i) ||
    slug;
  const description =
    get(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
    get(/<meta\s+property="og:description"\s+content="([^"]+)"/i) ||
    '';
  const published =
    get(/<meta\s+property="article:published_time"\s+content="(\d{4}-\d{2}-\d{2})"/i) ||
    get(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/i) ||
    null;
  // Try to recover the existing min-read from the article-meta string
  const readMatch = html.match(/(\d+)\s*min read/i);
  const readMin = readMatch ? parseInt(readMatch[1], 10) : null;
  return {
    title: title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+\|\s+(?:Joe Deal NBD|No Big Deal.*)$/i, ''),
    description: description.replace(/&amp;/g, '&').replace(/&quot;/g, '"'),
    published,
    readMin,
  };
}

function formatMeta(date, readMin) {
  const d = new Date(date + 'T12:00:00Z'); // noon UTC to avoid timezone month-boundary issues
  const monthYear = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const r = readMin || 6;
  return `By Joe Deal · ${monthYear} · ${r} min read`;
}

function rewritePostDatesInHtml(filepath, newDate) {
  let html = fs.readFileSync(filepath, 'utf8');
  const before = html;
  html = html.replace(/<meta\s+property="article:published_time"\s+content="\d{4}-\d{2}-\d{2}"\s*\/?>/i,
    `<meta property="article:published_time" content="${newDate}">`);
  html = html.replace(/"datePublished"\s*:\s*"\d{4}-\d{2}-\d{2}"/g, `"datePublished":"${newDate}"`);
  // A real later update date stays; only a modified date earlier than the new publish date is raised to it (it used to
  // overwrite "Updated Sep 27, 2026" posts with the publish date).
  const keepLater = (m, pre, old) => `${pre}${old > newDate ? old : newDate}"`;
  html = html.replace(/("dateModified"\s*:\s*")(\d{4}-\d{2}-\d{2})"/g, keepLater);
  html = html.replace(/(<meta\s+property="article:modified_time"\s+content=")(\d{4}-\d{2}-\d{2})"/gi, keepLater);
  // Update visible date in article-meta — match common patterns
  const d = new Date(newDate + 'T12:00:00Z');
  const visibleDate = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const monthYearOnly = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  // Replace "<span>Month D, YYYY</span>" or "<span>Month YYYY</span>" patterns
  // The bylines are <span class="post-date">; matching only a bare <span> missed every one of them, which is how the
  // byline and the index drifted apart (copy-004, 2026-11-04).
  html = html.replace(/(<span(?: class="post-date")?>)(?:January|February|March|April|May|June|July|August|September|October|November|December)\s*\d{0,2},?\s*\d{4}(<\/span>)/g,
    `$1${visibleDate}$2`);
  // Also update inline "By Joe Deal · Month YYYY · X min read" strings that aren't inside <span>
  html = html.replace(/By Joe Deal\s*·\s*(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s*·/g,
    `By Joe Deal · ${monthYearOnly} ·`);
  if (html !== before) {
    fs.writeFileSync(filepath, html, 'utf8');
    return true;
  }
  return false;
}

function buildPostsArray(posts) {
  const ordered = [...posts].sort((a, b) => new Date(b.published) - new Date(a.published));
  const lines = ordered.map((p) => {
    return `  {
    url: "/blog/${p.slug}",
    tag: ${JSON.stringify(p.tag)},
    title: ${JSON.stringify(p.title)},
    meta: ${JSON.stringify(p.meta)},
    excerpt: ${JSON.stringify(p.description)},
    published: "${p.published}",${p.audience ? `\n    audience: ${JSON.stringify(p.audience)},` : ''}
  }`;
  });
  return `[\n${lines.join(',\n')}\n]`;
}

function regeneratePostsArray(postsFile, posts) {
  const js = fs.readFileSync(postsFile, 'utf8');
  const arrayLiteral = buildPostsArray(posts);
  const re = /const POSTS = \[[\s\S]*?\n\];/m;
  // Test the pattern explicitly — comparing before/after strings would
  // misread an already-up-to-date array (idempotent re-run) as "not found".
  if (!re.test(js)) {
    throw new Error(`Could not locate POSTS array in ${postsFile} (looking for "const POSTS = [ ... ];")`);
  }
  // Callback form: a string replacement would interpret $-sequences in
  // post titles/excerpts as substitution patterns.
  const replaced = js.replace(re, () => `const POSTS = ${arrayLiteral};`);
  if (replaced === js) {
    console.log('POSTS array already up to date — no rewrite needed.');
    return;
  }
  fs.writeFileSync(postsFile, replaced, 'utf8');
}

function main() {
  const files = fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.html') && f !== 'index.html');
  console.log(`Scanning ${files.length} blog posts in docs/blog/`);

  const posts = files.map(filename => {
    const slug = filename.replace(/\.html$/, '');
    const filepath = path.join(BLOG_DIR, filename);
    const html = fs.readFileSync(filepath, 'utf8');
    const meta = extractMeta(html, slug);
    const noindex = /<meta name="robots" content="[^"]*noindex/.test(html);
    return { slug, filename, filepath, noindex, ...meta, tag: guessTag(slug) };
  }).filter(p => {
    if (p.noindex) { console.log(`  ·  skipping noindex stub (stays out of POSTS): ${p.slug}`); return false; }
    return true;
  });

  if (RESCHEDULE) {
    console.log('Applying SEASONAL_MAP dates to each post HTML file...');
    posts.forEach(p => {
      const newDate = SEASONAL_MAP[p.slug];
      if (newDate) {
        const updated = rewritePostDatesInHtml(p.filepath, newDate);
        p.published = newDate;
        console.log(`  ${updated ? '✓' : '·'}  ${newDate}  ${p.slug}`);
      } else {
        console.warn(`  !  no date in SEASONAL_MAP for ${p.slug} — keeping ${p.published}`);
      }
    });
  }

  // Rebuild meta strings now that we have final dates (use existing readMin if present)
  posts.forEach(p => {
    if (p.published) p.meta = formatMeta(p.published, p.readMin);
  });

  const valid = posts.filter(p => p.published && p.title);
  if (valid.length !== posts.length) {
    console.warn(`Skipped ${posts.length - valid.length} posts missing published date or title`);
  }

  const postsFile = locatePostsFile();
  // Merge, don't clobber: the live POSTS array carries HAND-CURATED copy —
  // tags, titles, and excerpts tuned past the posts' own meta tags (verified
  // drift, Jul 2026). Files stay the source of truth for dates
  // (article:published_time); POSTS stays the source of truth for copy and
  // for hand-set fields like audience: 'contractor'. New files get
  // file-derived copy (curate afterwards if wanted). Pass --rebuild-all to
  // deliberately regenerate every entry from file meta.
  const REBUILD_ALL = process.argv.includes('--rebuild-all');
  const existingMatch = fs.readFileSync(postsFile, 'utf8').match(/const POSTS\s*=\s*(\[[\s\S]*?\]);/);
  const existingByUrl = new Map(
    (existingMatch ? new Function(`return ${existingMatch[1]};`)() : []).map(e => [e.url, e])
  );
  valid.forEach(p => {
    const prev = existingByUrl.get(`/blog/${p.slug}`);
    if (!prev) { console.log(`  +  new post: ${p.slug}`); return; }
    if (prev.audience) p.audience = prev.audience;
    if (!REBUILD_ALL) {
      if (prev.tag) p.tag = prev.tag;
      if (prev.title) p.title = prev.title;
      if (prev.excerpt) p.description = prev.excerpt;
    }
  });

  regeneratePostsArray(postsFile, valid);
  console.log(`\nWrote POSTS array (${valid.length} entries) to ${path.relative(process.cwd(), postsFile)}`);

  console.log('Regenerating static card grid + Blog schema in blog/index.html…');
  execFileSync(process.execPath, [path.join(__dirname, 'build-blog-index.mjs'), postsFile, INDEX_FILE], { stdio: 'inherit' });

  console.log('\nFinal cadence (newest → oldest):');
  [...valid].sort((a, b) => new Date(b.published) - new Date(a.published)).forEach(p => {
    console.log(`  ${p.published}  [${p.tag.padEnd(20)}]  ${p.slug}`);
  });
}

main();
