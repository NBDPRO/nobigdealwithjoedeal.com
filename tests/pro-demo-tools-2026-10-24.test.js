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
 * Ready so far: AI Usage (analytics). The three AI tools and Daily Success
 * follow in their own PRs and are pinned as STILL hidden here until then.
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
ok('Success Tracker (nav-daily) stays hidden until its PR', ((/LIVE_ONLY_NAV = \[([^\]]*)\]/.exec(dm) || ['', ''])[1]).indexOf("'nav-daily'") !== -1);
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
