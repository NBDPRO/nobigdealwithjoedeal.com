#!/usr/bin/env node
/**
 * build-feed.mjs — generates the RSS 2.0 feed (docs/feed.xml) from the blog
 * POSTS array.
 *
 * WHY: The blog has no feed, so syndication surfaces (feed readers, blog
 * aggregators, IFTTT-style auto-posters) and the crawlers that watch feeds
 * for fresh URLs have nothing to consume. This pre-renders the currently-live
 * posts as a static feed at build/deploy time — same source of truth and same
 * live-post filter as build-blog-index.mjs, so the feed can never disagree
 * with the blog index.
 *
 * USAGE:
 *   node scripts/build-feed.mjs            # dry run: diff vs docs/feed.xml, exit 1 on drift
 *   node scripts/build-feed.mjs --write    # write docs/feed.xml
 *
 * DETERMINISM: every timestamp is derived from each post's `published` date
 * (fixed to 12:00:00 GMT), and lastBuildDate is the newest item's pubDate —
 * never "now". Re-running against an unchanged POSTS array is byte-identical,
 * which is what lets CI treat drift as a hard failure without flapping.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

const POSTS_FILE = 'docs/assets/js/inline/c00f1acac9.js';
const FEED_FILE = 'docs/feed.xml';
const ORIGIN = 'https://nobigdealwithjoedeal.com';

const args = process.argv.slice(2);
const write = args.includes('--write');
const unknown = args.filter((a) => a !== '--write');
if (unknown.length) {
  console.error(`unknown flag(s): ${unknown.join(' ')}\nusage: node scripts/build-feed.mjs [--write]`);
  process.exit(2);
}

const src = readFileSync(POSTS_FILE, 'utf8');
const m = src.match(/const POSTS\s*=\s*(\[[\s\S]*?\]);/);
if (!m) { console.error(`No "const POSTS = [...]" found in ${POSTS_FILE}`); process.exit(1); }

// Trusted first-party source (object literals only) — same pattern and same
// trust level as build-blog-index.mjs.
const POSTS = new Function(`return ${m[1]};`)();

const today = new Date(); today.setHours(0, 0, 0, 0);

// Mirrors renderPosts() / build-blog-index.mjs: homeowner-audience posts with
// a URL whose publish date has arrived. Scheduled posts stay out of the feed
// until the first run after their date (the deploy workflow's regen step).
const live = POSTS.filter((p) => {
  if (!p.url || p.audience === 'contractor') return false;
  const d = new Date(p.published); d.setHours(0, 0, 0, 0);
  return d <= today;
}).sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));

if (!live.length) { console.error('No live posts — refusing to write an empty feed.'); process.exit(1); }

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// RFC-822 date pinned to 12:00:00 GMT so the same `published` value always
// yields the same byte sequence regardless of when or where this runs.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const rfc822 = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) { console.error(`Bad published date: ${iso}`); process.exit(1); }
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${dd} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} 12:00:00 GMT`;
};

const item = (p) => `  <item>
    <title>${esc(p.title)}</title>
    <link>${ORIGIN}${esc(p.url)}</link>
    <guid isPermaLink="true">${ORIGIN}${esc(p.url)}</guid>
    <pubDate>${rfc822(p.published)}</pubDate>
    <author>jd@nobigdealwithjoedeal.com (Joe Deal)</author>
    <description>${esc(p.excerpt)}</description>
  </item>`;

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>The No Big Deal Blog — Joe Deal</title>
  <link>${ORIGIN}/blog</link>
  <atom:link href="${ORIGIN}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>Straight-talk roofing, siding, and insurance-claim advice for Cincinnati-area homeowners from Joe Deal — 7+ years in insurance restoration, no fluff.</description>
  <language>en-us</language>
  <lastBuildDate>${rfc822(live[0].published)}</lastBuildDate>
${live.map(item).join('\n')}
</channel>
</rss>
`;

// EOL DISCIPLINE — docs/feed.xml is CRLF in a Windows worktree (autocrlf) and
// LF on CI. The template above always renders LF, so raw-comparing it against
// the bytes on disk could never match locally: this gate exited 1 on every
// clean Windows checkout, for line endings alone, and an always-red gate
// teaches everyone to ignore it. Three-step fix, copied from
// scripts/apply-partials.js: normalise the file to LF for comparison, sniff its
// own ending, emit with that ending. Read once — the write branch needs the
// destination's ending too, or --write would churn all 90-odd lines.
const existing = existsSync(FEED_FILE) ? readFileSync(FEED_FILE, 'utf8') : null;
const eol = existing && existing.includes('\r\n') ? '\r\n' : '\n';
const existingLF = existing === null ? null : existing.replace(/\r\n/g, '\n');

if (write) {
  const tmp = `${FEED_FILE}.tmp`;
  writeFileSync(tmp, eol === '\n' ? feed : feed.replace(/\n/g, eol));
  renameSync(tmp, FEED_FILE);
  console.log(`OK: ${live.length} items written to ${FEED_FILE}`);
} else {
  if (existingLF === feed) {
    console.log(`OK: ${FEED_FILE} is current (${live.length} items).`);
  } else {
    if (existing === null) {
      console.error(`${FEED_FILE} does not exist. Run with --write to create it.`);
    } else {
      console.error(`${FEED_FILE} drifts from the POSTS array. Diff (committed vs generated):`);
      const a = existingLF.split('\n'); const b = feed.split('\n');
      const max = Math.max(a.length, b.length);
      for (let i = 0; i < max; i++) {
        if (a[i] !== b[i]) {
          if (a[i] !== undefined) console.error(`- ${a[i]}`);
          if (b[i] !== undefined) console.error(`+ ${b[i]}`);
        }
      }
      console.error('Run with --write to update.');
    }
    process.exit(1);
  }
}
