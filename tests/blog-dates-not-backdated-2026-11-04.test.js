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

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
