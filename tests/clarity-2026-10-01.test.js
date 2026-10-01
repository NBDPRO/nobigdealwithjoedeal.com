/**
 * tests/clarity-2026-10-01.test.js — Microsoft Clarity on the public site only.
 *
 *   1. coverage: every public page with GA4 carries the loader, none under
 *      /pro, /admin, /dev or /sites (scripts/add-clarity-tag.js --check)
 *   2. the loader's BEHAVIOUR in a vm sandbox: inert without an ID; with an
 *      ID it loads only on the production host, never on CRM paths, never
 *      with Global Privacy Control or Do Not Track
 *   3. CSP: Clarity hosts only on the `**` rule; no CRM/admin rule admits them
 *   4. the privacy policy discloses it
 *
 * Run: node tests/clarity-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('\n1. coverage');
{
  const tagger = require(path.join(ROOT, 'scripts/add-clarity-tag.js'));
  const code = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts/add-clarity-tag.js'), '--check'], { encoding: 'utf8' });
  ok('add-clarity-tag --check passes (every GA page tagged, nothing under /pro /admin /dev /sites)', code && code.status === 0, (code && (code.stderr || code.stdout) || '').slice(0, 400));
  ok('scope is large (positive control: the walker found the public pages)', tagger.scopePages().length >= 200, String(tagger.scopePages().length));
  const sample = '<head>\n<script defer src="/assets/js/inline/2a90205f1b.js"></script>\n</head>';
  const tagged = tagger.addTag(sample);
  ok('addTag places the loader right after the GA init line', !!tagged && tagged.includes('2a90205f1b.js"></script>\n' + tagger.LINE));
  ok('addTag is idempotent', tagger.addTag(tagged) === null);
}

console.log('\n2. loader behaviour');
const SRC = read('docs/assets/js/clarity-loader.js');
function run({ id, host = 'nobigdealwithjoedeal.com', pathName = '/', gpc = false, dnt = null } = {}) {
  const appended = [];
  const src = id == null ? SRC : SRC.replace("var PROJECT_ID = '';", `var PROJECT_ID = '${id}';`);
  const sb = {
    location: { hostname: host, pathname: pathName },
    navigator: { globalPrivacyControl: gpc, doNotTrack: dnt },
    document: { createElement: () => ({}), head: { appendChild: (e) => appended.push(e) } },
  };
  sb.window = sb;
  vm.runInNewContext(src, sb);
  return { appended, win: sb };
}
ok('ships inert: no project ID, nothing loads', run({}).appended.length === 0 && /var PROJECT_ID = '';/.test(SRC));
const live = run({ id: 'abc123xyz' });
ok('with an ID on the production host it loads www.clarity.ms/tag/<id>, async', live.appended.length === 1 && live.appended[0].src === 'https://www.clarity.ms/tag/abc123xyz' && live.appended[0].async === true);
ok('…and queues calls until the tag arrives', typeof live.win.clarity === 'function');
ok('www host also loads', run({ id: 'abc123xyz', host: 'www.nobigdealwithjoedeal.com' }).appended.length === 1);
for (const h of ['localhost', '127.0.0.1', 'nobigdeal-pro--pr123-abc.web.app', 'nobigdeal-pro.web.app']) {
  ok(`never on ${h}`, run({ id: 'abc123xyz', host: h }).appended.length === 0);
}
for (const p of ['/pro/dashboard', '/pro/portal', '/admin', '/admin/analytics', '/sites/t/x', '/dev/x', '/PRO/dashboard']) {
  ok(`never on ${p}`, run({ id: 'abc123xyz', pathName: p }).appended.length === 0);
}
ok('a path that only starts with "pro" still loads (/process is public)', run({ id: 'abc123xyz', pathName: '/process' }).appended.length === 1);
ok('Global Privacy Control blocks it', run({ id: 'abc123xyz', gpc: true }).appended.length === 0);
ok('Do Not Track blocks it', run({ id: 'abc123xyz', dnt: '1' }).appended.length === 0);
ok('a malformed ID is refused (no URL injection)', run({ id: 'abc/../x' }).appended.length === 0);

console.log('\n3. CSP');
{
  const f = JSON.parse(read('firebase.json'));
  const star = f.hosting.headers.find((h) => h.source === '**');
  for (const key of ['Content-Security-Policy', 'Content-Security-Policy-Report-Only']) {
    const v = (star.headers.find((x) => x.key === key) || {}).value || '';
    const dir = (n) => (v.split(';').map((d) => d.trim()).find((d) => d.split(/\s+/)[0] === n) || '');
    ok(`${key} on **: script-src(-elem) admit www.clarity.ms + scripts.clarity.ms`,
      ['script-src', 'script-src-elem'].every((n) => /https:\/\/www\.clarity\.ms/.test(dir(n)) && /https:\/\/scripts\.clarity\.ms/.test(dir(n))));
    ok(`${key} on **: connect-src and img-src admit *.clarity.ms + c.bing.com`,
      ['connect-src', 'img-src'].every((n) => /https:\/\/\*\.clarity\.ms/.test(dir(n)) && /https:\/\/c\.bing\.com/.test(dir(n))));
  }
  const others = f.hosting.headers.filter((h) => h.source !== '**' && /^\/(pro|admin)/.test(h.source));
  ok('no /pro or /admin rule admits Clarity (CSP blocks it there even if mis-included)', others.length > 0 && !others.some((h) => /clarity/.test(JSON.stringify(h))));
}

console.log('\n4. privacy policy');
{
  const p = read('docs/privacy.html');
  ok('privacy.html discloses Microsoft Clarity, its masking, CRM exclusion and GPC/DNT', /<h3>Microsoft Clarity<\/h3>/.test(p) && /masked/.test(p) && /not used in our customer portal, CRM/.test(p) && /Global Privacy Control/.test(p));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
