/**
 * tests/pro-demo-tools-2026-10-24.test.js
 *
 * The sample account's tool pages (Jo, 2026-10-24: "build something similar
 * for all the rest of the tools pages"). The dashboard embeds four tools as
 * iframes and opens Daily Success in a window; until now the sample account
 * hid all five, because they pointed at the REAL /pro/ pages (outside the demo
 * worker, refused by frame-ancestors, App Check). Each tool joins the sample
 * account when it has what it needs to run there. This file pins, per tool:
 *   - a /pro/explore/<tool> rewrite to the real page file, no shadowing file
 *   - the effective headers there: the sample account's own policy
 *     (connect-src 'self', no production hosts, noindex) and framing allowed
 *     ONLY by the sample account itself (frame-ancestors 'self', SAMEORIGIN)
 *   - the page loads demo-mode.js first (inert off /pro/explore/)
 *   - demo-mode points the dashboard's view at /pro/explore/<tool> and no
 *     longer hides its sidebar entry; tools not yet ready stay hidden
 *   - its sample data exists in the seed
 *
 * Ready so far: AI Usage (analytics, framed) and the Success Tracker
 * (daily-success, opened in a window; section E). The three AI tools follow in
 * their own PR and are pinned as STILL hidden here until then.
 *
 * Run: node tests/pro-demo-tools-2026-10-24.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { effectiveHeaders } = require('./lib/hosting-headers');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 300) : '')); }
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');
function directives(csp) {
  const out = {};
  for (const part of String(csp || '').split(';')) { const t = part.trim().split(/\s+/); if (t[0]) out[t[0].toLowerCase()] = t.slice(1); }
  return out;
}
const FORBIDDEN = /(?<!fonts\.)googleapis\.com|firebaseio\.com|cloudfunctions\.net|identitytoolkit|securetoken|firebaseapp\.com|firebasestorage|stripe\.com|twilio|sentry|google-analytics|googletagmanager|recaptcha|cloudflare|clarity|run\.app/i;

const hosting = JSON.parse(read('firebase.json')).hosting;
const dash = read('docs/pro/dashboard.html');
const dm = stripComments(read('docs/pro/js/demo-mode.js'));

// tool -> [real page file, dashboard view template, sidebar entry]
const READY = { analytics: ['analytics.html', 'tpl-view-aiusage', 'nav-aiusage'] };
const NOT_YET = { 'tpl-view-aitree': 'nav-aitree', 'tpl-view-understand': 'nav-understand', 'tpl-view-projectcodex': 'nav-projectcodex' };

console.log('A. routes and headers for each ready tool');
for (const [tool, [file]] of Object.entries(READY)) {
  const p = '/pro/explore/' + tool;
  const rw = (hosting.rewrites || []).find((r) => r.source === p);
  ok(p + ' rewrites to /pro/' + file, rw && rw.destination === '/pro/' + file, JSON.stringify(rw));
  ok('no file shadows ' + p, !fs.existsSync(path.join(DOCS, 'pro', 'explore', tool)) && !fs.existsSync(path.join(DOCS, 'pro', 'explore', tool + '.html')));
  const h = effectiveHeaders(hosting, p);
  for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
    const hit = h.get(key);
    const d = directives(hit && hit.value);
    ok(p + ' ' + key + ': connect-src is exactly \'self\'', d['connect-src'] && d['connect-src'].join(' ') === "'self'", hit && hit.value);
    ok(p + ' ' + key + ': names no production host', hit && !FORBIDDEN.test(hit.value), hit && (hit.value.match(FORBIDDEN) || [])[0]);
    ok(p + ' ' + key + ': framed only by the sample account itself (frame-ancestors \'self\')', d['frame-ancestors'] && d['frame-ancestors'].join(' ') === "'self'", d['frame-ancestors']);
    ok(p + ' ' + key + ': form-action and object-src stay \'none\'', d['form-action'] && d['form-action'].join(' ') === "'none'" && d['object-src'] && d['object-src'].join(' ') === "'none'");
    const demo = effectiveHeaders(hosting, '/pro/explore/dashboard').get(key);
    const strip = (v) => String(v || '').replace(/frame-ancestors[^;]*;?/, '').trim();
    ok(p + ' ' + key + ': otherwise identical to the sample dashboard\'s policy', hit && demo && strip(hit.value) === strip(demo.value));
  }
  ok(p + ': X-Frame-Options SAMEORIGIN', (h.get('x-frame-options') || {}).value === 'SAMEORIGIN', JSON.stringify(h.get('x-frame-options')));
  ok(p + ': noindex, no-store', /noindex/.test((h.get('x-robots-tag') || {}).value || '') && /no-store/.test((h.get('cache-control') || {}).value || ''));
}
ok('control: the sample dashboard itself still refuses to be framed', directives((effectiveHeaders(hosting, '/pro/explore/dashboard').get('content-security-policy') || {}).value)['frame-ancestors'].join(' ') === "'none'");
ok('control: a tool not yet in the sample account is not routed (/pro/explore/ai-tree)', !(hosting.rewrites || []).some((r) => r.source === '/pro/explore/ai-tree'));

console.log('B. each ready page loads demo-mode.js first');
for (const [tool, [file]] of Object.entries(READY)) {
  const html = read('docs/pro/' + file);
  const first = (/<script\b[^>]*\bsrc="([^"]+)"/.exec(html) || [])[1] || '';
  ok(file + ': its first script is demo-mode.js (before any SDK import or gate)', /^\/pro\/js\/demo-mode\.js\?v=\d+$/.test(first), first);
  ok(file + ': and demo-mode.js loads as a classic, non-deferred script', /<script src="\/pro\/js\/demo-mode\.js\?v=\d+"><\/script>/.test(html));
}

console.log('C. demo-mode routes ready tools in, keeps the rest hidden');
const toolsMap = (/SANDBOX_TOOLS = (\{[^}]*\})/.exec(dm) || [])[1];
let TOOLS = null;
try { TOOLS = vm.runInNewContext('(' + toolsMap + ')'); } catch (_) {}
ok('demo-mode has a SANDBOX_TOOLS table', !!TOOLS, toolsMap);
for (const [tool, [, tpl, nav]] of Object.entries(READY)) {
  ok(tpl + ' -> /pro/explore/' + tool, TOOLS && TOOLS[tpl] === '/pro/explore/' + tool, TOOLS && TOOLS[tpl]);
  const tplHtml = (new RegExp('<template id="' + tpl + '">[\\s\\S]*?</template>').exec(dash) || [''])[0];
  ok('control: ' + tpl + ' exists with an iframe data-src on the real page', /<iframe[^>]*data-src="\/pro\//.test(tplHtml));
  const navs = (/LIVE_ONLY_NAV = \[([^\]]*)\]/.exec(dm) || ['', ''])[1];
  ok(nav + ' is no longer hidden in the sample account', navs.indexOf("'" + nav + "'") === -1);
}
for (const [tpl, nav] of Object.entries(NOT_YET)) {
  const tpls = (/LIVE_ONLY_TPL = \[([^\]]*)\]/.exec(dm) || ['', ''])[1];
  const navs = (/LIVE_ONLY_NAV = \[([^\]]*)\]/.exec(dm) || ['', ''])[1];
  ok(tpl + ' / ' + nav + ' stay hidden until their own PR', tpls.indexOf("'" + tpl + "'") !== -1 && navs.indexOf("'" + nav + "'") !== -1 && !(TOOLS && TOOLS[tpl]));
}
ok('a framed tool does not mount a second Sample account strip', /window\.top !== window|window\.self !== window\.top|self !== top/.test(dm) && /FRAMED/.test(dm));

console.log('D. sample data');
const seed = JSON.parse(read('docs/pro/demo-sdk/sample-company.json'));
const UID = seed.user.uid;
const usage = Object.entries(seed.docs).filter(([k]) => /^api_usage\//.test(k)).map(([, v]) => v);
const pricing = read('docs/pro/js/pages/pro-analytics.js');
ok('seed version bumped to 5 (saved sample accounts reload the new data)', seed.version >= 5, seed.version);
ok('a month of AI usage for the sample owner (>= 40 records)', usage.length >= 40, usage.length);
ok('every record is the owner\'s, sample-flagged, with a model the page prices, a feature and tokens',
  usage.length > 0 && usage.every((u) => u.uid === UID && u.companyId === UID && u.isSample === true && pricing.indexOf("'" + u.model + "'") !== -1 && /^[a-z-]+$/.test(u.feature) && u.inputTokens > 0 && u.outputTokens > 0));
ok('timestamps are relative and inside the last 30 days', usage.length > 0 && usage.every((u) => u.timestamp && u.timestamp.__ts && u.timestamp.__ts.days <= 0 && u.timestamp.__ts.days >= -30));
ok('some usage is from the last 7 days and today (the range buttons all show data)', usage.some((u) => u.timestamp.__ts.days >= -7) && usage.some((u) => u.timestamp.__ts.days === 0));
ok('several features and both models appear', new Set(usage.map((u) => u.feature)).size >= 4 && new Set(usage.map((u) => u.model)).size >= 2);
ok('the seed file is current (build-demo-seed --check)', require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-demo-seed.js'), '--check']).status === 0);

console.log('E. Success Tracker (/pro/explore/daily-success)');
{
  const p = '/pro/explore/daily-success';
  const rw = (hosting.rewrites || []).find((r) => r.source === p);
  ok(p + ' rewrites to the tracker page file', rw && rw.destination === '/pro/daily-success/index.html', JSON.stringify(rw));
  ok('no file shadows ' + p, !fs.existsSync(path.join(DOCS, 'pro', 'explore', 'daily-success')));
  const h = effectiveHeaders(hosting, p);
  const d = directives((h.get('content-security-policy') || {}).value);
  ok(p + ': the sample account\'s own policy (connect-src \'self\', no production host)', d['connect-src'] && d['connect-src'].join(' ') === "'self'" && !FORBIDDEN.test((h.get('content-security-policy') || {}).value));
  ok(p + ': opened in a window, never framed (frame-ancestors \'none\')', d['frame-ancestors'] && d['frame-ancestors'].join(' ') === "'none'", d['frame-ancestors']);
  ok(p + ': noindex', /noindex/.test((h.get('x-robots-tag') || {}).value || ''));
  const html = read('docs/pro/daily-success/index.html');
  const first = (/<script\b[^>]*\bsrc="([^"]+)"/.exec(html) || [])[1] || '';
  ok('daily-success/index.html: its first script is demo-mode.js, classic and non-deferred', /^\/pro\/js\/demo-mode\.js\?v=\d+$/.test(first) && /<script src="\/pro\/js\/demo-mode\.js\?v=\d+"><\/script>/.test(html), first);
  // Every asset the page loads must be absolute: under /pro/explore/ a relative one would resolve to a path that does not exist.
  const rel = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(\/|https:|data:|#)/.test(u));
  ok('daily-success/index.html: every script and stylesheet path is absolute', rel.length === 0, rel.join(', '));
  const navs = (/LIVE_ONLY_NAV = \[([^\]]*)\]/.exec(dm) || ['', ''])[1];
  ok('nav-daily is no longer hidden in the sample account', navs.indexOf("'nav-daily'") === -1);
  ok('control: the dashboard\'s Success Tracker entry opens /pro/daily-success/ in a window', /data-action="windowOpen" data-target="\/pro\/daily-success\/" id="nav-daily"/.test(dash));
  // remap() and the window.open wrapper (the walk opens it for real: step 26).
  ok('remap() sends /pro/daily-success, /pro/daily-success/ and /index.html to /pro/explore/daily-success',
    /\/\^\\\/pro\\\/daily-success\(\\\/\(index\\\.html\)\?\)\?\$\/\.test\(p\)\) return PREFIX \+ 'daily-success'/.test(dm));
  ok('window.open goes through remap() too (the entry opens a window, not a link)', /window\.open = function \(url\) \{[\s\S]{0,200}remap\(String\(url\)\)/.test(dm));
  ok('demo-mode marks the tracker\'s first-visit welcome as seen there (it promises a real-account backup)', /explore\\\/daily-success[^\n]*localStorage\.setItem\('nbd-welcome-seen'/.test(dm));
  // Live services: food search stays in the real account, the Apple Health card stays dark (as it is in production until Jo turns it on).
  ok('food search (Open Food Facts) is answered by offline.js, never fetched', /OFFLINE = [^\n]*world\\\.openfoodfacts\\\.org/.test(dm) && /world\\\.openfoodfacts\\\.org[\s\S]{0,400}in your real account/.test(read('docs/pro/demo-sdk/offline.js')));
  ok('control: food search really does fetch world.openfoodfacts.org', /https:\/\/world\.openfoodfacts\.org/.test(read('docs/pro/daily-success/js/food-search-logic.js')));
  ok('healthShortcutManage refuses quietly (no notice; the card stays hidden)', /const QUIET = new Set\(\[[^\]]*'healthShortcutManage'/.test(read('docs/pro/demo-sdk/firebase-functions.js')));
  // The sample week.
  const pages = Object.entries(seed.docs).filter(([k]) => k.indexOf('users/' + UID + '/ds_pages/') === 0).map(([k, v]) => [k.split('/').pop(), v]);
  ok('seed version bumped to 6 for the sample week', seed.version >= 6, seed.version);
  ok('six sample day pages for the owner', pages.length === 6, pages.length);
  ok('each page: doc id = its id, a relative date, mkPage()\'s shape, sample-flagged',
    pages.length > 0 && pages.every(([id, v]) => v.id === id && v.dk && v.dk.__date && v.suf === 1 && v.isSample === true && v.data && v.kpi && Array.isArray(v.exercises) && Array.isArray(v.objections) && Array.isArray(v.commissions)));
  const days = pages.map(([, v]) => v.dk.__date.days).sort((a, b) => a - b);
  ok('the last six days, today left blank for the visitor', JSON.stringify(days) === JSON.stringify([-6, -5, -4, -3, -2, -1]), days.join(','));
  ok('every day has a logged workout, meals and door numbers', pages.every(([, v]) => v.exercises.some((e) => e.name) && v.data['diet-m0-name'] && v.kpi.doors > 0));
  const full = (v) => ['qs1', 'qs2', 'qs3', 'qs4', 'qs5'].every((f) => v.data['floormet-' + f] === '1');
  ok('a five-day floor streak behind today (not a perfect week)', pages.filter(([, v]) => full(v)).length === 5 && !full((pages.find(([, v]) => v.dk.__date.days === -6) || [])[1]));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
