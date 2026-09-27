#!/usr/bin/env node
/**
 * build-blog-index.mjs — regenerates the static blog card grid inside blog.html
 *
 * WHY: The blog index renders cards client-side from a hardcoded POSTS array,
 * so the served HTML contains zero links to posts. Crawlers and AI models see
 * an empty blog and the index passes no internal link equity. This script
 * pre-renders the currently-live cards as static HTML at build/deploy time.
 * The existing JS keeps running unchanged (it re-renders identical cards and
 * still handles scheduled-post countdowns), so behavior is unaffected —
 * progressive enhancement, not replacement.
 *
 * USAGE:
 *   node scripts/build-blog-index.mjs <file-with-POSTS> <blog-html-file>
 *   Real invocation (same one .github/workflows/firebase-deploy.yml runs):
 *   node scripts/build-blog-index.mjs docs/assets/js/inline/c00f1acac9.js docs/blog/index.html
 *
 * ONE-TIME SETUP: two marker pairs in the blog HTML.
 *   Cards, inside the grid div (the client JS re-renders identical cards
 *   over them, so they belong inside):
 *     <div id="blog-posts-grid"><!-- BLOG-STATIC-START --><!-- BLOG-STATIC-END --></div>
 *   Schema, wrapped around the <head>'s JSON-LD script — the head is never
 *   touched by renderPosts()'s innerHTML wipe, so JS-executing crawlers keep
 *   it, and the generator owning it means the ItemList/numberOfItems can't
 *   go stale when posts are added:
 *     <!-- BLOG-HEAD-SCHEMA-START --><script …>…</script><!-- BLOG-HEAD-SCHEMA-END -->
 * The script refuses to run without them (no fragile HTML parsing).
 *
 * RUN THIS as part of every deploy, and any time the POSTS array changes.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , postsFile, htmlFile] = process.argv;
if (!postsFile || !htmlFile) {
  console.error('usage: node scripts/build-blog-index.mjs <file-with-POSTS> <blog-html-file>');
  process.exit(1);
}

const src = readFileSync(postsFile, 'utf8');
const m = src.match(/const POSTS\s*=\s*(\[[\s\S]*?\]);/);
if (!m) { console.error(`No "const POSTS = [...]" found in ${postsFile}`); process.exit(1); }

// The array is trusted first-party source (object literals only) — same
// trust level as shipping it to every browser, which the site already does.
const POSTS = new Function(`return ${m[1]};`)();

// Quotes are escaped too because esc() output lands inside double-quoted
// attributes (href="..."). Entities already present in POSTS come through
// exactly as the client-side renderer ships them, so static and JS-rendered
// cards stay consistent.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const today = new Date(); today.setHours(0, 0, 0, 0);

const live = POSTS.filter((p) => {
  if (!p.url || p.audience === 'contractor') return false;      // mirrors renderPosts()
  const d = new Date(p.published); d.setHours(0, 0, 0, 0);
  return d <= today;                                            // scheduled posts stay JS-only
});

// First live card carries the `featured` class to mirror renderPosts(), which
// promotes its first non-coming-soon card via classList.add('featured'). The
// static markup matching the JS-rendered markup is what prevents a visible
// full-grid reflow (CLS) when the client re-render kicks in.
const card = (p, i) => `      <article class="post-card${i === 0 ? ' featured' : ''}">
        <div class="post-card-body">
          <span class="post-tag">${esc(p.tag)}</span>
          <h2><a href="${esc(p.url)}">${esc(p.title)}</a></h2>
          <div class="post-meta">${esc(p.meta)}</div>
          <p class="post-excerpt">${esc(p.excerpt)}</p>
          <a href="${esc(p.url)}" class="post-read-more">Read Article &rarr;</a>
        </div>
      </article>`;

const ORIGIN = 'https://nobigdealwithjoedeal.com';
// One @graph in <head>, generator-owned end to end: the Blog node keeps the
// hand-authored identity (name/description/publisher) verbatim and carries
// the BlogPosting list; the ItemList is regenerated so its positions and
// numberOfItems can never drift from the real post set.
const schema = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Blog',
      '@id': `${ORIGIN}/blog#blog`,
      name: 'The No Big Deal Blog',
      url: `${ORIGIN}/blog`,
      description: 'Straight-talk roofing, siding, and insurance-claim advice for Cincinnati-area homeowners from Joe Deal — 7 years in insurance restoration, no fluff.',
      // The business and Joe are defined ONCE, in the schema-entity partial
      // (site-src/partials/schema-entity.html) stamped into this page's <head>;
      // everything here references them by @id. An inline copy is a second,
      // disconnected business, and check-seo-surface.js fails the build on it.
      publisher: { '@id': `${ORIGIN}/#org` },
      blogPost: live.map((p) => ({
        '@type': 'BlogPosting',
        headline: p.title,
        url: `${ORIGIN}${p.url}`,
        datePublished: p.published,
        author: { '@id': `${ORIGIN}/#joe` },
      })),
    },
    {
      '@type': 'ItemList',
      '@id': `${ORIGIN}/blog#posts`,
      itemListOrder: 'https://schema.org/ItemListOrderDescending',
      numberOfItems: live.length,
      itemListElement: live.map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: p.title,
        url: `${ORIGIN}${p.url}`,
      })),
    },
  ],
};

const cardsBlock = `<!-- BLOG-STATIC-START -->
<!-- generated by build-blog-index.mjs — do not hand-edit; ${live.length} live posts as of ${today.toISOString().slice(0, 10)} -->
${live.map(card).join('\n')}
<!-- BLOG-STATIC-END -->`;

const schemaBlock = `<!-- BLOG-HEAD-SCHEMA-START -->
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<!-- BLOG-HEAD-SCHEMA-END -->`;

let html = readFileSync(htmlFile, 'utf8');

const replaceBetween = (name, re, block) => {
  if (!re.test(html)) {
    console.error(`${name} markers not found in ${htmlFile}.
Add <!-- ${name}-START --><!-- ${name}-END --> once (cards inside <div id="blog-posts-grid">, schema right AFTER its closing </div>).`);
    process.exit(1);
  }
  // Callback form on purpose: string-form .replace treats $-sequences
  // ($&, $', $$) in post titles/excerpts as substitution patterns and
  // silently corrupts the output.
  html = html.replace(re, () => block);
};

replaceBetween('BLOG-STATIC', /<!-- BLOG-STATIC-START -->[\s\S]*?<!-- BLOG-STATIC-END -->/, cardsBlock);
replaceBetween('BLOG-HEAD-SCHEMA', /<!-- BLOG-HEAD-SCHEMA-START -->[\s\S]*?<!-- BLOG-HEAD-SCHEMA-END -->/, schemaBlock);

writeFileSync(htmlFile, html);
console.log(`OK: ${live.length} static cards + Blog schema written into ${htmlFile}`);
