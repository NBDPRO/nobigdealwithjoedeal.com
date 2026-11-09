/**
 * tests/llms-blog-region-2026-11-09.test.js
 *
 * WHY: docs/llms.txt's "Guides (blog)" list was hand-kept and had already rotted: on 2026-11-09 it lacked
 * /blog/color-matching-paint-why-it-takes-so-long (live since 2026-11-04). With a post every Tuesday it would fall
 * further behind each week. It is now an LLMS:BLOG marker region that scripts/build-llms.mjs builds from the blog's
 * POSTS array (docs/assets/js/inline/c00f1acac9.js): live posts only (published on or before today), contractor-
 * audience posts excluded, each URL also in docs/sitemap.xml and not noindex, A–Z by URL. An existing entry line is
 * kept verbatim (hand-tuned wording survives), like the SERVICES and AREAS regions. --check-regions gates it in CI;
 * the deploy's --write regenerates it, so a post joins the list on the first deploy after its date (the weekly
 * scheduled deploy included). A post whose date passed since the last restamp is lag, not drift
 * (scripts/lib/date-gate.mjs).
 *
 * Behaviour runs in a scratch copy of docs/ (never the real tree). Zero deps.
 * Run: node tests/llms-blog-region-2026-11-09.test.js
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
const run = (root, ...args) => spawnSync(process.execPath, [path.join(root, 'scripts', 'build-llms.mjs'), ...args],
  { cwd: root, encoding: 'utf8', timeout: 120000 });
const out = (r) => (r.stdout || '') + (r.stderr || '');
const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const POSTS_REL = 'docs/assets/js/inline/c00f1acac9.js';
const loadPosts = (file) => {
  const m = fs.readFileSync(file, 'utf8').match(/const POSTS\s*=\s*(\[[\s\S]*?\]);/);
  return new Function('return ' + m[1] + ';')();
};
const region = (txt) => {
  const a = txt.indexOf('<!-- LLMS:BLOG:START -->'); const b = txt.indexOf('<!-- LLMS:BLOG:END -->');
  return a !== -1 && b > a ? txt.slice(a, b) : null;
};
const urlsIn = (body) => [...String(body || '').matchAll(/^- \[[^\]]*\]\(https:\/\/nobigdealwithjoedeal\.com(\/blog\/[^)\s]+)\)/gm)].map((m) => m[1]);

console.log('\nthe committed docs/llms.txt');
const llms = fs.readFileSync(path.join(ROOT, 'docs', 'llms.txt'), 'utf8').replace(/\r\n/g, '\n');
const body = region(llms);
ok('has exactly one LLMS:BLOG region', body !== null && llms.split('<!-- LLMS:BLOG:START -->').length === 2);
ok('…under the "### Guides (blog)" heading', body !== null && llms.indexOf('### Guides (blog)') !== -1
  && llms.indexOf('### Guides (blog)') < llms.indexOf('<!-- LLMS:BLOG:START -->')
  && !/\n##+ /.test(llms.slice(llms.indexOf('### Guides (blog)') + 5, llms.indexOf('<!-- LLMS:BLOG:START -->'))));
const posts = loadPosts(path.join(ROOT, POSTS_REL));
const midnight = (v) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d; };
const liveUrls = posts.filter((p) => p.url && p.audience !== 'contractor' && midnight(p.published) <= midnight(Date.now()))
  .map((p) => p.url).sort();
const listed = urlsIn(body);
ok('POSITIVE CONTROL: the POSTS array parses and has live posts', liveUrls.length >= 25, String(liveUrls.length));
ok('lists every live homeowner post, and nothing else', JSON.stringify([...listed].sort()) === JSON.stringify(liveUrls),
  'missing: ' + liveUrls.filter((u) => !listed.includes(u)).join(', ') + ' | extra: ' + listed.filter((u) => !liveUrls.includes(u)).join(', '));
ok('includes the post the hand-kept list missed (color-matching-paint-why-it-takes-so-long)',
  listed.includes('/blog/color-matching-paint-why-it-takes-so-long'));
ok('is in A–Z order by URL', JSON.stringify(listed) === JSON.stringify([...listed].sort()));
ok('no blog link left hand-kept outside the region in the Guides section',
  urlsIn(llms.slice(llms.indexOf('### Guides (blog)'), llms.indexOf('<!-- LLMS:BLOG:START -->'))).length === 0
  && urlsIn(llms.slice(llms.indexOf('<!-- LLMS:BLOG:END -->'), llms.indexOf('\n## ', llms.indexOf('<!-- LLMS:BLOG:END -->')))).length === 0);
ok('build-llms.mjs imports the shared date gate',
  /from '\.\/lib\/date-gate\.mjs'/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'build-llms.mjs'), 'utf8')));
const r0 = run(ROOT, '--check-regions');
ok('--check-regions is clean on the committed tree', r0.status === 0, out(r0));

console.log('\nbehaviour in a scratch copy');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-llms-blog-'));
try {
  const copy = (src, dst) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copy(s, d);
      else if (/\.(html|txt|xml|json)$/.test(e.name)) { fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(s, d); }
    }
  };
  for (const d of ['areas', 'services', 'blog', 'our-work', 'assets/data']) copy(path.join(ROOT, 'docs', d), path.join(tmp, 'docs', d));
  for (const f of ['llms.txt', 'sitemap.xml']) fs.copyFileSync(path.join(ROOT, 'docs', f), path.join(tmp, 'docs', f));
  fs.mkdirSync(path.join(tmp, path.dirname(POSTS_REL)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, POSTS_REL), path.join(tmp, POSTS_REL));
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true });
  for (const f of ['build-llms.mjs', 'indexnow-ping.mjs', 'lib/date-gate.mjs']) {
    if (fs.existsSync(path.join(ROOT, 'scripts', f))) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(tmp, 'scripts', f));
  }
  const postsFile = path.join(tmp, POSTS_REL);
  const postsSrc = fs.readFileSync(postsFile, 'utf8');
  const llmsFile = path.join(tmp, 'docs', 'llms.txt');
  const withPost = (published, slug, extra = '') => postsSrc.replace('const POSTS = [', `const POSTS = [
  {
    url: "/blog/${slug}",
    tag: "Test",
    title: "Scratch ${slug}",
    meta: "1 min read",
    excerpt: "Scratch excerpt for ${slug}.",
    published: "${published}",${extra}
  },`);
  // A sitemap entry + page for the scratch posts, so only the date/audience rules decide membership.
  const addPage = (slug) => {
    fs.writeFileSync(path.join(tmp, 'docs', 'blog', slug + '.html'), '<!doctype html><title>x</title><main>x</main>');
    const sm = path.join(tmp, 'docs', 'sitemap.xml');
    fs.writeFileSync(sm, fs.readFileSync(sm, 'utf8').replace('</urlset>',
      `<url><loc>https://nobigdealwithjoedeal.com/blog/${slug}</loc></url></urlset>`));
  };
  for (const s of ['zz-future', 'zz-today', 'zz-contractor', 'aa-past']) addPage(s);

  let r = run(tmp, '--check-regions');
  ok('POSITIVE CONTROL: the copy is clean before any edit', r.status === 0, out(r));

  fs.writeFileSync(postsFile, withPost(addDays(TODAY, 21), 'zz-future'));
  r = run(tmp, '--check-regions');
  ok('a future-dated post is staged: --check-regions stays clean', r.status === 0, out(r));
  run(tmp, '--write-regions');
  ok('…and --write-regions does not list it', !(region(fs.readFileSync(llmsFile, 'utf8')) || '').includes('/blog/zz-future'));

  fs.writeFileSync(postsFile, withPost(addDays(TODAY, -3), 'zz-contractor', '\n    audience: "contractor",'));
  run(tmp, '--write-regions');
  ok('a contractor-audience post is never listed', !(region(fs.readFileSync(llmsFile, 'utf8')) || '').includes('/blog/zz-contractor'));

  fs.writeFileSync(postsFile, withPost(TODAY, 'zz-today'));
  r = run(tmp, '--check-regions');
  ok('a post that went live today without a restamp is lag: --check-regions passes', r.status === 0, out(r));
  ok('…and says it lags', /lag/i.test(out(r)) && out(r).includes(TODAY), out(r));
  run(tmp, '--write-regions');
  const reg = region(fs.readFileSync(llmsFile, 'utf8')) || '';
  ok('--write-regions then lists it as "- [title](url): excerpt"',
    reg.includes('- [Scratch zz-today](https://nobigdealwithjoedeal.com/blog/zz-today): Scratch excerpt for zz-today.'), reg.slice(-400));

  fs.writeFileSync(postsFile, withPost('2026-04-02', 'aa-past'));
  r = run(tmp, '--check-regions');
  ok('a NEW post dated in the past without a restamp is drift: --check-regions fails', r.status === 1, out(r));

  // Hand-tuned wording on an existing entry survives a regen.
  fs.writeFileSync(postsFile, postsSrc);
  run(tmp, '--write-regions');
  const before = fs.readFileSync(llmsFile, 'utf8');
  const tuned = before.replace(/(\(https:\/\/nobigdealwithjoedeal\.com\/blog\/the-pipe-boot-fork\)): [^\n]*/, '$1: Hand-tuned wording.');
  fs.writeFileSync(llmsFile, tuned);
  r = run(tmp, '--check-regions');
  ok('a hand-tuned entry line is kept verbatim (check stays clean)', r.status === 0 && tuned !== before, out(r));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
