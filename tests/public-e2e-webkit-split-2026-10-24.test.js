/**
 * The required Public-surface E2E job installs Chromium only (2026-10-24, Jo's call).
 *
 * `npx playwright install --with-deps chromium webkit` pulled ~180 WebKit apt
 * packages from a crawling Ubuntu mirror and ran the required job to its 20 min
 * cap in 3 of 3 sampled cancellations (documentation/qa/ci-runner-minutes-2026-10-23.md);
 * it cancelled #2719's first run. The Chromium-only install is the step every
 * other required Playwright job runs without stalling.
 *
 * The WebKit coverage is moved, not dropped: the mobile-webkit project
 * (nav-drawer + site-search on an iPhone-sized viewport) runs in its own
 * job, which is not in the merge-queue ruleset, so a stalled WebKit install
 * can no longer block a merge.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r/g, '');
const cfg = fs.readFileSync(path.join(ROOT, 'tests', 'playwright.config.js'), 'utf8');

// A job body: from its key to the next top-level job key.
function job(id, yml = ci) {
  const i = yml.indexOf('\n  ' + id + ':\n');
  if (i < 0) return '';
  const rest = yml.slice(i + 1);
  const m = /\n  [a-z0-9-]+:\n/.exec(rest.slice(3));
  return m ? rest.slice(0, m.index + 3) : rest;
}
// The `playwright install` command lines only (comments may say "webkit").
const installs = (body) => body.split('\n').filter((l) => /^\s*npx playwright install\b/.test(l)).map((l) => l.trim());
const runs = (body) => body.split('\n').filter((l) => /playwright test\b/.test(l) && !/^\s*#/.test(l)).join('\n');

console.log('\nREQUIRED JOB: public-e2e');
const pub = job('public-e2e');
ok('public-e2e job exists', pub.length > 0);
ok('keeps its required check name', /name: Public-surface E2E \(hosting emulator\)\n/.test(pub));
const pubInst = installs(pub);
ok('installs Playwright exactly once', pubInst.length === 1, pubInst.join(' | '));
ok('installs chromium', /\bchromium\b/.test(pubInst[0] || ''), pubInst[0]);
ok('does NOT install webkit (the stalling apt set)', !/\bwebkit\b/.test(pubInst.join(' ')), pubInst.join(' | '));
const pubRun = runs(pub);
ok('runs only the chromium project', /--project=chromium\b/.test(pubRun) && !/mobile-webkit/.test(pubRun), pubRun);
for (const spec of ['pro-public.spec.js', 'marketing.spec.js', 'site-search.spec.js']) {
  ok('still runs ' + spec, pubRun.includes(spec), pubRun);
}
ok('stays pinned to the hosting emulator (config defaults to PRODUCTION)', /PLAYWRIGHT_BASE_URL=http:\/\/127\.0\.0\.1:5000/.test(pubRun));

console.log('\nNON-REQUIRED JOB: public-e2e-webkit');
const wk = job('public-e2e-webkit');
ok('public-e2e-webkit job exists', wk.length > 0);
const wkName = (/\n    name: (.+)\n/.exec(wk) || [])[1] || '';
ok('its check name differs from the required one', wkName && wkName !== 'Public-surface E2E (hosting emulator)', wkName);
const wkInst = installs(wk);
ok('installs webkit', /\bwebkit\b/.test(wkInst.join(' ')), wkInst.join(' | '));
const wkRun = runs(wk);
ok('runs the mobile-webkit project', /--project=mobile-webkit\b/.test(wkRun), wkRun);
ok('runs nav-drawer.spec.js and site-search.spec.js', wkRun.includes('nav-drawer.spec.js') && wkRun.includes('site-search.spec.js'), wkRun);
ok('pinned to the hosting emulator too', /PLAYWRIGHT_BASE_URL=http:\/\/127\.0\.0\.1:5000/.test(wkRun) && /emulators:exec --only hosting/.test(wk));
ok('builds the Pagefind index site-search needs', /build-site-search\.mjs --install/.test(wk) && /build-site-search\.mjs\n/.test(wk));
const t = /timeout-minutes: (\d+)/.exec(wk);
ok('bounded by a timeout', !!t && Number(t[1]) > 0 && Number(t[1]) <= 20, t && t[1]);
ok('not keyed on the event (merge-queue-ready forbids it)', !/\n    if:/.test(wk));

console.log('\nCONFIG STILL ROUTES THE SPECS');
ok('chromium project ignores nav-drawer (WebKit-only spec)', /name: 'chromium'[\s\S]{0,200}testIgnore: \/nav-drawer\\\.spec\\\.js\//.test(cfg));
ok('mobile-webkit project matches nav-drawer + site-search', /name: 'mobile-webkit'[\s\S]{0,300}testMatch: \/\(nav-drawer\|site-search\)\\\.spec\\\.js\//.test(cfg));

console.log('\nPOSITIVE CONTROL');
{
  const old = '\n  public-e2e:\n    name: Public-surface E2E (hosting emulator)\n    steps:\n      - run: |\n          npx playwright install --with-deps chromium webkit\n  next:\n    name: Next\n';
  ok('the pre-2026-10-24 install line is flagged', /\bwebkit\b/.test(installs(job('public-e2e', old)).join(' ')));
  ok('the job slice stops at the next job', !job('public-e2e', old).includes('name: Next'));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
