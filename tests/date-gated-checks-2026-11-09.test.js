/**
 * tests/date-gated-checks-2026-11-09.test.js
 *
 * WHY: blog posts (the POSTS array) and projects (projects.json) can carry a future `published` date. They go live on
 * the first deploy after that date, and since 2026-11-09 a weekly scheduled deploy rebuilds the date-gated outputs
 * inside the job and ships hosting only — it never commits to main. So the committed docs/feed.xml and the OURWORK-*
 * regions can lag the live site by the posts/projects whose date has passed since someone last restamped them.
 * Before this change the CI drift gates (`node scripts/build-feed.mjs`, `node scripts/build-projects.mjs --check`)
 * compared the committed tree with a render for TODAY, so every PR went red the morning a staged item's date
 * passed, for a file the PR never touched.
 *
 * THE RULE (scripts/lib/date-gate.mjs): a --check passes when the committed tree matches today's render, OR the
 * render for an earlier day ("the tree was stamped before item X's date, and X has gone live since"). Anything else
 * is real drift and still fails. --strict keeps the old exact-today rule (the scheduled deploy's "is anything newly
 * due?" job uses it), and --live-on=YYYY-MM-DD renders as of a given day.
 *
 * Every behaviour runs in a scratch copy (never the real tree). Zero deps.
 * Run: node tests/date-gated-checks-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + String(extra).slice(0, 600) : '')); }
}
const node = (cwd, script, ...args) => spawnSync(process.execPath, [path.join(cwd, 'scripts', script), ...args],
  { cwd, encoding: 'utf8', timeout: 120000 });
const out = (r) => (r.stdout || '') + (r.stderr || '');
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000));
// "Today" in the generators' own terms (local midnight, then the local calendar date).
const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (!filter || filter(e.name)) fs.copyFileSync(s, d);
  }
}

console.log('\nscripts/lib/date-gate.mjs exists and the generators use it');
const LIB = path.join(ROOT, 'scripts', 'lib', 'date-gate.mjs');
ok('scripts/lib/date-gate.mjs exists', fs.existsSync(LIB));
for (const f of ['build-feed.mjs', 'build-projects.mjs']) {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
  ok(`${f} imports the shared date gate`, /from '\.\/lib\/date-gate\.mjs'/.test(src));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-dategate-'));
try {
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true });
  for (const f of ['build-feed.mjs', 'build-projects.mjs', 'project-price-context.mjs']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(tmp, 'scripts', f));
  }
  if (fs.existsSync(LIB)) fs.copyFileSync(LIB, path.join(tmp, 'scripts', 'lib', 'date-gate.mjs'));

  // ── Feed ───────────────────────────────────────────────────────
  console.log('\nbuild-feed.mjs: a post whose date passed since the last stamp is lag, not drift');
  const POSTS_REL = 'docs/assets/js/inline/c00f1acac9.js';
  fs.mkdirSync(path.join(tmp, path.dirname(POSTS_REL)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, POSTS_REL), path.join(tmp, POSTS_REL));
  fs.copyFileSync(path.join(ROOT, 'docs', 'feed.xml'), path.join(tmp, 'docs', 'feed.xml'));
  const postsFile = path.join(tmp, POSTS_REL);
  const postsSrc = fs.readFileSync(postsFile, 'utf8');
  const withPost = (published, slug) => postsSrc.replace('const POSTS = [', `const POSTS = [
  {
    url: "/blog/${slug}",
    tag: "Test",
    title: "Test post ${slug}",
    meta: "1 min read",
    excerpt: "A scratch post for the date-gate test.",
    published: "${published}",
  },`);

  ok('POSITIVE CONTROL: the copied feed is current today', node(tmp, 'build-feed.mjs').status === 0, out(node(tmp, 'build-feed.mjs')));

  // A post dated TODAY added without a restamp = "stamped yesterday, went live today".
  fs.writeFileSync(postsFile, withPost(TODAY, 'went-live-today'));
  let r = node(tmp, 'build-feed.mjs');
  ok('a post dated today, feed not restamped: the default check passes', r.status === 0, out(r));
  ok('…and says the repo copy lags (names the post date and the --write fix)', /lag/i.test(out(r)) && out(r).includes(TODAY) && /--write/.test(out(r)), out(r));
  r = node(tmp, 'build-feed.mjs', '--strict');
  ok('--strict still fails on that lag (the scheduled deploy uses it to decide "due")', r.status === 1, out(r));
  r = node(tmp, 'build-feed.mjs', `--live-on=${addDays(TODAY, -1)}`, '--strict');
  ok('--live-on=<yesterday> --strict: the committed feed is exact for yesterday', r.status === 0, out(r));
  r = node(tmp, 'build-feed.mjs', '--live-on=2026-13-40');
  ok('a malformed --live-on exits 2', r.status === 2, out(r));

  // A future post is staged: no lag, no drift, exact.
  fs.writeFileSync(postsFile, withPost(addDays(TODAY, 30), 'staged-future'));
  r = node(tmp, 'build-feed.mjs', '--strict');
  ok('a future-dated post leaves the feed exact (strict passes)', r.status === 0, out(r));

  // A NEW post dated before the newest live one, not restamped: no earlier day explains it — real drift.
  fs.writeFileSync(postsFile, withPost('2026-04-01', 'backdated-new'));
  r = node(tmp, 'build-feed.mjs');
  ok('a new post dated in the past (older than the newest) without a restamp still fails', r.status === 1, out(r));

  // A retitled live post is real drift whatever the date.
  fs.writeFileSync(postsFile, postsSrc.replace(/title: "([^"]+)"/, 'title: "$1 (retitled)"'));
  r = node(tmp, 'build-feed.mjs');
  ok('a retitled live post still fails the default check', r.status === 1, out(r));
  fs.writeFileSync(postsFile, postsSrc);

  // ── Projects ───────────────────────────────────────────────────
  console.log('\nbuild-projects.mjs --check: a project whose date passed since the last stamp is lag, not drift');
  // Writable copies of everything the generator stamps; read-only symlinks for the image trees it only stats.
  for (const d of ['areas', 'services', 'our-work']) copyDir(path.join(ROOT, 'docs', d), path.join(tmp, 'docs', d));
  copyDir(path.join(ROOT, 'docs', 'assets', 'data'), path.join(tmp, 'docs', 'assets', 'data'));
  for (const f of ['index.html', 'our-work.html']) fs.copyFileSync(path.join(ROOT, 'docs', f), path.join(tmp, 'docs', f));
  for (const e of fs.readdirSync(path.join(ROOT, 'docs', 'assets'))) {
    const dst = path.join(tmp, 'docs', 'assets', e);
    if (!fs.existsSync(dst)) fs.symlinkSync(path.join(ROOT, 'docs', 'assets', e), dst);
  }
  r = node(tmp, 'build-projects.mjs', '--check');
  ok('POSITIVE CONTROL: the copied project surfaces are clean today', r.status === 0, out(r));

  const dataFile = path.join(tmp, 'docs', 'assets', 'data', 'projects.json');
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const list = Array.isArray(data) ? data : data.projects;
  const newest = list.map((p) => p.published).sort().at(-1).slice(0, 10);
  // Restamp the scratch tree as of the day BEFORE the newest projects went live: exactly the tree a repo would hold
  // if those projects had been committed future-dated and nobody restamped after their date.
  r = node(tmp, 'build-projects.mjs', `--live-on=${addDays(newest, -1)}`);
  ok(`scratch restamp as of ${addDays(newest, -1)} succeeds`, r.status === 0, out(r));
  r = node(tmp, 'build-projects.mjs', '--check');
  ok('a lagging stamp (projects went live since) passes the default --check', r.status === 0, out(r));
  ok('…and says it lags, naming the date and the restamp command', /lag/i.test(out(r)) && out(r).includes(newest) && /build-projects\.mjs/.test(out(r)), out(r));
  r = node(tmp, 'build-projects.mjs', '--check', '--strict');
  ok('--check --strict fails on the same lag', r.status === 1, out(r));
  // Hand-edit inside a generated region: real drift, never excused as lag.
  const ow = path.join(tmp, 'docs', 'our-work.html');
  fs.writeFileSync(ow, fs.readFileSync(ow, 'utf8').replace('<!-- OURWORK-STATIC-START -->', '<!-- OURWORK-STATIC-START -->\nHAND EDIT'));
  r = node(tmp, 'build-projects.mjs', '--check');
  ok('a hand edit inside OURWORK-STATIC still fails --check', r.status === 1, out(r));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
