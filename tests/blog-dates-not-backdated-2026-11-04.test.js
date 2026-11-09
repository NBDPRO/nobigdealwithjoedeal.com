/**
 * tests/blog-dates-not-backdated-2026-11-04.test.js
 *
 * THE BUG (copy-004): the repo began 2026-03-15, but scripts/rebuild-blog-index.js's SEASONAL_MAP dated 16 posts
 * March 2025 – Feb 2026, and its byline regex only matched a bare <span>, so the visible <span class="post-date">
 * byline drifted from the index and feed on five posts. It also overwrote dateModified with the publish date.
 *
 * THE FIX (Jo, 2026-11-04: keep the blog spread out, never before a post went up): every map entry carries its post's
 * first-commit date ("// first YYYY-MM-DD") and is on or after it; --reschedule writes the byline in either span form
 * and keeps a later dateModified.
 *
 * Checks every map entry: date >= its "first"; the post's article:published_time, datePublished and visible byline
 * all equal the map date; dateModified (when present) is not earlier. Positive control: the map is non-empty and
 * the "first" parser finds every entry.
 *
 * WEEKLY CADENCE (2026-11-09, CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09 §2): from 2026-11-10 the blog publishes one
 * post every Tuesday, and the weekly scheduled deploy (Tuesday 09:17 UTC, .github/workflows/firebase-deploy.yml) is
 * what puts it on the static index and in the feed that morning. So every POSTS entry published ON OR AFTER
 * 2026-11-10 must fall on a Tuesday, and no two posts may share an ISO week. Earlier posts are grandfathered (three
 * went up on 2026-10-16, a Friday). Runbook: documentation/runbooks/BLOG-SCHEDULE.md.
 *
 * Zero deps. Run: node tests/blog-dates-not-backdated-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const src = read('scripts/rebuild-blog-index.js');
const block = (src.match(/const SEASONAL_MAP = \{([\s\S]*?)\n\};/) || [])[1] || '';
const rows = [...block.matchAll(/'([a-z0-9-]+)':\s*'(\d{4}-\d{2}-\d{2})',(?:\s*\/\/\s*first (\d{4}-\d{2}-\d{2}))?/g)]
  .map((m) => ({ slug: m[1], date: m[2], first: m[3] }));

ok('POSITIVE CONTROL: the map parses and is non-empty', rows.length >= 10, String(rows.length));
ok('every map entry records its post\'s first-commit date', rows.every((r) => r.first), rows.filter((r) => !r.first).map((r) => r.slug).join(', '));
ok('the byline rewrite matches <span class="post-date">', /<span\(\?: class="post-date"\)\?>/.test(src));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pretty = (d) => { const [y, m, dd] = d.split('-').map(Number); return MONTHS[m - 1] + ' ' + dd + ', ' + y; };

for (const r of rows) {
  ok(`${r.slug}: ${r.date} is not before it went up (${r.first})`, r.first && r.date >= r.first);
  const f = path.join(ROOT, 'docs/blog', r.slug + '.html');
  if (!fs.existsSync(f)) { ok(`${r.slug}: post file exists`, false); continue; }
  const h = fs.readFileSync(f, 'utf8');
  const pub = (h.match(/article:published_time" content="([\d-]+)"/) || [])[1];
  const ld = (h.match(/"datePublished"\s*:\s*"([\d-]+)"/) || [])[1];
  const mod = (h.match(/"dateModified"\s*:\s*"([\d-]+)"/) || [])[1];
  ok(`${r.slug}: published_time, datePublished and byline all say ${r.date}`,
    pub === r.date && ld === r.date && h.includes('>' + pretty(r.date) + '</span>'), `pub=${pub} ld=${ld}`);
  ok(`${r.slug}: dateModified is not earlier than published`, !mod || mod >= r.date, mod);
}

// ── Weekly cadence for new posts ────────────────────────────────
const CADENCE_FROM = '2026-11-10';
const isoDay = (d) => new Date(String(d).slice(0, 10) + 'T00:00:00Z');
const isTuesday = (d) => isoDay(d).getUTCDay() === 2;
/** ISO-8601 week key, e.g. '2026-W46' (weeks start Monday; week 1 holds the year's first Thursday). */
function isoWeek(d) {
  const t = isoDay(d);
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);              // the Thursday of this week decides the ISO year
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return y + '-W' + String(week).padStart(2, '0');
}
/** Violations of the cadence rule for a POSTS-like list: [{ url, published, why }]. */
function cadenceViolations(posts) {
  const out = [];
  for (const p of posts) {
    if (!p.published || String(p.published).slice(0, 10) < CADENCE_FROM) continue;
    if (!isTuesday(p.published)) out.push({ url: p.url, published: p.published, why: 'not a Tuesday' });
    const same = posts.filter((q) => q !== p && q.published && isoWeek(q.published) === isoWeek(p.published));
    if (same.length) out.push({ url: p.url, published: p.published, why: 'shares ISO week ' + isoWeek(p.published) + ' with ' + same.map((q) => q.url + ' (' + q.published + ')').join(', ') });
  }
  return out;
}

console.log('\nweekly cadence: posts on or after ' + CADENCE_FROM + ' are on a Tuesday, one per ISO week');
ok('rule self-test: ISO weeks (2026-11-09 Mon and 2026-11-15 Sun share W46; 2026-11-16 is W47; 2027-01-01 is 2026-W53)',
  isoWeek('2026-11-09') === '2026-W46' && isoWeek('2026-11-15') === '2026-W46' && isoWeek('2026-11-16') === '2026-W47'
  && isoWeek('2027-01-01') === '2026-W53' && isoWeek('2026-11-10') === '2026-W46');
ok('rule self-test: a Wednesday post after the cut-off is caught',
  cadenceViolations([{ url: '/blog/a', published: '2026-11-11' }]).some((v) => v.why === 'not a Tuesday'));
ok('rule self-test: two Tuesdays apart pass; a second post in the same week is caught',
  cadenceViolations([{ url: '/blog/a', published: '2026-11-10' }, { url: '/blog/b', published: '2026-11-17' }]).length === 0
  && cadenceViolations([{ url: '/blog/a', published: '2026-11-10' }, { url: '/blog/b', published: '2026-11-17' }, { url: '/blog/c', published: '2026-11-17' }])
    .filter((v) => /shares ISO week 2026-W47/.test(v.why)).length === 2);
ok('rule self-test: a new post in the same week as a grandfathered one is caught',
  cadenceViolations([{ url: '/blog/old', published: '2026-11-09' }, { url: '/blog/new', published: '2026-11-10' }]).length === 1);
ok('rule self-test: posts before ' + CADENCE_FROM + ' are grandfathered',
  cadenceViolations([{ url: '/blog/a', published: '2026-10-16' }, { url: '/blog/b', published: '2026-10-16' }]).length === 0);

const postsSrc = read('docs/assets/js/inline/c00f1acac9.js');
const postsM = postsSrc.match(/const POSTS\s*=\s*(\[[\s\S]*?\]);/);
const POSTS = postsM ? new Function('return ' + postsM[1] + ';')() : [];
ok('POSITIVE CONTROL: the POSTS array parses (' + POSTS.length + ' posts)', POSTS.length >= 25);
const bad = cadenceViolations(POSTS);
ok('every post published on or after ' + CADENCE_FROM + ' is a Tuesday, alone in its ISO week',
  bad.length === 0, bad.map((v) => v.url + ' ' + v.published + ': ' + v.why).join(' | '));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
