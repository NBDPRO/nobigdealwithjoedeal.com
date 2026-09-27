/**
 * indexnow-ping.test.js — scripts/indexnow-ping.mjs's pure functions, and the
 * deploy step's guards.
 *
 * The ping announces URLs to Bing/Yandex after every production deploy, so the
 * two ways it can do harm are (1) announcing a URL that is private or wrong —
 * /pro, /admin, /sites, a noindexed page, a .html URL that 301s, a slashed
 * directory URL — and (2) failing or stalling a deploy. (1) is pinned against
 * the REAL docs/sitemap.xml: every sitemap URL must be reachable from its file
 * through fileToUrl(), so the mapping cannot drift from build-sitemap.js
 * without this going red. (2) is pinned against the workflow text.
 *
 * Nothing here touches the network, git, firebase or any deploy tooling.
 *
 * Run: node tests/indexnow-ping.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

(async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'scripts', 'indexnow-ping.mjs')).href);
  const O = m.ORIGIN;

  console.log('\nfileToUrl — cleanUrls mapping');
  const cases = [
    ['docs/index.html', O + '/'],
    ['docs/about.html', O + '/about'],
    ['docs/the-pledge/index.html', O + '/the-pledge'],
    ['docs/areas/index.html', O + '/areas'],
    ['docs/areas/mason-oh.html', O + '/areas/mason-oh'],
    ['docs/services/lumanail/index.html', O + '/services/lumanail'],
    ['docs/blog/the-pipe-boot-fork.html', O + '/blog/the-pipe-boot-fork'],
    ['docs\\services\\roof-repair.html', O + '/services/roof-repair'],
    ['./docs/our-work.html', O + '/our-work'],
    ['docs/llms.txt', O + '/llms.txt'],
    ['docs/llms-full.txt', O + '/llms-full.txt'],
    ['docs/sitemap.xml', O + '/sitemap.xml'],
    ['docs/pro/index.html', null],
    ['docs/pro/blog/some-post.html', null],
    ['docs/admin/index.html', null],
    ['docs/sites/oaks/index.html', null],
    ['docs/assets/css/site.css', null],
    ['docs/robots.txt', null],
    ['functions/index.js', null],
    ['site-src/partials/nav-standard.html', null],
  ];
  for (const [input, want] of cases) {
    const got = m.fileToUrl(input);
    ok(JSON.stringify(input) + ' → ' + want, got === want, 'got ' + got);
  }
  ok('no mapped URL ends in .html or a trailing slash (other than the root)',
    cases.map(([i]) => m.fileToUrl(i)).filter(Boolean)
      .every((u) => !u.endsWith('.html') && (u === O + '/' || !u.endsWith('/'))));

  console.log('\nfileToUrl agrees with the REAL sitemap (build-sitemap.js URL forms)');
  const locs = m.parseSitemapLocs(fs.readFileSync(path.join(DOCS, 'sitemap.xml'), 'utf8'));
  ok('sitemap parsed non-vacuously (' + locs.size + ' URLs)', locs.size > 100);
  const walk = (dir, rel, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel + '/' + e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
      else if (e.name.endsWith('.html')) out.push('docs' + r);
    }
    return out;
  };
  const reachable = new Set(walk(DOCS, '', []).map(m.fileToUrl).filter(Boolean));
  const unreachable = [...locs].filter((u) => !reachable.has(u));
  ok('every sitemap URL is produced by fileToUrl() from some file under docs/',
    unreachable.length === 0, unreachable.slice(0, 5).join(', '));
  ok('no sitemap URL is under /pro, /admin or /sites',
    [...locs].every((u) => !/\/(pro|admin|sites)(\/|$)/.test(u.slice(O.length))));

  console.log('\nselectUrls — filters');
  const sitemap = new Set([O + '/', O + '/about', O + '/blog/a', O + '/blog/noindexed']);
  const r = m.selectUrls({
    changed: [
      'docs/about.html', 'docs/about.html', 'docs/index.html', 'docs/blog/a.html',
      'docs/blog/noindexed.html', 'docs/blog/unlisted.html', 'docs/pro/dashboard.html',
      'docs/assets/js/x.js', 'docs/llms.txt',
    ],
    sitemapLocs: sitemap,
    isNoindex: (rel) => rel === 'docs/blog/noindexed.html',
  });
  ok('keeps sitemap-listed pages + llms.txt, deduped and sorted',
    JSON.stringify(r.urls) === JSON.stringify([O + '/', O + '/about', O + '/blog/a', O + '/llms.txt']),
    JSON.stringify(r.urls));
  const reason = (f) => (r.skipped.find((s) => s.file === f) || {}).reason;
  ok('noindexed page skipped as noindex', reason('docs/blog/noindexed.html') === 'robots noindex');
  ok('page missing from the sitemap skipped', reason('docs/blog/unlisted.html') === 'not in sitemap.xml');
  ok('/pro page skipped as not public', reason('docs/pro/dashboard.html') === 'not a public page');
  ok('non-page asset skipped', reason('docs/assets/js/x.js') === 'not a public page');
  ok('a /pro URL is refused even if it somehow reached the sitemap',
    m.selectUrls({ changed: ['docs/pro/index.html'], sitemapLocs: new Set([O + '/pro']) }).urls.length === 0);

  const many = Array.from({ length: m.MAX_URLS + 5 }, (_, i) => 'docs/p' + i + '.html');
  const big = m.selectUrls({ changed: many, sitemapLocs: new Set(many.map(m.fileToUrl)) });
  ok('caps the list at ' + m.MAX_URLS + ' URLs', big.urls.length === m.MAX_URLS);

  console.log('\nrange + payload');
  ok('all-zero before-SHA is recognised (new branch / force push → skip)',
    m.isZeroSha('0000000000000000000000000000000000000000') && m.isZeroSha('') && !m.isZeroSha('8e2a3234'));
  const key = m.findKey(DOCS);
  ok('exactly one key file in docs/, and its contents equal its name',
    fs.readFileSync(path.join(DOCS, key + '.txt'), 'utf8').trim() === key);
  const p = m.buildPayload([O + '/about'], key);
  ok('payload carries host, key, keyLocation, urlList',
    p.host === 'nobigdealwithjoedeal.com' && p.key === key
      && p.keyLocation === O + '/' + key + '.txt' && p.urlList.length === 1);
  ok('keyLocation points at a file that ships (docs/<key>.txt exists)',
    fs.existsSync(path.join(DOCS, key + '.txt')));

  console.log('\nfirebase-deploy.yml — the step can never fail or mis-target a deploy');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml'), 'utf8').replace(/\r\n/g, '\n');
  const at = wf.indexOf('- name: Ping IndexNow');
  const step = at === -1 ? '' : wf.slice(at, wf.indexOf('\n      - name:', at + 1) === -1 ? undefined : wf.indexOf('\n      - name:', at + 1));
  ok('the IndexNow step exists', at !== -1);
  ok('it runs AFTER Deploy Hosting', at > wf.indexOf('- name: Deploy Hosting'));
  ok('Deploy Hosting carries id: hosting (the step keys off its outcome)',
    /- name: Deploy Hosting\n\s+id: hosting\n/.test(wf));
  ok('guarded to push + main + hosting success',
    /if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && steps\.hosting\.outcome == 'success' \}\}/.test(step));
  ok('continue-on-error: true', /\n\s+continue-on-error: true\n/.test(step));
  ok('time-limited (timeout-minutes ≤ 5)', (() => { const t = /timeout-minutes: (\d+)/.exec(step); return !!t && Number(t[1]) <= 5; })());
  ok('passes the push range and runs the script without --dry-run',
    /BEFORE_SHA: \$\{\{ github\.event\.before \}\}/.test(step) && /node scripts\/indexnow-ping\.mjs --before "\$BEFORE_SHA" --after "\$AFTER_SHA"/.test(step)
      && !/--dry-run/.test(step));
  ok('the step invokes no firebase / deploy tooling', !/firebase|deploy\.sh|npx/.test(step.replace(/^.*#.*$/gm, '')));

  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
